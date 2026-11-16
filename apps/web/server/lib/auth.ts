import type { Request, Response, NextFunction } from 'express'

import { LOCAL_PERSON } from '@clawboo/board-core'
import { createLogger } from '@clawboo/logger'
import type { EventActor } from '@clawboo/obs'
import type { PersonRef } from '@clawboo/protocol'

import { isDashboardRequest } from './dashboardRequest'
import { personCheckMode } from './personCheck'
import type { RoleScope } from './roles/guard'
import type { PersonAccess } from './roles/policy'
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
      /** What the person's token grants, read by the identity lane only while
       *  roles are enforced (lib/roles). Unset otherwise. */
      access?: PersonAccess | null
      /** The program a service token names (roles enforced, `svc: true`): a
       *  caller the sign-in front vouched for that is not a person. Unset otherwise. */
      service?: PersonRef | null
      /** The teams a guest may see on this request, set by the route's role
       *  guard. Unset for everyone else. */
      roleScope?: RoleScope
      /** The agent whose screen this request's person may take over, from the
       *  `control` claim of a sign-in proxy's request-bound token, read only
       *  while `proxyIdentityControlClaim` is `required`. Null or unset otherwise. */
      controlClaim?: string | null
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
 * check (`actsAsPerson`), so in its `page` mode this stays the speed bump that
 * check is: it names who the dashboard stands for, and proves nothing about who
 * sent it.
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
 * team's work check. True for a person a verified token names; with the person
 * check in `page` mode (lib/personCheck.ts, the default), also for the
 * dashboard's own page.
 *
 * With `personCheck: verified`, or behind a sign-in proxy in `required` mode
 * (which is always `verified`), only a verified token counts. In `page` mode it
 * is a speed bump, NOT a security boundary (see isDashboardRequest): anything
 * holding the access token can send the page's headers. Either way an agent
 * running as this server's OS user can still write the database directly,
 * until agent mode keeps it out. It stops an agent or a script passing for the
 * person by accident or by setting a field.
 *
 * `personOf` must stay "a person something vouched for". A built-in local person
 * would answer it for every request, so that person belongs behind this check.
 */
export function actsAsPerson(req: Request): boolean {
  // A service token is a program, whatever headers it sends: it never acts as a person.
  if (req.service) return false
  if (personOf(req) !== null) return true
  return personCheckMode() === 'page' && isDashboardRequest(req)
}

/**
 * Whether this request's token lets its person take over `agentId`'s screen:
 * a sign-in proxy's person whose `control` claim names exactly that agent. Only
 * meaningful while `proxyIdentityControlClaim` is `required`; the lane never
 * sets the claim otherwise.
 */
export function controlClaimFor(req: Request, agentId: string): boolean {
  if (req.service || personOf(req) === null || req.personVia !== 'proxy') return false
  return typeof req.controlClaim === 'string' && req.controlClaim === agentId && agentId !== ''
}

/** Refuse a request that may not act as the person: answers 403 `person_only` and
 *  returns true. For a route that means nothing without the person's authority. */
export function refuseUnlessPerson(req: Request, res: Response): boolean {
  if (actsAsPerson(req)) return false
  log.warn({ method: req.method, path: req.path }, 'refused a person write')
  res.status(403).json({ ok: false, error: 'person_only' })
  return true
}

/**
 * For a route the access cookie opens in `page` mode but that is a person's under
 * `personCheck: verified`: what an agent's screen shows (its live view, its
 * browser's screenshots) and taking it over. Refuses like `refuseUnlessPerson`
 * under `verified`; does nothing in `page` mode.
 */
export function refuseUnlessVerifiedPerson(req: Request, res: Response): boolean {
  return personCheckMode() === 'verified' && refuseUnlessPerson(req, res)
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
