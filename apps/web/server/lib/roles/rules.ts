// One rule for every API route: what the route needs (./policy's permissions)
// and how a guest may reach it.
//
// KEYED BY THE ROUTE AS REGISTERED. `METHOD path`, with the path spelled exactly
// as api/index.ts registers it. The guard is attached at registration time
// (./guard `withRouteRules`), so Express has already chosen the route when its
// rule runs: no second matcher can disagree with the router about which route a
// path is. A route with no rule here needs `system`, so it is the operator's
// until someone decides otherwise, and a test fails until it has one.
//
// GUESTS. A guest reaches only the routes with a `guest` entry, and only for the
// teams their token lists: the entry says where the team comes from (a team id
// in the path, an agent's team, a task's team, a list the handler filters).
// Anything else is refused for a guest, whatever their permissions say.

import {
  capabilityGrants,
  createGrantBody,
  getDependents,
  getGrant,
  getTask,
  grantKey,
  isTerminal,
  mainTaskState,
  type ClawbooDb,
  type TaskStatus,
} from '@clawboo/db'
import { eq } from 'drizzle-orm'
import type { Request } from 'express'

import { getDb } from '../db'
import type { Permission } from './policy'

/** Where a guest's team comes from on a route a guest may use. */
export type GuestReach =
  /** Nothing team-specific: the person's own identity, health, presence. */
  | { by: 'any' }
  /** `req.params[param]` is a team id. */
  | { by: 'team'; param: string }
  /** `req.params[param]` is an agent id: the agent's team. */
  | { by: 'agent'; param: string }
  /** `req.params[param]` is a task id: the task's team. */
  | { by: 'task'; param: string }
  /** `req.params[param]` is a task id, on a write that can reach the rest of its
   *  tree (the main task above, the work under it): the team of every task in
   *  the tree, all of which must be the guest's. */
  | { by: 'task-tree'; param: string }
  /** `req.params[param]` is an agent question's id: its task's team. */
  | { by: 'question'; param: string }
  /** `req.query.teamId`, or the team of `req.query.roomId`. */
  | { by: 'query-team' }
  /** `req.query[key]` is a chat session key, which names its team. */
  | { by: 'session-key'; key: string }
  /** `req.body[key]` is a team id. */
  | { by: 'body-team'; key: string }
  /** `req.body[key]` is a task id: the task's team. */
  | { by: 'body-task'; key: string }
  /** `req.body[key]` is an agent id: the agent's team. */
  | { by: 'body-agent'; key: string }
  /** A pause's `kind` and `id`, from where the route's handler reads them: the
   *  body (POST) or the path (DELETE), never the other, so a request cannot show
   *  the guard one target and the handler another. */
  | { by: 'pause'; from: 'body' | 'params' }
  /** `req.params[param]` is a room, which must belong to the team in
   *  `req.params[teamParam]`: that team. */
  | { by: 'room'; param: string; teamParam: string }
  /** A list the route's handler cuts down to the guest's teams itself. */
  | { by: 'list' }

/** One permission, or a list of which any one will do. */
export type Need = Permission | readonly Permission[]

export interface RouteRule {
  /** What the route needs. An empty list: any person the identity lane verified,
   *  with or without a role (only the route that says who they are). */
  need: Need | ((req: Request) => Need)
  /** What the request asks for beyond the route's own need, decided from its
   *  body: an "Allow always", a grant that never asks. Both must hold. */
  more?: (req: Request) => Need | null
  /** How a guest may reach the route. Absent: no guest may. */
  guest?: GuestReach
  /** More of the body a guest's request must keep inside their teams: each one
   *  that the body carries must name something on one of them. A field named
   *  in `guestMayNotSend` refuses a guest's request outright. */
  guestAlso?: readonly GuestReach[]
  guestMayNotSend?: readonly string[]
  /** What a guest's request reaches beyond the task it names, such as the
   *  tasks a cancel carries along: false refuses it. `inTeams` says whether a
   *  team is one of the guest's. */
  guestCheck?: (req: Request, db: ClawbooDb, inTeams: (teamId: string | null) => boolean) => boolean
  /** A spawned runtime's own call on one of the four MCP mounts, which names no
   *  person: the access gate already let it in by its attach token. */
  runtime?: true
  /** One of the reads a reader key's program may make
   *  (lib/proxyIdentity/readerRoutes.ts). It reaches these routes and no other,
   *  with no team scoping. */
  reader?: true
  /** The liveness probe, which needs no identity at all. */
  open?: true
}

