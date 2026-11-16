// The role check on every API route, attached when the route is registered.
//
// `withRouteRules(router)` makes every `router.get/post/put/patch/delete` put a
// guard in front of the route's own handlers, with the rule filed under the
// route's method and path (./rules). Express has chosen the route by the time
// its guard runs, so the guard never has to agree with the router about which
// route a path is: there is no second matcher to fool with a dot segment, a
// letter case or a percent sign.
//
// With roles off (the default) the guard is a pass-through and costs one
// property read. With `proxyIdentityRoles: enforce` it reads the access the
// identity lane verified (req.access) and refuses, with a 403 and a reason,
// whatever the person's roles do not allow. For a guest it also finds the team
// the request is about and refuses anything outside the guest's teams.
//
// FAIL CLOSED. A rule it cannot resolve, a team it cannot find, a request with
// no verified person on a route that is not a runtime's own MCP call: each is a
// refusal, never a pass.

import { agents, getQuestion, getRoom, getTask, taskTreeRootId, type ClawbooDb } from '@clawboo/db'
import { createLogger } from '@clawboo/logger'
import type { PersonRef } from '@clawboo/protocol'
import { parseTeamSessionKey } from '@clawboo/team-orchestration'
import { eq, sql } from 'drizzle-orm'
import type { NextFunction, Request, RequestHandler, Response, Router } from 'express'

import { agentIdFromDirectChatKey } from '../agentChat/directChatSessionKey'
import { getDb } from '../db'
import {
  accessEnded,
  guestTeams,
  isGuestOnly,
  permissionsOf,
  type PersonAccess,
  type Permission,
} from './policy'
import {
  ROUTE_RULES,
  UNLISTED_RULE,
  ruleKey,
  type GuestReach,
  type Need,
  type RouteRule,
} from './rules'

const log = createLogger('roles')

/** How roles are applied: published on `app.locals['rolesMode']` at startup. */
export type RolesMode = 'off' | 'enforce'

/** What a guard found for a guest: the teams the handler may show them. */
export interface RoleScope {
  teams: ReadonlySet<string>
}

/** Why a request was refused. */
export type RoleRefusal =
  /** No verified person on a route that needs one. */
  | 'person'
  /** The token names no role this engine knows. */
  | 'no-role'
  /** The person's roles do not allow what the request asks for. */
  | 'not-allowed'
  /** A guest's access has ended. */
  | 'ended'
  /** A guest asked for something outside their teams. */
  | 'outside-teams'

const MESSAGES: Readonly<Record<RoleRefusal, string>> = {
  person: 'This needs a signed-in person.',
  'no-role': 'You have no role in this workspace. Ask its owner for access.',
  'not-allowed': 'Your role in this workspace does not allow this.',
  ended: 'Your access to this workspace has ended.',
  'outside-teams': 'This is outside the teams you work with in this workspace.',
}

/** The 403 a refused request gets. `error` is `role` for every refusal, so a
 *  client tells it apart from the person check's `person_only`. */
export function roleRefusalBody(reason: RoleRefusal): Record<string, unknown> {
  return { ok: false, error: 'role', reason, message: MESSAGES[reason] }
}

function refuse(res: Response, reason: RoleRefusal): void {
  res.status(403).set('Cache-Control', 'no-store').json(roleRefusalBody(reason))
}

function needList(need: Need): readonly Permission[] {
  return typeof need === 'string' ? [need] : need
}

/** True when the set holds any one of `need`, or `need` asks for nothing. */
function satisfies(perms: ReadonlySet<Permission>, need: Need): boolean {
  const list = needList(need)
  return list.length === 0 || list.some((p) => perms.has(p))
}

// ─── The team a guest's request is about ─────────────────────────────────────

