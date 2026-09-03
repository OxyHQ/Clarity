import { Router, type Request, type Response } from 'express';

import { proxyClarityChat } from '../../lib/alia-agent-client.js';

const router = Router();

/**
 * Clarity is a product agent in Alia. This endpoint preserves Clarity's public
 * request/response surface while delegating the turn to Alia; Alia then uses
 * the Oxy inference edge, whose data plane is Kaana.
 */
export const handleChatCompletions = async (req: Request, res: Response): Promise<void> => {
  await proxyClarityChat(req, res);
};

router.post('/', handleChatCompletions);

router.get('/', (_req, res) => {
  res.json({
    status: 'online',
    service: 'Clarity agent proxy',
    endpoint: '/v1/chat/completions',
    runtime: 'alia-agent',
  });
});

export default router;
