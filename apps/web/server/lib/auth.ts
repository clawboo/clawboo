import type { Request, Response, NextFunction } from 'express'

import { LOCAL_PERSON } from '@clawboo/board-core'
import { createLogger } from '@clawboo/logger'
import type { EventActor } from '@clawboo/obs'
import type { PersonRef } from '@clawboo/protocol'

import { isDashboardRequest } from './dashboardRequest'
import { getTenantId } from './tenant'

const log = createLogger('person-check')

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
      /** Which issuer vouched for `person`: a sign-in proxy, or the app that
       *  started the engine (its app link). Unset with no person. */
      personVia?: 'proxy' | 'app'
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
 * check (`actsAsPerson`), so locally this stays the speed bump that check is:
 * it names who the dashboard stands for, and proves nothing about who sent it.
 */
export function actingPerson(req: Request): PersonRef {
  return personOf(req) ?? { ...LOCAL_PERSON }
}

/** True when the app that started the engine vouched for this request's person
 *  (its app link), rather than a sign-in proxy. Decided by which key verified
 *  the token, never by the person's id. */
export function personFromAppLink(req: Request): boolean {
  return personOf(req) !== null && req.personVia === 'app'
}

/** `{ person }` to spread into what a request records, or `{}` when nothing
 *  vouched for who sent it, so an absent person leaves no key behind. */
export function personField(req: Request): { person?: PersonRef } {
  const person = personOf(req)
  return person ? { person } : {}
}

/**
 * May this request act as the person? The ONE check behind every person write:
 * moving a card, Retry, Assign, answering an approval, a person's comment and a
 * team's work check. True for a person a sign-in proxy vouched for, and for the
 * dashboard's own page.
 *
 * Behind a sign-in proxy in `required` mode this is real: every request names a
 * verified person. Everywhere else it is a speed bump, NOT a security boundary
 * (see isDashboardRequest): agents run as the same OS user, so one can read the
 * access token, send the same headers or write the database, until agent mode
 * keeps it out. It stops an agent or a script passing for the person by accident
 * or by setting a field.
 *
 * `personOf` must stay "a person something vouched for". A built-in local person
 * would answer it for every request, so that person belongs behind this check.
 */
export function actsAsPerson(req: Request): boolean {
  return personOf(req) !== null || isDashboardRequest(req)
}

/** Refuse a request that may not act as the person: answers 403 `person_only` and
 *  returns true. For a route that means nothing without the person's authority. */
export function refuseUnlessPerson(req: Request, res: Response): boolean {
  if (actsAsPerson(req)) return false
  log.warn({ method: req.method, path: req.path }, 'refused a person write')
  res.status(403).json({ ok: false, error: 'person_only' })
  return true
}

/** `{ actor, person? }` to spread into the event of what a request wrote: `person`
 *  when it passed the check, with a name when a proxy vouched for one, and `caller`
 *  when it did not, which says nothing about who it was. */
export function actorField(req: Request): { actor: EventActor; person?: PersonRef } {
  return { actor: { kind: actsAsPerson(req) ? 'person' : 'caller' }, ...personField(req) }
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
