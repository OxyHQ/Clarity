import type { NextFunction, Request, Response } from 'express';
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

const oxyOptionalAuth = createOptionalOxyAuth(oxyClient, {
  auth: { debug: true, strictOptionalBearer: true },
});

/** Only the Experience domain is reviewed for supervised profile management. */
export const experienceAuth = createOxyAuthMiddleware(oxyClient, {
  auth: { supervisedAction: 'profile', loadUser: true },
});
export const experienceOptionalAuth = createOptionalOxyAuth(oxyClient, {
  auth: { supervisedAction: 'profile', strictOptionalBearer: true, loadUser: true },
});

export function optionalAuth(req: Request, res: Response, next: NextFunction): void {
  oxyOptionalAuth(req, res, next);
}
