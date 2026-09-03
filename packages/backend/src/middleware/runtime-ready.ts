import type { NextFunction, Request, Response } from 'express';

import { getRuntimeReadiness } from '../db/runtime-readiness.js';

export async function requireRuntimeReady(
  _req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const readiness = await getRuntimeReadiness();
  if (readiness.ready === false) {
    res.status(503).json({ error: 'Clarity runtime is not ready.', reason: readiness.reason });
    return;
  }
  next();
}