/** Owner or operator: a team's own preferences, which either may set. */
const OWNER_OR_OPERATOR: readonly Permission[] = ['setup', 'standing']

const ANY_PERSON: RouteRule = { need: [], guest: { by: 'any' } }

const see = (guest?: GuestReach): RouteRule => (guest ? { need: 'see', guest } : { need: 'see' })
const work = (guest?: GuestReach): RouteRule => (guest ? { need: 'work', guest } : { need: 'work' })
const setup: RouteRule = { need: 'setup' }
const system: RouteRule = { need: 'system' }
const costs: RouteRule = { need: 'costs' }
const records: RouteRule = { need: 'records' }
const accounts: RouteRule = { need: 'accounts' }
const tighten: RouteRule = { need: 'tighten' }
const ownerOrOperator: RouteRule = { need: OWNER_OR_OPERATOR }
const mcp: RouteRule = { need: 'system', runtime: true }
/** A rule a reader key's program may use as well (lib/proxyIdentity/readerRoutes.ts). */
const forReader = (rule: RouteRule): RouteRule => ({ ...rule, reader: true })

const team = (param = 'id'): GuestReach => ({ by: 'team', param })
const agent = (param = 'agentId'): GuestReach => ({ by: 'agent', param })
const task = (param = 'taskId'): GuestReach => ({ by: 'task', param })
/** A write that can reach the rest of the task's tree. */
const tree = (param = 'taskId'): GuestReach => ({ by: 'task-tree', param })
const list: GuestReach = { by: 'list' }

function bodyOf(req: Request): Record<string, unknown> {
  const body = req.body as unknown
  return body && typeof body === 'object' && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : {}
}

/** Always the owner's as well: a setting that can make agents ask less. */
const ASKS_LESS = (): Need => 'standing'

/** An answer that would stand for every later call: the owner's alone. */
function standingIf(field: string, ...values: string[]) {
  return (req: Request): Need | null =>
    values.includes(String(bodyOf(req)[field])) ? 'standing' : null
}

/** An answer that would stand for every later call, as an exact body value (a
 *  boolean, say): the owner's alone. Exact, as the route's handler reads it. */
function standingWhen(field: string, value: unknown) {
  return (req: Request): Need | null => (bodyOf(req)[field] === value ? 'standing' : null)
}

/** How much each grant policy asks, least first. */
const POLICY_ASKS: Readonly<Record<string, number>> = { never: 0, risk: 1, writes: 2, always: 3 }

/**
 * POST /api/grants makes a grant or, for one with the same identity, updates it
 * and makes it active again, keeping the policy it had unless the body names
 * another. So the owner is needed whenever the grant comes out as one that
 * never asks (a revoked one brought back, or a live one widened), and whenever
 * it would ask less than it did.
 */
function grantNeed(req: Request): Need | null {
  const parsed = createGrantBody.safeParse(req.body)
  // The handler refuses a body it cannot read before it writes anything; the
  // body's own policy is still checked, so the guard never reads it as less.
  if (!parsed.success) return standingIf('approvalPolicy', 'never')(req)
  const b = parsed.data
  const existing = getDb()
    .select({ approvalPolicy: capabilityGrants.approvalPolicy })
    .from(capabilityGrants)
    .where(
      eq(
        capabilityGrants.grantKey,
        grantKey({
          subjectKind: b.subjectKind,
          subjectId: b.subjectId ?? null,
          capabilityKind: b.capabilityKind,
          connectorId: b.connectorId ?? null,
          capabilityId: b.capabilityId ?? null,
        }),
      ),
    )
    .get()
  const result = b.approvalPolicy ?? existing?.approvalPolicy ?? 'risk'
  if (result === 'never') return 'standing'
  if (existing && (POLICY_ASKS[result] ?? 0) < (POLICY_ASKS[existing.approvalPolicy] ?? 0)) {
    return 'standing'
  }
  return null
}

/** The tasks a cancel or a close carries along with the one it names: the
 *  waiting dependents a cancel cancels, and the open work under a request that
 *  closes. A guest's move reaches them all, so they must all be on the guest's
 *  teams. */
