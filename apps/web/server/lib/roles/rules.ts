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

import { getGrant } from '@clawboo/db'
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
  /** A spawned runtime's own call on one of the four MCP mounts, which names no
   *  person: the access gate already let it in by its attach token. */
  runtime?: true
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

const team = (param = 'id'): GuestReach => ({ by: 'team', param })
const agent = (param = 'agentId'): GuestReach => ({ by: 'agent', param })
const task = (param = 'taskId'): GuestReach => ({ by: 'task', param })
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
  'GET /api/tools/approvals': see(list),
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
  'POST /api/system/approve-device': system,
  'GET /api/system/self-version': system,
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
  'GET /api/teams': see(list),
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
  'PUT /api/team-plan-approval/:teamId': ownerOrOperator,
  'GET /api/team-verify-command/:teamId': setup,
  'PUT /api/team-verify-command/:teamId': setup,
  'GET /api/team-agent-wakes/:teamId': see(team('teamId')),
  'PUT /api/team-agent-wakes/:teamId': ownerOrOperator,

  // ── Agents ─────────────────────────────────────────────────────────────────
  'GET /api/agents': see(list),
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
  'PATCH /api/board/:taskId': work(task()),
  // A comment can name the agent it is from; a guest's names one of their teams.
  'POST /api/board/:taskId/comments': {
    need: 'work',
    guest: task(),
    guestAlso: [{ by: 'body-agent', key: 'authorAgentId' }],
  },
  'PUT /api/board/:taskId/labels': work(task()),
  'POST /api/board/:taskId/retry': work(task()),
  'POST /api/board/:taskId/assign': {
    need: 'work',
    guest: task(),
    guestAlso: [{ by: 'body-agent', key: 'agentId' }],
  },
  'POST /api/board/:taskId/reopen': work(task()),
  'POST /api/board/:taskId/assign-person': work(task()),
  'GET /api/board/:taskId/questions': see(task()),
  'POST /api/board/agent-wakes/:jobTaskId': ownerOrOperator,
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
  'POST /api/board/:taskId/cancel-dependents': work(task()),
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
  'POST /api/grants': { need: 'setup', more: standingIf('approvalPolicy', 'never') },
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
  'GET /api/runtimes': system,
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
  'GET /api/obs/events': records,
  'GET /api/obs/traces/:traceId': records,
  'GET /api/obs/errors': records,
  'GET /api/obs/health': records,
  'GET /api/obs/graph': records,
  'GET /api/obs/stream': records,
}

/** The key a route's rule is filed under. */
export function ruleKey(method: string, path: string): string {
  return `${method.toUpperCase()} ${path}`
}

/** A route nobody has decided: the operator's. */
export const UNLISTED_RULE: RouteRule = system
