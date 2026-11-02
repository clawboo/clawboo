import type { Request, Response, NextFunction } from 'express'

import { getTenantId } from './tenant'

// Augment the Express Request with the resolved identity. Co-located with the
// middleware that populates it (not a standalone .d.ts): auth.ts is a real module
// imported at runtime by server/index.ts, so `attachIdentity` and its type
// augmentation always ship together, and the `import`/`export` here satisfy
// isolatedModules (a bare `declare global` file would be an ambient-script error).
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      tenantId?: string | null
      userId?: string | null
    }
  }
}

/**
 * The ONE user-resolution site (sibling of getTenantId). Single implicit user,
 * so always `null`.
 */
export function getUserId(_req: Request): string | null {
  return null
}

/**
 * Pass-through identity middleware. It populates `req.tenantId` / `req.userId`
 * (both null) and always calls `next()`; it NEVER blocks a request. Access control
 * is the access gate's job, which runs before this. It pairs with
 * @clawboo/control-client's `setRequestHeaderProvider`, which the dashboard does
 * not call.
 */
export function attachIdentity(req: Request, _res: Response, next: NextFunction): void {
  req.tenantId = getTenantId(req)
  req.userId = getUserId(req)
  next()
}

export {}
