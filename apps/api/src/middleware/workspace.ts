import { Request, Response, NextFunction } from 'express';

/**
 * Resolves the X-Workspace-Id header into req.workspace.
 * - 'personal' or missing → req.workspace = { id: null }
 * - '<orgId>' → sets req.workspace = { id }
 *
 * Organization membership verification was removed during Clarity pruning.
 * The middleware now trusts the header value without a DB lookup.
 */
export async function resolveWorkspace(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const workspaceId = req.headers['x-workspace-id'] as string | undefined;

  if (!workspaceId || workspaceId === 'personal') {
    req.workspace = { id: null };
    return next();
  }

  const userId = req.user?.id;
  if (!userId) {
    res.status(401).json({ error: 'Authentication required', code: 'MISSING_AUTH', message: 'Authentication required' });
    return;
  }

  req.workspace = { id: workspaceId };
  next();
}
