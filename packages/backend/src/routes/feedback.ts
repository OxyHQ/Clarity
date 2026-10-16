import { Router } from 'express';
import { authenticateToken } from '../middleware/auth.js';
import { log } from '../lib/logger.js';
import { findFeedback, isFeedbackType, listFeedback, submitFeedback } from '../lib/feedback.js';

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

    if (!isFeedbackType(type)) {
      res.status(400).json({ error: 'Invalid feedback type' });
      return;
    }

    if (rating !== undefined && (rating < 1 || rating > 5)) {
      res.status(400).json({ error: 'Rating must be between 1 and 5' });
      return;
    }

    const feedback = await submitFeedback(req.user.id, { type, rating, message, email, metadata });
    res.status(201).json({ success: true, feedback });
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
    res.json(await listFeedback(req.user.id));
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
    const feedback = await findFeedback(req.user.id, req.params.id);
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
