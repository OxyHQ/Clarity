import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import { authenticateToken } from '../middleware/auth.js';
import { log } from '../lib/logger.js';
import { getDb } from '../db/index.js';
import { feedback as feedbackTable } from '../db/schema/index.js';

const router = Router();

// All feedback routes require authentication
router.use(authenticateToken);

/**
 * POST /feedback
 * Submit new feedback
 */
router.post('/', async (req, res) => {
  try {
    if (!req.user?.id) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    const { type, rating, message, email, metadata } = req.body;

    if (!type || !message) {
      res.status(400).json({ error: 'Type and message are required' });
      return;
    }

    const validTypes = ['bug', 'feature', 'improvement', 'other'];
    if (!validTypes.includes(type)) {
      res.status(400).json({ error: 'Invalid feedback type' });
      return;
    }

    if (rating !== undefined && (rating < 1 || rating > 5)) {
      res.status(400).json({ error: 'Rating must be between 1 and 5' });
      return;
    }

    const [feedback] = await getDb().insert(feedbackTable).values({
      id: randomUUID(),
      oxyUserId: req.user.id,
      type,
      rating: rating ?? null,
      message,
      email: email ?? null,
      metadata: metadata ?? null,
      status: 'pending',
    }).returning();
    if (!feedback) throw new Error('feedback insert returned no row');

    res.status(201).json({
      success: true,
      feedback: {
        id: feedback.id,
        type: feedback.type,
        message: feedback.message,
        createdAt: feedback.createdAt
      }
    });
  } catch (error: unknown) {
    log.general.error({ err: error }, 'Error submitting feedback');
    res.status(500).json({ error: 'Failed to submit feedback' });
  }
});

/**
 * GET /feedback
 * Get user's feedback history
 */
router.get('/', async (req, res) => {
  try {
    if (!req.user?.id) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    const feedback = await getDb().select().from(feedbackTable)
      .where(eq(feedbackTable.oxyUserId, req.user.id))
      .orderBy(desc(feedbackTable.createdAt), desc(feedbackTable.id))
      .limit(50);

    res.json(feedback);
  } catch (error: unknown) {
    log.general.error({ err: error }, 'Error fetching feedback');
    res.status(500).json({ error: 'Failed to fetch feedback' });
  }
});

/**
 * GET /feedback/:id
 * Get specific feedback by ID
 */
router.get('/:id', async (req, res) => {
  try {
    if (!req.user?.id) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    const [feedback] = await getDb().select().from(feedbackTable).where(and(
      eq(feedbackTable.id, req.params.id),
      eq(feedbackTable.oxyUserId, req.user.id),
    )).limit(1);

    if (!feedback) {
      res.status(404).json({ error: 'Feedback not found' });
      return;
    }

    res.json(feedback);
  } catch (error: unknown) {
    log.general.error({ err: error }, 'Error fetching feedback');
    res.status(500).json({ error: 'Failed to fetch feedback' });
  }
});

export default router;
