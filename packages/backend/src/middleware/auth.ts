import type { NextFunction, Request, RequestHandler, Response } from 'express';
import {
  createOptionalOxyAuth,
  createOxyAuthMiddleware,
  OxyServer,
  type OxyRequestUser,
  type OxyServiceAppContext,
} from '@oxy.so/core/server';

const OXY_API_URL = process.env.OXY_API_URL || 'https://api.oxy.so';
export const oxyClient = new OxyServer({ baseURL: OXY_API_URL });

declare global {
  namespace Express {
    interface Request {
      userId?: string;
      accessToken?: string;
      user?: OxyRequestUser | null;
      serviceApp?: OxyServiceAppContext;
      workspace?: {
        id: string | null;
        role?: 'owner' | 'admin' | 'member';
      };
    }
  }
}

/** Canonical Oxy user-session middleware. */
export const authenticateToken = createOxyAuthMiddleware(oxyClient, { auth: { debug: true } });

/** Canonical Oxy service-principal middleware for fail-closed internal routes. */
// `middleware.service()` is typed against core's framework-neutral request, whose
// `user` is the full profile; this app's Express request carries `OxyRequestUser`.
export const oxyServiceAuth = oxyClient.middleware.service({
  debug: true,
}) as unknown as RequestHandler;

const oxyOptionalAuth = createOptionalOxyAuth(oxyClient, { auth: { debug: true } });

export function optionalAuth(req: Request, res: Response, next: NextFunction): void {
  oxyOptionalAuth(req, res, next);
}