/** A single string from a path or query value, else null. */
function oneString(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

/** The team an agent belongs to, or null. */
export function teamOfAgent(db: ClawbooDb, agentId: string | null): string | null {
  if (!agentId) return null
  const row = db.select({ teamId: agents.teamId }).from(agents).where(eq(agents.id, agentId)).get()
  return row?.teamId ?? null
}

/** The team a task belongs to, or null. */
export function teamOfTask(db: ClawbooDb, taskId: string | null): string | null {
  if (!taskId) return null
  return getTask(db, taskId)?.teamId ?? null
}

/**
 * The team of every task in the tree `taskId` sits in, from its root down: a
 * retry, a reopen or a pause reaches the main task above and the work filed
 * under it. Tasks of one tree can sit on different teams, as a hand-off files
 * work on another team. Empty for a task that does not exist.
 */
export function teamsOfTaskTree(db: ClawbooDb, taskId: string | null): Array<string | null> {
  if (!taskId) return []
  const root = taskTreeRootId(db, taskId)
  // `UNION`, so the walk ends even on a parent cycle in a corrupt database.
  return db
    .all<{ teamId: string | null }>(
      sql`
        WITH RECURSIVE tree(id) AS (
          SELECT id FROM tasks WHERE id = ${root}
          UNION
          SELECT t.id FROM tasks t JOIN tree ON t.parent_task_id = tree.id
        )
        SELECT team_id AS teamId FROM tasks WHERE id IN (SELECT id FROM tree)
      `,
    )
    .map((r) => r.teamId)
}

function teamOfSessionKey(db: ClawbooDb, key: string | null): string | null {
  if (!key) return null
  const teamKey = parseTeamSessionKey(key)
  if (teamKey) return teamKey.teamId
  return teamOfAgent(db, agentIdFromDirectChatKey(key))
}

function bodyField(req: Request, key: string): unknown {
  const body = req.body as unknown
  return body && typeof body === 'object' && !Array.isArray(body)
    ? (body as Record<string, unknown>)[key]
    : undefined
}

/**
 * The team a guest's request is about, `true` for a route whose answer the
 * handler itself cuts down to the guest's teams (or that is about no team), or
 * null when no team could be found, which refuses. A list: every team the
 * request reaches, each of which must be one of the guest's.
 */
function guestTarget(
  db: ClawbooDb,
  req: Request,
  reach: GuestReach,
): string | true | null | ReadonlyArray<string | null> {
  switch (reach.by) {
    case 'any':
    case 'list':
      return true
    case 'team':
      return oneString(req.params[reach.param])
    case 'agent':
      return teamOfAgent(db, oneString(req.params[reach.param]))
    case 'task':
      return teamOfTask(db, oneString(req.params[reach.param]))
    case 'task-tree':
      return teamsOfTaskTree(db, oneString(req.params[reach.param]))
    case 'question': {
      const id = oneString(req.params[reach.param])
      return id ? teamOfTask(db, getQuestion(db, id)?.taskId ?? null) : null
    }
    case 'query-team': {
      const teamId = oneString(req.query['teamId'])
      const roomId = oneString(req.query['roomId'])
      const roomTeam = roomId ? (getRoom(db, roomId)?.teamId ?? null) : null
      // Both named: they must agree, or the room would carry the guest elsewhere.
      if (teamId && roomId) return roomTeam === teamId ? teamId : null
      return teamId ?? roomTeam
    }
    case 'session-key':
      return teamOfSessionKey(db, oneString(req.query[reach.key]))
    case 'room': {
      const teamId = oneString(req.params[reach.teamParam])
      const roomId = oneString(req.params[reach.param])
      if (!teamId || !roomId) return null
      return getRoom(db, roomId)?.teamId === teamId ? teamId : null
    }
    case 'body-team':
      return oneString(bodyField(req, reach.key))
    case 'body-task':
      return teamOfTask(db, oneString(bodyField(req, reach.key)))
    case 'body-agent':
      return teamOfAgent(db, oneString(bodyField(req, reach.key)))
    case 'pause': {
      const read = (key: string): string | null =>
        oneString(reach.from === 'body' ? bodyField(req, key) : req.params[key])
      const kind = read('kind')
      const id = read('id')
      if (kind === 'team') return id
      if (kind === 'agent') return teamOfAgent(db, id)
      // A task's pause covers its whole tree, which can reach other teams.
      if (kind === 'task') return teamsOfTaskTree(db, id)
      return null
    }
  }
}

// ─── The decision ────────────────────────────────────────────────────────────

export type GuardDecision =
  { ok: true; scope: RoleScope | null } | { ok: false; reason: RoleRefusal }

/** What a request may do on a route with this rule. Pure but for the database
 *  reads a guest's team needs. */
export function decideRole(
  req: Request,
  rule: RouteRule,
  opts: { now?: number; db?: () => ClawbooDb } = {},
): GuardDecision {
  const caller = req.person ?? req.service ?? null
  if (!caller) {
    // Only a spawned runtime's own MCP call arrives with no person and no service:
    // the identity lane refuses every other unnamed request before any route.
    return rule.runtime === true ? { ok: true, scope: null } : { ok: false, reason: 'person' }
  }
  const access = req.access ?? null
  if (!access) return { ok: false, reason: 'no-role' }

  const now = opts.now ?? Date.now()
  const need = typeof rule.need === 'function' ? rule.need(req) : rule.need
  const anyPerson = needList(need).length === 0
  if (!anyPerson && access.roles.length === 0) return { ok: false, reason: 'no-role' }
  if (!anyPerson && accessEnded(access, now)) return { ok: false, reason: 'ended' }

  const perms = permissionsOf(access, now)
  if (!satisfies(perms, need)) return { ok: false, reason: 'not-allowed' }
  const more = rule.more?.(req) ?? null
  if (more !== null && !satisfies(perms, more)) return { ok: false, reason: 'not-allowed' }

  const teams = guestTeams(access)
  if (teams === null) return { ok: true, scope: null }
  if (!rule.guest) return { ok: false, reason: 'outside-teams' }
  const db = opts.db ? opts.db() : getDb()
  const inTeams = (reach: GuestReach): boolean => {
    const target = guestTarget(db, req, reach)
    if (target === true) return true
    if (target === null) return false
    if (typeof target === 'string') return teams.has(target)
    return target.length > 0 && target.every((t) => t !== null && teams.has(t))
  }
  if (!inTeams(rule.guest)) return { ok: false, reason: 'outside-teams' }
  for (const field of rule.guestMayNotSend ?? []) {
    if (bodyField(req, field) !== undefined) return { ok: false, reason: 'outside-teams' }
  }
  for (const reach of rule.guestAlso ?? []) {
    // Checked only when the body carries the field: the main reach holds the rest.
    const key = 'key' in reach ? reach.key : null
    if (key !== null && bodyField(req, key) === undefined) continue
    if (!inTeams(reach)) return { ok: false, reason: 'outside-teams' }
  }
  if (rule.guestCheck) {
    const onTeams = (teamId: string | null): boolean => teamId !== null && teams.has(teamId)
    if (!rule.guestCheck(req, db, onTeams)) return { ok: false, reason: 'outside-teams' }
  }
  return { ok: true, scope: { teams } }
}

/** The longest a timer may wait (Node clamps anything longer to 1 ms). */
const MAX_TIMER_MS = 2 ** 31 - 1

/**
 * End a guest's response when their access ends. A stream (a chat's live
 * tail, say) passes the guard once and then stays open, so without this it
 * would go on past `access_until`. Destroying the response closes the
 * connection, which runs the stream's own cleanup. A deadline further off than
 * a timer can wait ends the stream at the timer's limit instead, and the
 * client's reconnect is checked afresh.
 */
function endAtGuestDeadline(res: Response, access: PersonAccess, now: number): void {
  if (!isGuestOnly(access) || access.until === null) return
  const wait = Math.max(0, Math.min(access.until * 1000 - now, MAX_TIMER_MS))
  const timer = setTimeout(() => {
    if (!res.writableEnded) res.destroy()
  }, wait)
  timer.unref?.()
  const clear = (): void => clearTimeout(timer)
  res.on('finish', clear)
  res.on('close', clear)
}

/** The rule a route's guard applies, kept on the guard so a test can read the
 *  router and find each route's own. */
export const GUARD_RULE = Symbol.for('clawboo.roleRule')

/** The guard for one route. A pass-through unless roles are enforced. */
export function roleGuard(rule: RouteRule): RequestHandler {
  const guard = (req: Request, res: Response, next: NextFunction): void => {
    if (req.app.locals['rolesMode'] !== 'enforce') {
      next()
      return
    }
    const decision = decideRole(req, rule)
    if (!decision.ok) {
      refuse(res, decision.reason)
      return
    }
    if (decision.scope) req.roleScope = decision.scope
    if (req.access) endAtGuestDeadline(res, req.access, Date.now())
    next()
  }
  Object.defineProperty(guard, GUARD_RULE, { value: rule })
  return guard
}

const METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const

/**
 * Put a role guard in front of every route registered on `router` from now on,
 * with the rule filed under the route's method and path. A route with no rule
 * gets the operator's (`system`), and `onUnlisted` hears about it.
 */
export function withRouteRules<R extends Router>(
  router: R,
  {
    rules = ROUTE_RULES,
    onUnlisted = (key) =>
      log.warn({ route: key }, 'A route has no role rule, so only operators may use it'),
  }: { rules?: Readonly<Record<string, RouteRule>>; onUnlisted?: (key: string) => void } = {},
): R {
  for (const method of METHODS) {
    const register = (router[method] as (...args: unknown[]) => unknown).bind(router)
    const guarded = (path: unknown, ...handlers: unknown[]): unknown => {
      if (typeof path !== 'string') return register(path, ...handlers)
      const key = ruleKey(method, path)
      let rule = rules[key]
      if (!rule) {
        onUnlisted(key)
        rule = UNLISTED_RULE
      }
      return register(path, roleGuard(rule), ...handlers)
    }
    ;(router as unknown as Record<string, unknown>)[method] = guarded
  }
  return router
}

/** The teams a guest may see, when the route's guard found them: a list handler
 *  keeps only the rows of these teams. Null for everyone else. */
export function roleScopeOf(req: Request): RoleScope | null {
  return req.roleScope ?? null
}

/** True when a row of `teamId` may be shown on this request. */
export function inRoleScope(req: Request, teamId: string | null | undefined): boolean {
  const scope = roleScopeOf(req)
  return scope === null || (typeof teamId === 'string' && scope.teams.has(teamId))
}

/**
 * Whether the Gateway's WebSocket may open for the person its upgrade named.
 * The socket carries the OpenClaw Gateway's own commands, which no one checks
 * one by one, and they include answering its approvals ("Allow always" too) and
 * setting what asks. So with roles enforced only a person who may do all of it
 * opens it: one who runs the system and answers approvals, standing ones
 * included (an owner who is an operator too). Always true with roles off.
 */
export function upgradeAllowedForRoles(
  mode: RolesMode,
  decision: { person: PersonRef | null; access?: PersonAccess | null },
  now = Date.now(),
): boolean {
  if (mode !== 'enforce') return true
  if (!decision.person || !decision.access) return false
  const perms = permissionsOf(decision.access, now)
  return perms.has('system') && perms.has('approve') && perms.has('standing')
}
