import express from 'express';
import { startPlatformActivity } from './lib/platform-activity.js';
import http from 'node:http';
import cors from 'cors';
import { createOxyCors, createOxySecurityHeaders, oxyTrustProxy } from '@oxy.so/core/server';
import { CLARITY_APP_ORIGINS, EXPERIENCE_APP_ORIGINS } from './lib/app-origins.js';
import { closePostgres, connectPostgres } from './db/index.js';
import { log } from './lib/logger.js';
import {
  clientErrorStatus,
  isAbortError,
  isFatalError,
  isTransientNetworkError,
} from './lib/error-classification.js';
import { requireRuntimeReady } from './middleware/runtime-ready.js';
import { createCapabilityLanes, mountCapabilityLanes } from './capabilities/mount.js';

// Routes
import healthRouter from './routes/health.js';
import faviconsRouter from './routes/favicons.js';
import imagesRouter from './routes/images.js';
import v1Router from './routes/v1.js';
import billingRouter from './routes/billing.js';
import feedbackRouter from './routes/feedback.js';
import suggestionsRouter from './routes/suggestions.js';
import notificationsRouter from './routes/notifications.js';
import oxyAccountEventsRouter from './routes/oxy-account-events.js';
import oxyFileEventsRouter from './routes/oxy-file-events.js';
import { flushLegacyReads } from './files/legacy-reads.js';
import experienceRouter from './routes/experience.js';
import jobsRouter from './routes/jobs.js';
import marketRouter from './routes/market.js';
import productsRouter from './routes/products.js';
import newsRouter from './routes/news.js';
// Socket.io
import { initSocket } from './socket.js';

// Bun loads `.env` from the working directory before any module runs; the
// package scripts (`bun run dev`, `bun run start`) run from packages/backend,
// so that is packages/backend/.env, the file dotenv used to be pointed at.

const app = express();
// `req.ip` is the real client: the ALB is trusted as the socket peer, and the
// hop it recorded only when that hop is a Cloudflare edge (a proxied hostname).
// A caller's own X-Forwarded-For entries are never believed. Set before any
// middleware, since every anonymous rate limit keys on `req.ip`.
app.set('trust proxy', oxyTrustProxy);
const PORT = parseInt(process.env.PORT || '3001', 10);

// Create HTTP server with optimized settings for streaming
const server = http.createServer(
  {
    // Increase max header size for long authentication tokens
    maxHeaderSize: 16384,
    // Keep connections alive for SSE
    keepAlive: true,
    keepAliveTimeout: 65000, // Slightly higher than default
  },
  app,
);
const activity = startPlatformActivity(() => server.listening);
if (activity) app.use(activity.observeHttp);

// Handle HTTP server errors (e.g. EADDRINUSE)
server.on('error', (error: NodeJS.ErrnoException) => {
  log.general.error({ err: error }, '[Server] HTTP server error');
  if (error.code === 'EADDRINUSE') {
    log.general.error({ port: PORT }, 'Port already in use');
    process.exit(1);
  }
});

// Optimize server for SSE streaming
server.on('connection', (socket) => {
  // Disable Nagle's algorithm for all connections to reduce latency
  socket.setNoDelay(true);
  // Set keep-alive
  socket.setKeepAlive(true, 60000);
});

initSocket(server).on('connection', (socket) => activity?.observeSocket(socket));

/**
 * The capability catalogue's two MCP lanes — `/_oxy/mcp` (Alia, capability
 * tickets, host `api.clarity.surf`) and `/mcp` (OAuth clients, host
 * `mcp.clarity.surf`). FIRST, above CORS, the body parsers and runtime
 * readiness: each lane owns its raw body, its host check and its auth
 * challenge (`capabilities/mount.ts`).
 */
const capabilityLanes = createCapabilityLanes();
mountCapabilityLanes(app, capabilityLanes);

// Headers only (HSTS, nosniff, frame and opener policy, a baseline CSP for any
// document). Images and favicons are embedded by other origins, so the
// resource policy is cross-origin.
app.use(
  createOxySecurityHeaders({ helmet: { crossOriginResourcePolicy: { policy: 'cross-origin' } } }),
);

