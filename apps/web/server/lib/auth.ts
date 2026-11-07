import type { Request, Response, NextFunction } from 'express'

import { LOCAL_PERSON } from '@clawboo/board-core'
import type { PersonRef } from '@clawboo/protocol'

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
      /** The person a sign-in proxy's verified token names (lib/proxyIdentity).
       *  Unset when the lane is off or the request carried no token. */
      person?: PersonRef | null
    }
  }
}

/**
 * The ONE user-resolution site (sibling of getTenantId). The id of the person a
 * sign-in proxy vouched for, else `null`: one implicit user.
 */
export function getUserId(req: Request): string | null {
  return req.person?.id ?? null
}

/**
 * The person to record on what this request does, or null when nothing vouched
 * for who sent it. Only the proxy identity lane sets it, from a token it
 * verified; nothing in a request body or an ordinary header can.
 */
export function personOf(req: Request): PersonRef | null {
  return req.person ?? null
}

/**
 * Who a person-only write acts as: the person a sign-in proxy vouched for, else the
 * install's one built-in person. Only for a write that already passed the person
 * check (`isDashboardRequest`), so locally this stays the speed bump that check is:
 * it names who the dashboard stands for, and proves nothing about who sent it.
 */
export function actingPerson(req: Request): PersonRef {
  return personOf(req) ?? { ...LOCAL_PERSON }
}

/** `{ person }` to spread into what a request records, or `{}` when nothing
 *  vouched for who sent it, so an absent person leaves no key behind. */
export function personField(req: Request): { person?: PersonRef } {
  const person = personOf(req)
  return person ? { person } : {}
}

/**
 * Pass-through identity middleware. It populates `req.tenantId` / `req.userId`
 * and always calls `next()`; it NEVER blocks a request. Access control is the
 * access gate's job and the proxy identity lane's, which run before this. It
 * pairs with @clawboo/control-client's `setRequestHeaderProvider`, which the
 * dashboard does not call.
 */
export function attachIdentity(req: Request, _res: Response, next: NextFunction): void {
  req.tenantId = getTenantId(req)
  req.userId = getUserId(req)
  next()
}

export {}
