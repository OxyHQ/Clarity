import type { NextFunction, Request, Response } from 'express';
import { OxyServices } from '@oxyhq/core';
import {
  createOptionalOxyAuth,
  createOxyAuthMiddleware,
  type OxyRequestUser,
  type OxyServiceAppContext,
} from '@oxyhq/core/server';

const OXY_API_URL = process.env.OXY_API_URL || 'https://api.oxy.so';
export const oxyClient = new OxyServices({ baseURL: OXY_API_URL });

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
export const oxyServiceAuth = oxyClient.serviceAuth({ debug: true });

const oxyOptionalAuth = createOptionalOxyAuth(oxyClient, { auth: { debug: true } });

export function optionalAuth(req: Request, res: Response, next: NextFunction): void {
  oxyOptionalAuth(req, res, next);
}