// Public API routes (/v1) use the documented cross-origin API contract: any
// origin, never credentials (a bearer is not a cookie). `createOxyCors` never
// answers a wildcard by design, so this one surface keeps its own.
app.use(
  '/v1',
  cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-Requested-With',
      'Accept',
      'Origin',
      'X-Service-Name',
      'X-Timestamp',
      'X-Signature',
      'X-Session-Id',
      'X-Device-Info',
      'X-Oxy-Edge-Region',
      'X-Oxy-Activity-Id',
    ],
    optionsSuccessStatus: 200,
  }),
);

// Disable nginx/proxy buffering for /v1 SSE streaming responses
app.use('/v1', (_req, res, next) => {
  res.setHeader('X-Accel-Buffering', 'no');
  next();
});

// Public profile reads and user-authorized profile edits from Mention.
app.use('/api/experience', createOxyCors({ appOrigins: EXPERIENCE_APP_ORIGINS }));

// Account deletion authenticates the signed event itself, independently of runtime readiness.
app.use('/webhooks/oxy/account-events', oxyAccountEventsRouter);
// Oxy's file events (ADR 0043 D9): the signature is over the raw body, so this
// is mounted before `express.json()`, like the account events above.
app.use('/webhooks/oxy/files', oxyFileEventsRouter);

// Every other route admits Clarity's own web app (and the Oxy origin family).
const appCors = createOxyCors({ appOrigins: CLARITY_APP_ORIGINS });
app.use((req, res, next) => {
  if (req.path.startsWith('/v1') || req.path.startsWith('/api/experience')) return next();
  appCors(req, res, next);
});

// Stripe webhook needs raw body for signature verification
app.use('/billing/webhook', express.raw({ type: 'application/json' }));