function cascadeStaysInTeams(
  req: Request,
  db: ClawbooDb,
  inTeams: (teamId: string | null) => boolean,
  status: unknown,
): boolean {
  const taskId = typeof req.params['taskId'] === 'string' ? req.params['taskId'] : ''
  if (status !== 'cancelled' && status !== 'done') return true
  const reached: Array<string | null> = []
  if (status === 'cancelled') {
    // getDependents reads raw rows (snake_case columns), so each one's team comes
    // from its mapped row.
    for (const dep of getDependents(db, taskId)) {
      if (dep.status === 'todo' || dep.status === 'backlog') {
        reached.push(getTask(db, dep.id)?.teamId ?? null)
      }
    }
  }
  for (const id of mainTaskState(db, taskId)?.subtaskIds ?? []) {
    // The close cancels only the open ones (closeOpenSubtasksOfMain): one already
    // done or cancelled is left as it is, whatever team it is on.
    const row = getTask(db, id)
    if (row && !isTerminal(row.status as TaskStatus)) reached.push(row.teamId ?? null)
  }
  return reached.every(inTeams)
}

/** A task made under another reopens the first main task above it when that one
 *  is closed (reopenClosedMainAboveTx), and the chain can climb to another team,
 *  as a hand-off files work there. A guest's create may do that only for a main
 *  task on their own teams. */
function createReopensOnlyOwnTeams(
  req: Request,
  db: ClawbooDb,
  inTeams: (teamId: string | null) => boolean,
): boolean {
  const parentTaskId = bodyOf(req)['parentTaskId']
  if (typeof parentTaskId !== 'string' || parentTaskId === '') return true
  const seen = new Set<string>()
  let id: string | null = parentTaskId
  while (id && !seen.has(id)) {
    seen.add(id)
    const row = getTask(db, id)
    if (!row) return true
    if (row.isMainTask === 1) return !isTerminal(row.status as TaskStatus) || inTeams(row.teamId)
    id = row.parentTaskId ?? null
  }
  return true
}

/** POST /api/capabilities/:action is four routes in one. */
function capabilityNeed(req: Request): Need {
  switch (req.params['action']) {
    case 'approve':
      return 'approve'
    case 'disable':
      return 'tighten'
    case 'enable':
    case 'install':
      return 'setup'
    default:
      return 'system'
  }
}

