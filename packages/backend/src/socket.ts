import { Server, Socket } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import http from 'http';
import { getRedisClient, getRedisSubClient } from './lib/redis.js';
import { log } from './lib/logger.js';
import { oxyClient } from './middleware/auth.js';

/** Authenticated user context attached by oxyClient.authSocket() */
interface AuthenticatedUser {
  id: string;
  userId: string;
  sessionId?: string | null;
}

/** Socket.IO Socket augmented with auth user */
type AuthenticatedSocket = Socket & { user?: AuthenticatedUser };

const ALLOWED_ORIGINS = [
  process.env.WEB_URL || 'http://localhost:3000',
  'https://clarity.oxy.so',
  'https://console.clarity.oxy.so',
  'https://gateway.clarity.oxy.so',
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
    Promise.all([pubClient.connect(), subClient.connect()])
      .then(() => {
        io!.adapter(createAdapter(pubClient, subClient));
        log.general.info('Socket.IO Redis adapter attached');
      })
      .catch((err) => {
        log.general.warn({ err }, 'Socket.IO Redis adapter failed — using in-memory');
      });
  }

  // Require valid Oxy JWT for all socket connections.
  // Sets socket.user = { id, userId, sessionId } on the socket before 'connection' fires.
  io.use(oxyClient.authSocket());

  io.on('connection', (rawSocket) => {
    const socket = rawSocket as AuthenticatedSocket;

    // subscribe-telegram-token: short-lived linking token — requires auth for consistency
    socket.on('subscribe-telegram-token', (token: string) => {
      if (!socket.user?.id) return;
      if (typeof token !== 'string' || token.length > 256) return;
      socket.join(`telegram-token:${token}`);
    });

    // subscribe-workflow: authenticated sockets only; no additional ownership check
    // (workflow IDs are server-generated UUIDs — no practical guessability risk)
    socket.on('subscribe-workflow', (executionId: string) => {
      if (!socket.user?.id) return;
      if (typeof executionId !== 'string' || executionId.length > 256) return;
      socket.join(`workflow:${executionId}`);
    });

    // subscribe-canvas: authenticated sockets only
    socket.on('subscribe-canvas', (conversationId: string) => {
      if (!socket.user?.id) return;
      if (typeof conversationId !== 'string' || conversationId.length > 256) return;
      socket.join(`canvas:${conversationId}`);
    });

    // subscribe-agent: authenticated sockets only
    socket.on('subscribe-agent', (agentId: string) => {
      if (!socket.user?.id) return;
      if (typeof agentId !== 'string' || agentId.length > 256) return;
      socket.join(`agent:${agentId}`);
    });

    // subscribe-agent-session: authenticated sockets only
    socket.on('subscribe-agent-session', (sessionId: string) => {
      if (!socket.user?.id) return;
      if (typeof sessionId !== 'string' || sessionId.length > 256) return;
      socket.join(`agent-session:${sessionId}`);
    });

    // subscribe-notifications: derive room from the authenticated user — ignore client-supplied userId
    socket.on('subscribe-notifications', (_userId: string) => {
      if (!socket.user?.id) return;
      socket.join(`user:${socket.user.id}`);
    });

    // Agent action approval response from user
    socket.on('agent-approval-response', async (data: { requestId: string; sessionId: string; approved: boolean; alwaysAllow?: boolean }) => {
      if (!socket.user?.id) return;
      if (!data?.requestId || typeof data.sessionId !== 'string') return;

      // Mirror to the session room for real-time client updates.
      io!.to(`agent-session:${data.sessionId}`).emit('agent-approval-decision', {
        requestId: data.requestId,
        approved: data.approved,
        alwaysAllow: data.alwaysAllow || false,
      });
    });
  });
  return io;
}

export function getIO(): Server | null {
  return io;
}

export function emitTelegramLinked(token: string, data: any) {
  if (io) {
    io.to(`telegram-token:${token}`).emit('telegram-linked', data);
  }
}

export function emitCanvasUpdate(conversationId: string, component: any) {
  if (io) {
    io.to(`canvas:${conversationId}`).emit('canvas-update', { conversationId, component });
  }
}

export function emitWorkflowProgress(executionId: string, data: any) {
  if (io) {
    io.to(`workflow:${executionId}`).emit('workflow-progress', { executionId, ...data });
  }
}

export interface AgentActivityEvent {
  type: 'system' | 'thinking' | 'response' | 'tool_call' | 'tool_result' | 'error' | 'complete' | 'screenshot' | 'plan_progress' | 'file_change' | 'source_found' | 'threat' | 'approval_request';
  content: string;
  timestamp: number;
  sessionId: string;
  metadata?: { toolName?: string; args?: any; duration?: number; url?: string; title?: string; domain?: string; threatSeverity?: string; threatCategory?: string };
  data?: {
    base64?: string;
    url?: string;
    plan?: { items: Array<{ id: number; text: string; status: string }>; completed: number; total: number };
    files?: string[];
    currentStep?: number;
    maxSteps?: number;
    approval?: { requestId: string; toolName: string; args: any; description: string; severity: string; timeout: number };
    taskProgress?: {
      stepIndex: number;
      maxSteps: number;
      totalTokens: number;
      state: string;
      planCompleted: number;
      planTotal: number;
      elapsedMs: number;
      lastAction: string | null;
    };
  };
}

export function emitApprovalRequest(sessionId: string, data: {
  eventVersion?: number;
  requestId: string;
  agentId: string;
  toolName: string;
  args: any;
  description: string;
  severity: string;
  timeout: number;
}) {
  if (io) {
    const payload = {
      eventVersion: data.eventVersion ?? 1,
      ...data,
    };
    io.to(`agent-session:${sessionId}`).emit('agent-approval-request', payload);
    io.to(`agent-session:${sessionId}`).emit('clarity.approval_request', payload);
  }
}

export function emitApprovalResult(sessionId: string, data: {
  eventVersion?: number;
  requestId: string;
  decision: 'approved' | 'denied' | 'timeout';
}) {
  if (io) {
    const payload = {
      eventVersion: data.eventVersion ?? 1,
      ...data,
    };
    io.to(`agent-session:${sessionId}`).emit('agent-approval-result', payload);
    io.to(`agent-session:${sessionId}`).emit('clarity.approval_result', payload);
  }
}

export interface AudioJobUpdate {
  jobId: string;
  status: 'completed' | 'failed';
  audioUrl?: string;
  error?: string;
}

export function emitAudioJobUpdate(userId: string, data: AudioJobUpdate) {
  if (io) {
    io.to(`user:${userId}`).emit('audio:job-update', data);
  }
}

export function emitAgentActivity(agentId: string, data: AgentActivityEvent) {
  if (io) {
    io.to(`agent:${agentId}`).emit('agent-activity', { agentId, ...data });
    // Also emit to session-specific room for task card subscribers
    if (data.sessionId) {
      io.to(`agent-session:${data.sessionId}`).emit('agent-activity', { agentId, ...data });
    }
  }
}