// JSON bodies. The credentialed /v1 surface takes up to 10 MB — job postings
// (JSON-LD), resolve batches, product writes. Everything else, most of it open
// to anonymous callers, takes 1 MB: a body is parsed synchronously before any
// route or auth runs, and 10 MB of JSON holds a 0.5-vCPU task for a while.
// A body the /v1 parser read is not parsed again by the global one.
app.use('/v1', express.json({ limit: '10mb' }));
app.use('/v1', express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// Routes
app.use('/health', healthRouter);
// Keep every product/data route closed until the exact PostgreSQL snapshot has
// been attested and this process can attest its own Oxy service identity.
app.use(requireRuntimeReady);
app.use('/v1', v1Router);
app.use('/favicons', faviconsRouter);
app.use('/images', imagesRouter);
app.use('/billing', billingRouter);
app.use('/feedback', feedbackRouter);
app.use('/suggestions', suggestionsRouter);
app.use('/notifications', notificationsRouter);
app.use('/jobs', jobsRouter);
app.use('/api/experience', experienceRouter);
app.use('/market', marketRouter);
app.use('/news', newsRouter);
app.use('/products', productsRouter);

// Root route
app.get('/', (_req, res) => {
  res.json({
    message: 'Clarity API',
    version: '1.0.0',
    endpoints: [
      '/health',
      '/v1',
      '/billing',
      '/feedback',
      '/suggestions',
      '/notifications',
      '/jobs',
      '/market',
      '/news',
      '/products',
      '/api/experience',
      '/_oxy/mcp',
    ],
  });
});

// Error handler
app.use(
  (err: unknown, req: express.Request, res: express.Response, _next: express.NextFunction) => {
    // A client error raised by middleware (a malformed or oversized body) keeps
    // its own status; only what is left is the server's fault.
    const status = clientErrorStatus(err);
    if (status) {
      if (!res.headersSent) res.status(status).json({ error: (err as Error).message });
      return;
    }
    log.general.error({ err, method: req.method, path: req.path }, 'Unhandled Express error');
    if (!res.headersSent) {
      res.status(500).json({ error: 'Something went wrong!' });
    }
  },
);

// Process-level error handlers — prevent crashes from taking down all users
// Classifies errors to determine logging level (inspired by openclaw)
process.on('unhandledRejection', (reason) => {
  // AbortError: intentional cancellation (user stopped request) — suppress
  if (isAbortError(reason)) return;

  // Fatal: OOM, worker failures — must exit
  if (isFatalError(reason)) {
    log.general.error({ err: reason }, '[Process] FATAL unhandled rejection — shutting down');
    setTimeout(() => process.exit(1), 5000).unref();
    return;
  }

  // Transient network: ECONNRESET, ETIMEDOUT, etc. — expected with external services
  if (isTransientNetworkError(reason)) {
    log.general.warn({ err: reason }, '[Process] Transient network error (continuing)');
    return;
  }

  // Everything else: log as error but keep running
  log.general.error(
    { reason: reason instanceof Error ? reason : String(reason) },
    '[Process] Unhandled promise rejection',
  );
});

process.on('uncaughtException', (error) => {
  log.general.error({ err: error }, '[Process] Uncaught exception — shutting down');
  setTimeout(() => process.exit(1), 5000).unref();
});

const database = connectPostgres(process.env.DATABASE_URL);
if (!database) {
  log.general.error('DATABASE_URL is required');
  process.exit(1);
} else {
  Promise.resolve()
    .then(() => {
      server.listen(PORT, '0.0.0.0', () => {
        log.general.info({ port: PORT }, `API Server running on http://0.0.0.0:${PORT}`);
        // Register the capability catalogue now, so a refusal is in the log
        // the moment the task starts. A failure leaves `/_oxy/mcp` answering
        // 503 and retrying.
        void capabilityLanes.internal.bound();
        // Verify Redis connectivity (non-blocking)
        import('./lib/redis.js').then(({ getRedisClient }) => {
          const redis = getRedisClient();
          if (redis) {
            redis
              .ping()
              .then(() => log.general.info('Redis readiness check passed'))
              .catch((err) =>
                log.general.warn(
                  { err },
                  'Redis readiness check failed — rate-limited routes answer errors until it returns',
                ),
              );
          } else {
            log.general.info(
              'Redis not configured (REDIS_URL not set) — rate limits count per task',
            );
          }
        });
      });

      // Legacy image reads (files/legacy-reads.ts) are counted in memory and
      // written once a minute, and once more on shutdown.
      const legacyReadFlush = setInterval(() => {
        flushLegacyReads().catch((err) =>
          log.general.warn({ err }, 'Legacy image read counts could not be written yet'),
        );
      }, 60_000);
      legacyReadFlush.unref();

      // Graceful shutdown handler
      let shuttingDown = false;
      const shutdown = async (signal: string) => {
        if (shuttingDown) return;
        shuttingDown = true;
        log.general.info(`Received ${signal}. Starting graceful shutdown...`);

        // Stop accepting new connections
        server.close(() => {
          log.general.info('HTTP server closed (no new connections)');
        });

        // Give in-flight requests 30 seconds to complete
        const forceTimeout = setTimeout(() => {
          log.general.error('Force exit after 30s grace period');
          process.exit(1);
        }, 30_000);
        forceTimeout.unref();

        try {
          // Close Socket.IO connections
          const { getIO } = await import('./socket.js');
          const io = getIO();
          if (io) {
            await new Promise<void>((resolve) => io.close(() => resolve()));
            log.general.info('Socket.IO closed');
          }

          // Close Redis connections
          const { closeRedis } = await import('./lib/redis.js');
          await closeRedis();
          log.general.info('Redis connections closed');

          await activity?.stop();
          clearInterval(legacyReadFlush);
          await flushLegacyReads().catch((err) =>
            log.general.warn({ err }, 'Legacy image read counts lost at shutdown'),
          );
          await closePostgres();
          log.general.info('PostgreSQL connection closed');

          clearTimeout(forceTimeout);
          log.general.info('Graceful shutdown complete');
          process.exit(0);
        } catch (error) {
          log.general.error({ err: error }, 'Error during shutdown');
          process.exit(1);
        }
      };

      process.on('SIGTERM', () => shutdown('SIGTERM'));
      process.on('SIGINT', () => shutdown('SIGINT'));
    })
    .catch((error) => {
      log.general.error({ err: error }, 'Failed to start Clarity with PostgreSQL');
      process.exit(1);
    });
}
