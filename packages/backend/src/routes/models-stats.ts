import { Router } from 'express';

import { getAllClarityModels, getClarityModel } from '../lib/clarity-models.js';

const router = Router();

function serialize(model: NonNullable<ReturnType<typeof getClarityModel>>) {
  return {
    id: model.id,
    name: model.name,
    description: model.description,
    tier: model.tier,
    category: model.category,
    creditMultiplier: model.creditMultiplier,
    supportsTools: model.supportsTools,
    supportsVision: model.supportsVision,
    maxTokens: model.maxTokens,
    runtime: 'alia-agent',
    isAvailable: Boolean(process.env.CLARITY_ALIA_AGENT_ID?.trim()),
  };
}

router.get('/stats', (_req, res) => {
  const models = getAllClarityModels().map(serialize);
  res.json({ models, count: models.length, timestamp: new Date().toISOString() });
});

router.get('/stats/:modelId', (req, res) => {
  const model = getClarityModel(req.params.modelId);
  if (!model) {
    res.status(404).json({
      error: { code: 'MODEL_NOT_FOUND', message: `Model '${req.params.modelId}' not found` },
    });
    return;
  }
  res.json({ model: serialize(model), timestamp: new Date().toISOString() });
});

export default router;