export const ROUTE_RULES: Readonly<Record<string, RouteRule>> = {
  // ── Settings and access ────────────────────────────────────────────────────
  'GET /api/settings': system,
  'POST /api/settings': system,
  'POST /api/access/launch-code': system,
  'GET /api/access/identity': ANY_PERSON,

  // ── Approvals ──────────────────────────────────────────────────────────────
  'GET /api/approvals': records,
  'POST /api/approvals': { need: 'approve', more: standingIf('action', 'allow-always') },
  'GET /api/tools/approvals': forReader(see(list)),
  'POST /api/tools/approvals/:id/resolve': {
    need: 'approve',
    more: standingIf('decision', 'allow_always'),
  },
  'POST /api/capabilities/:action': {
    need: capabilityNeed,
    more: (req) =>
      req.params['action'] === 'approve' ? standingIf('decision', 'allow_always')(req) : null,
  },

  // ── Chat history ───────────────────────────────────────────────────────────
  'GET /api/chat-history': see({ by: 'session-key', key: 'sessionKey' }),
  'POST /api/chat-history': work(),
  'DELETE /api/chat-history': setup,
  'POST /api/chat-history/reset-context': setup,

  // ── Costs ──────────────────────────────────────────────────────────────────
  'GET /api/cost-records/summary': costs,
  'GET /api/cost-records': costs,
  'POST /api/cost-records': system,
  'GET /api/governance/budgets': costs,
  'POST /api/governance/budgets': costs,
  'POST /api/governance/budgets/:scope/:scopeId/resume': costs,
  'GET /api/fleet/summary': costs,

  // ── Graph layout ───────────────────────────────────────────────────────────
  'GET /api/graph-layout': see(),
  'POST /api/graph-layout': work(),

  // ── How agents run: posture, shell, personality ────────────────────────────
  'GET /api/exec-settings/all': setup,
  'GET /api/exec-settings': setup,
  // Whether an agent asks before it runs a command (OpenClaw's posture, and the
  // local record other runtimes read): setting it can make agents ask less, so it
  // needs the owner as well as an operator.
  'POST /api/exec-settings': { need: 'setup', more: ASKS_LESS },
  'POST /api/exec-allowlist/revoke': tighten,
  'GET /api/exec-allowlist': setup,
  'GET /api/agents/:agentId/shell': setup,
  'POST /api/agents/:agentId/shell': setup,
  'GET /api/personality': setup,
  'POST /api/personality': setup,

  // ── The catalog, skills and tools ──────────────────────────────────────────
  'GET /api/catalog/index': setup,
  'GET /api/catalog/agents/:id': setup,
  'GET /api/catalog/teams/:id': setup,
  'GET /api/skills': setup,
  'POST /api/skills': setup,
  'DELETE /api/skills': setup,
  'GET /api/tools': setup,
  'GET /api/tools/audit': records,
  'GET /api/capabilities': setup,

  // ── The system ─────────────────────────────────────────────────────────────
  'GET /api/system/status': system,
  'POST /api/system/install-openclaw': system,
  // OpenClaw's own settings include its exec policy, which decides what asks.
  'POST /api/system/configure-openclaw': { need: 'system', more: ASKS_LESS },
  'POST /api/system/auto-configure-openclaw': { need: 'system', more: ASKS_LESS },
  'POST /api/system/gateway': system,
  'GET /api/system/openclaw-config': system,
  'PATCH /api/system/openclaw-config': { need: 'system', more: ASKS_LESS },
  'GET /api/system/models': system,
  // A paired device talks to the Gateway directly, approvals included: a standing grant.
  'POST /api/system/approve-device': { need: 'system', more: ASKS_LESS },
  'GET /api/system/self-version': forReader(system),
  'GET /api/system/live': { need: [], open: true },
  'GET /api/system/capabilities': ANY_PERSON,
  'POST /api/system/self-update': system,
  'GET /api/system/hold': system,
  'POST /api/system/hold': system,
  'DELETE /api/system/hold/:owner': system,
  'GET /api/system/idle': system,
  'POST /api/system/presence': ANY_PERSON,
  'GET /api/system/operator-settings': system,
  'PUT /api/system/operator-settings/:key': system,
  'GET /api/health': ANY_PERSON,
  'POST /api/health/recheck': system,
  'POST /api/eval/smoke': system,
  'POST /api/computer/tools/install': system,

  // ── Pauses ─────────────────────────────────────────────────────────────────
  'GET /api/pauses': see(),
  'POST /api/pauses': work({ by: 'pause', from: 'body' }),
  'DELETE /api/pauses/:kind/:id': work({ by: 'pause', from: 'params' }),

  // ── Teams ──────────────────────────────────────────────────────────────────
  'GET /api/teams': forReader(see(list)),
  'GET /api/teams/member-roles': see(),
  'POST /api/teams': setup,
  'PATCH /api/teams/:id': setup,
  'DELETE /api/teams/:id': setup,
  'POST /api/teams/:id/agents': setup,
  'DELETE /api/teams/:id/agents/:agentId': setup,
  'GET /api/teams/:id/task-prefix': see(team()),
  'PUT /api/teams/:id/task-prefix': setup,
  'GET /api/teams/:id/labels': see(team()),
  'POST /api/teams/:id/labels': setup,
  'PATCH /api/teams/:id/labels/:labelId': setup,
  'DELETE /api/teams/:id/labels/:labelId': setup,
  'GET /api/teams/:id/rooms': see(team()),
  'POST /api/teams/:id/rooms': work(team()),
  'PATCH /api/teams/:id/rooms/:roomId': work({ by: 'room', param: 'roomId', teamParam: 'id' }),
  'DELETE /api/teams/:id/rooms/:roomId': setup,
  'GET /api/teams/:id/onboarding': see(team()),
  'PATCH /api/teams/:id/onboarding': ownerOrOperator,
  'GET /api/teams/:id/activity-summary': see(team()),
  'POST /api/teams/:id/chat/stop': work(team()),
  'POST /api/teams/:id/chat/clear': setup,
  'POST /api/teams/:id/chat': work(team()),
  'GET /api/teams/:id/chat/stream': see(team()),
  'GET /api/team-chat': see({ by: 'query-team' }),
  'POST /api/team-chat/exchange': work(),
  'GET /api/team-rules/:teamId': see(team('teamId')),
  'PUT /api/team-rules/:teamId': ownerOrOperator,
  'GET /api/team-plan-approval/:teamId': see(team('teamId')),
  // Turning plan approval off lets plans start without anyone's yes.
  'PUT /api/team-plan-approval/:teamId': {
    need: OWNER_OR_OPERATOR,
    more: standingWhen('on', false),
  },
  'GET /api/team-verify-command/:teamId': setup,
  'PUT /api/team-verify-command/:teamId': setup,
  'GET /api/team-agent-wakes/:teamId': see(team('teamId')),
  // The team's "always allow": agents wake each other without asking anyone.
  'PUT /api/team-agent-wakes/:teamId': {
    need: OWNER_OR_OPERATOR,
    more: standingWhen('always', true),
  },

  // ── Agents ─────────────────────────────────────────────────────────────────
  'GET /api/agents': forReader(see(list)),
  'POST /api/agents': setup,
  'POST /api/agents/sync': setup,
  'GET /api/agents/registry/health': system,
  // Connects to OpenClaw's Gateway, whose socket is the system's.
  'POST /api/agents/registry/connect': system,
  'POST /api/agents/cleanup-ghosts': setup,
  'GET /api/agents/:agentId': see(agent()),
  'PATCH /api/agents/:agentId/model': setup,
  'DELETE /api/agents/:agentId': setup,
  'POST /api/agents/:agentId/move': setup,
  'GET /api/agents/:agentId/files/:name': setup,
  'PUT /api/agents/:agentId/files/:name': setup,
  'GET /api/agents/:agentId/sessions': see(agent()),
  'GET /api/agents/:agentId/screenshot': see(agent()),
  'POST /api/agents/:agentId/screenshot/capture': see(agent()),
  'GET /api/agents/:agentId/computer': see(agent()),
  'GET /api/agents/:agentId/computer/live': see(agent()),
  // Taking over an agent's screen acts in its browser, with its saved sign-ins.
  'POST /api/agents/:agentId/computer/control': ownerOrOperator,
  'POST /api/agents/:agentId/computer/input': ownerOrOperator,
  'POST /api/agents/:agentId/computer/links': setup,
  'DELETE /api/agents/:agentId/computer/links': tighten,
  'DELETE /api/agents/:agentId/computer/links/:linkId': tighten,
  'GET /api/computer-link/info': see(),
  'GET /api/computer-link/live': see(),
  'POST /api/computer-link/control': ownerOrOperator,
  'POST /api/computer-link/input': ownerOrOperator,
  'GET /api/agents/:agentId/workspaces': see(agent()),
  'GET /api/agents/:agentId/team-folder/tree': see(agent()),
  'GET /api/agents/:agentId/team-folder/file': see(agent()),
  'POST /api/agents/:agentId/chat/stop': work(agent()),
  'GET /api/agents/:agentId/chat/stream': see(agent()),
  'POST /api/agents/:agentId/chat': work(agent()),

  // ── Boo Zero ───────────────────────────────────────────────────────────────
  'GET /api/boo-zero/team-briefs/:teamId': see(team('teamId')),
  'PUT /api/boo-zero/team-briefs/:teamId': setup,
  'DELETE /api/boo-zero/team-briefs/:teamId': setup,
  'GET /api/boo-zero/display-name/:agentId': see(agent()),
  'PUT /api/boo-zero/display-name/:agentId': setup,
  'GET /api/boo-zero/override': see(),
  'POST /api/boo-zero/override': setup,

  // ── The board ──────────────────────────────────────────────────────────────
  'GET /api/board': see(list),
  // A task under another team's task, or bound to another team's agent, would reach
  // into that team: a guest's new task keeps everything it names on their teams.
  'POST /api/board': {
    need: 'work',
    guest: { by: 'body-team', key: 'teamId' },
    guestAlso: [
      { by: 'body-task', key: 'parentTaskId' },
      { by: 'body-agent', key: 'assigneeAgentId' },
    ],
    guestMayNotSend: ['sourceDelegationId'],
    guestCheck: createReopensOnlyOwnTeams,
  },
  'GET /api/board/inbox': see(),
  'POST /api/board/inbox/read': see({ by: 'any' }),
  'GET /api/board/:taskId': see(task()),
  'POST /api/board/:taskId/read': see(task()),
  'POST /api/board/:taskId/claim': {
    need: 'work',
    guest: task(),
    guestAlso: [{ by: 'body-agent', key: 'assigneeAgentId' }],
  },
  'PATCH /api/board/:taskId': {
    need: 'work',
    guest: task(),
    guestCheck: (req, db, inTeams) => cascadeStaysInTeams(req, db, inTeams, bodyOf(req)['status']),
  },
  // A comment can name the agent it is from; a guest's names one of their teams.
  'POST /api/board/:taskId/comments': {
    need: 'work',
    guest: task(),
    guestAlso: [{ by: 'body-agent', key: 'authorAgentId' }],
  },
  'PUT /api/board/:taskId/labels': work(task()),
  // A retry or a reopen can move the main task above and the work under it.
  'POST /api/board/:taskId/retry': work(tree()),
  'POST /api/board/:taskId/assign': {
    need: 'work',
    guest: task(),
    guestAlso: [{ by: 'body-agent', key: 'agentId' }],
  },
  'POST /api/board/:taskId/reopen': work(tree()),
  'POST /api/board/:taskId/assign-person': work(task()),
  'GET /api/board/:taskId/questions': see(task()),
  // "Always in this team" stands for every later wake: the owner's.
  'POST /api/board/agent-wakes/:jobTaskId': {
    need: OWNER_OR_OPERATOR,
    more: standingIf('decision', 'team'),
  },
  'POST /api/board/job-limit/:jobTaskId': ownerOrOperator,
  'POST /api/board/questions/:questionId/answer': work({ by: 'question', param: 'questionId' }),
  'GET /api/board/:taskId/plan': see(task()),
  'GET /api/board/:taskId/executions': see(task()),
  // The run ledger is the engine's own bookkeeping, not a guest's.
  'POST /api/board/:taskId/executions': work(),
  'PATCH /api/board/executions/:execId': work(),
  'POST /api/board/:taskId/deps': {
    need: 'work',
    guest: task(),
    guestAlso: [{ by: 'body-task', key: 'dependsOnTaskId' }],
  },
  'POST /api/board/:taskId/cancel-dependents': {
    need: 'work',
    guest: task(),
    guestCheck: (req, db, inTeams) => cascadeStaysInTeams(req, db, inTeams, 'cancelled'),
  },
  'POST /api/board/:taskId/workspace/handoff': work(task()),
  'GET /api/board/:taskId/workspace/detail': see(task()),
  'GET /api/board/:taskId/preview': see(task()),
  'GET /api/board/:taskId/preview/*splat': see(task()),
  'GET /api/board/:taskId/workspace/tree': see(task()),
  'GET /api/board/:taskId/workspace/file': see(task()),
  'GET /api/board/:taskId/workspace/file-diff': see(task()),
  'GET /api/board/:taskId/workspace/status': see(task()),
  'GET /api/board/:taskId/folder/tree': see(task()),
  'GET /api/board/:taskId/folder/file': see(task()),
  // A worktree comes from any repository path on this computer, which reaches
  // past a guest's teams.
  'POST /api/board/:taskId/workspace': work(),
  'GET /api/board/:taskId/workspace': see(task()),
  'PATCH /api/board/:taskId/workspace': work(task()),

  // ── Memory ─────────────────────────────────────────────────────────────────
  'GET /api/memory': see(),
  'POST /api/memory': work(),
  'GET /api/memory/browse': see(),
  'GET /api/memory/graph': see(),
  'POST /api/memory/feedback': work(),
  'GET /api/memory/outcomes': see(),
  'GET /api/memory/provider': system,
  'POST /api/memory/embedding/reindex': system,
  'POST /api/memory/embedding/install': system,

  // ── Website logins: each person's own ──────────────────────────────────────
  'GET /api/website-logins': work(),
  'POST /api/website-logins': work(),
  'PATCH /api/website-logins/:id': work(),
  'DELETE /api/website-logins/:id': work(),
  'POST /api/website-logins/sources/1password/install': system,
  'PUT /api/website-logins/sources/1password': work(),
  'DELETE /api/website-logins/sources/1password': work(),

  // ── Connectors and grants: the outside accounts agents reach ──────────────
  'GET /api/connectors': accounts,
  'POST /api/connectors/connect': setup,
  'GET /api/connectors/configured': accounts,
  'GET /api/connectors/path-suggestions': setup,
  'GET /api/connectors/composio': accounts,
  'PUT /api/connectors/composio/key': setup,
  'DELETE /api/connectors/composio/key': accounts,
  'POST /api/connectors/composio/apps/:slug/authorize': setup,
  'GET /api/connectors/custom': setup,
  'POST /api/connectors/custom': setup,
  'DELETE /api/connectors/custom/:slug': setup,
  'POST /api/connectors/:slug/disconnect': accounts,
  'POST /api/connectors/:slug/authorize': setup,
  'POST /api/connectors/:slug/authorize/await': setup,
  'DELETE /api/connectors/:slug/authorize': accounts,
  'GET /api/connectors/:slug/config': setup,
  'PUT /api/connectors/:slug/config': setup,
  'GET /api/grants': accounts,
  // A grant that never asks lets agents act on an account without anyone's yes.
  // Bringing back or widening one, or making one ask less, likewise.
  'POST /api/grants': { need: 'setup', more: grantNeed },
  'POST /api/grants/:id/revoke': accounts,
  // Undoing a revoke brings back what the grant allowed, a grant that never asks
  // included: that one is the owner's to bring back.
  'POST /api/grants/:id/resume': {
    need: 'accounts',
    more: (req) => {
      const id = typeof req.params['id'] === 'string' ? req.params['id'] : ''
      return getGrant(getDb(), id)?.approvalPolicy === 'never' ? 'standing' : null
    },
  },

  // ── MCP: agents' own servers ───────────────────────────────────────────────
  'GET /api/mcp/config': system,
  'POST /api/mcp/attach-secret/rotate': system,
  'POST /api/mcp/tasks': mcp,
  'GET /api/mcp/tasks': mcp,
  'DELETE /api/mcp/tasks': mcp,
  'POST /api/mcp/memory': mcp,
  'GET /api/mcp/memory': mcp,
  'DELETE /api/mcp/memory': mcp,
  'POST /api/mcp/tools': mcp,
  'GET /api/mcp/tools': mcp,
  'DELETE /api/mcp/tools': mcp,
  'POST /api/mcp/teamchat': mcp,
  'GET /api/mcp/teamchat': mcp,
  'DELETE /api/mcp/teamchat': mcp,

  // ── Runtimes and providers ─────────────────────────────────────────────────
  'GET /api/runtimes': forReader(system),
  'GET /api/runtimes/openrouter/models': system,
  'GET /api/runtimes/codex/models': system,
  'GET /api/runtimes/hermes/gateway': system,
  'POST /api/runtimes/hermes/gateway': system,
  'GET /api/providers': system,
  'GET /api/providers/:id/models': system,
  'POST /api/providers/:id/models': system,
  'POST /api/providers/:id/connect': system,
  'POST /api/providers/:id/disconnect': system,
  'POST /api/auth/cli-login/:tool': system,
  'POST /api/runtimes/:id/install': system,
  'POST /api/runtimes/:id/connect': system,
  'POST /api/runtimes/:id/disconnect': system,
  'POST /api/runtimes/:id/logout': system,
  'POST /api/runtimes/:id/healthcheck': system,
  'POST /api/runtimes/:id/run': work(),

  // ── Onboarding ─────────────────────────────────────────────────────────────
  'POST /api/onboarding/native-leader-model': system,
  'GET /api/onboarding/native-leader-model': system,
  'GET /api/onboarding/state': system,

  // ── Routines ───────────────────────────────────────────────────────────────
  'GET /api/schedules': see(),
  'GET /api/schedules/occurrences': see(),
  'GET /api/schedules/time-zone': see(),
  'PUT /api/schedules/time-zone': setup,
  'POST /api/schedules': setup,
  'POST /api/schedules/:id/run': work(),
  'GET /api/schedules/:id/runs': see(),
  'PATCH /api/schedules/:id': setup,
  'DELETE /api/schedules/:id': setup,

  // ── Governance and observability ───────────────────────────────────────────
  'GET /api/governance/audit': records,
  'POST /api/governance/delegation-approval': work(),
  'GET /api/obs/events': forReader(records),
  'GET /api/obs/traces/:traceId': records,
  'GET /api/obs/errors': records,
  'GET /api/obs/health': records,
  'GET /api/obs/graph': records,
  'GET /api/obs/stream': forReader(records),
}

/** The key a route's rule is filed under. */
export function ruleKey(method: string, path: string): string {
  return `${method.toUpperCase()} ${path}`
}

/** A route nobody has decided: the operator's. */
export const UNLISTED_RULE: RouteRule = system
