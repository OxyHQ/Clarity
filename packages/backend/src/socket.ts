import { Server, Socket } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import http from 'http';
import { getRedisClient, getRedisSubClient } from './lib/redis.js';
import { log } from './lib/logger.js';
import { oxyClient } from './middleware/auth.js';
import { getRuntimeReadiness } from './db/runtime-readiness.js';

/** Socket.IO Socket augmented with auth user */
type AuthenticatedSocket = Socket & { user?: { id: string } };

const ALLOWED_ORIGINS = [
  process.env.WEB_URL || 'http://localhost:3000',
  'https://clarity.surf',
];

let io: Server | null = null;

export function initSocket(server: http.Server) {
  io = new Server(server, {
    cors: {
      origin: ALLOWED_ORIGINS,
      methods: ['GET', 'POST'],
      credentials: true,
    },
    transports: ['websocket', 'polling'],
  });

  // Attach Redis adapter for horizontal scaling
  const pubClient = getRedisClient();
  const subClient = getRedisSubClient();
  if (pubClient && subClient) {
    const socketServer = io;
    Promise.all([pubClient.connect(), subClient.connect()])
      .then(() => {
        socketServer.adapter(createAdapter(pubClient, subClient));
        log.general.info('Socket.IO Redis adapter attached');
      })
      .catch((err) => {
        log.general.warn({ err }, 'Socket.IO Redis adapter failed — using in-memory');
      });
  }

  // Direct socket connections cannot bypass the HTTP cutover gate.
  io.use(async (_socket, next) => {
    const readiness = await getRuntimeReadiness();
    next(readiness.ready ? undefined : new Error('Clarity runtime is not ready'));
  });

  // Require valid Oxy JWT for all socket connections.
  // Sets socket.user = { id, userId, sessionId } on the socket before 'connection' fires.
  io.use(oxyClient.authSocket());

  io.on('connection', (rawSocket) => {
    const socket = rawSocket as AuthenticatedSocket;

    // subscribe-notifications: derive room from the authenticated user — ignore client-supplied userId
    socket.on('subscribe-notifications', (_userId: string) => {
      if (!socket.user?.id) return;
      socket.join(`user:${socket.user.id}`);
    });
  });
  return io;
}

export function getIO(): Server | null {
  return io;
}
