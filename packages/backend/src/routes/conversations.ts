import { Router } from 'express';
import { randomUUID } from 'crypto';
import { authenticateToken } from '../middleware/auth.js';
import type { Request, Response } from 'express';
import { log } from '../lib/logger.js';
import {
  createConversation,
  deleteConversation,
  findConversation,
  listConversations,
  listMessages,
  replaceConversation,
  toWritableMessage,
  voteMessage,
  type WritableMessage,
} from '../db/chat-repository.js';

const router = Router();

function routeParam(req: Request, key: string): string {
  const value = req.params[key];
  return Array.isArray(value) ? value[0] : value;
}

// Create a new empty conversation
router.post('/new', authenticateToken, async (req: Request, res: Response) => {
  try {
    if (!req.user?.id) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const conversationId = randomUUID();

    const conversation = await createConversation({
      oxyUserId: req.user.id,
      conversationId,
      title: 'New chat',
      source: 'app',
    });

    res.json({
      id: conversation.conversationId,
      title: conversation.title,
      source: conversation.source,
      createdAt: conversation.createdAt,
      updatedAt: conversation.updatedAt
    });
  } catch (error: unknown) {
    log.chat.error({ err: error }, 'Error creating conversation');
    res.status(500).json({ error: 'Failed to create conversation' });
  }
});

// Get all conversations for the authenticated user with cursor-based pagination
router.get('/', authenticateToken, async (req: Request, res: Response) => {
  try {
    if (!req.user?.id) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // Pagination parameters
    const limit = Math.min(parseInt(req.query.limit as string) || 20, 50); // Max 50 per request
    const cursor = req.query.cursor as string | undefined; // ISO date string

    const conversations = await listConversations(
      req.user.id,
      limit + 1,
      cursor ? new Date(cursor) : undefined,
    );

    // Check if there are more results
    const hasMore = conversations.length > limit;
    const results = hasMore ? conversations.slice(0, limit) : conversations;

    // Next cursor is the updatedAt of the last conversation
    const nextCursor = hasMore && results.length > 0
      ? results[results.length - 1].updatedAt.toISOString()
      : null;

    res.json({
      conversations: results.map(c => ({
        id: c.conversationId,
        title: c.title,
        lastMessage: c.lastMessage,
        source: c.source || 'app',
        createdAt: c.createdAt,
        updatedAt: c.updatedAt
      })),
      nextCursor,
      hasMore
    });
  } catch (error: unknown) {
    log.chat.error({ err: error }, 'Error fetching conversations');
    res.status(500).json({ error: 'Failed to fetch conversations' });
  }
});

// Get a specific conversation by ID
router.get('/:id', authenticateToken, async (req: Request, res: Response) => {
  try {
    if (!req.user?.id) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const conversationId = routeParam(req, 'id');
    const conversation = await findConversation(req.user.id, conversationId);

    if (!conversation) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    // Load messages from separate collection
    const storedMessages = await listMessages(req.user.id, conversationId);

    res.json({
      id: conversation.conversationId,
      title: conversation.title,
      lastMessage: conversation.lastMessage,
      source: conversation.source || 'app',
      messages: storedMessages.map((message) => ({
        id: message.messageId ?? message.id,
        role: message.role,
        content: message.content,
        ...(message.vote ? { vote: message.vote } : {}),
        toolInvocations: message.toolInvocations,
        ...(message.audioUrl ? { audioUrl: message.audioUrl } : {}),
        createdAt: message.createdAt,
      })),
      createdAt: conversation.createdAt,
      updatedAt: conversation.updatedAt
    });
  } catch (error: unknown) {
    log.chat.error({ err: error }, 'Error fetching conversation');
    res.status(500).json({ error: 'Failed to fetch conversation' });
  }
});

// Save or update a conversation
router.post('/', authenticateToken, async (req: Request, res: Response) => {
  try {
    if (!req.user?.id) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { conversationId, title, messages } = req.body as Record<string, unknown>;

    if (
      typeof conversationId !== 'string'
      || conversationId.length === 0
      || conversationId.length > 128
      || !Array.isArray(messages)
      || messages.length > 100
      || (title !== undefined && (typeof title !== 'string' || title.length > 500))
    ) {
      return res.status(400).json({ error: 'Invalid request body' });
    }

    const validMessages = messages.flatMap((message): WritableMessage[] => {
      const writable = toWritableMessage(message);
      return writable ? [writable] : [];
    });
    if (validMessages.length !== messages.length) {
      return res.status(400).json({ error: 'Invalid conversation message' });
    }

    // Generate lastMessage from the last valid message
    const lastContent = validMessages.at(-1)?.content;
    const lastMessage = typeof lastContent === 'string' ? lastContent.slice(0, 100) : undefined;

    const firstUserContent = validMessages.find((message) => message.role === 'user')?.content;
    const conversation = await replaceConversation({
      oxyUserId: req.user.id,
      conversationId,
      ...(typeof title === 'string' && title.length > 0 ? { title } : {}),
      titleOnInsert: typeof firstUserContent === 'string'
        ? firstUserContent.slice(0, 50)
        : 'New chat',
      ...(lastMessage === undefined ? {} : { lastMessage }),
      source: 'app',
      messages: validMessages,
    });

    res.json({
      id: conversation.conversationId,
      title: conversation.title,
      lastMessage: conversation.lastMessage,
      source: conversation.source || 'app',
      createdAt: conversation.createdAt,
      updatedAt: conversation.updatedAt
    });
  } catch (error: unknown) {
    log.chat.error({ err: error }, 'Error saving conversation');
    res.status(500).json({ error: 'Failed to save conversation' });
  }
});

// Vote on a message (thumbs up/down)
router.patch('/:id/messages/:messageId/vote', authenticateToken, async (req: Request, res: Response) => {
  try {
    if (!req.user?.id) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { vote } = req.body;
    if (vote !== 'up' && vote !== 'down' && vote !== null) {
      return res.status(400).json({ error: 'vote must be "up", "down", or null' });
    }

    const updated = await voteMessage(
      req.user.id,
      routeParam(req, 'id'),
      routeParam(req, 'messageId'),
      vote,
    );

    if (!updated) {
      return res.status(404).json({ error: 'Message not found' });
    }

    res.json({ success: true, vote });
  } catch (error: unknown) {
    log.chat.error({ err: error }, 'Error voting on message');
    res.status(500).json({ error: 'Failed to vote on message' });
  }
});

// Delete a conversation
router.delete('/:id', authenticateToken, async (req: Request, res: Response) => {
  try {
    if (!req.user?.id) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const deleted = await deleteConversation(req.user.id, routeParam(req, 'id'));

    if (!deleted) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    res.json({ success: true });
  } catch (error: unknown) {
    log.chat.error({ err: error }, 'Error deleting conversation');
    res.status(500).json({ error: 'Failed to delete conversation' });
  }
});

export default router;
