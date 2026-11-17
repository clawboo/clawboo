// Home: one page per team (and one for all teams) with the team's goals, KPIs,
// pages and a status line, read in one call (`GET /api/home`), plus the writes
// behind it under `/api/home/teams/:teamId/...`. Check the `home.goals`
// capability flag first: an engine without it has none of these routes.
//
// WHO MAY WRITE. Every write here is a person's (the server's person check,
// `board.personCheck`): a request that may not act as the person gets 403
// `person_only`. Agents write through the Tasks MCP tools instead, and only
// some things: they report a KPI value, suggest a KPI, write a page and draft a
// goal update. An agent never defines a KPI, sets a target, sets a goal's health
// or publishes an update.
//
// WHERE NUMBERS COME FROM. A KPI's reading says its source: `computed` (worked
// out on read from the board, its costs and its budgets), `agent` (reported by
// an agent, with the run and task it came from) or `person` (typed by a
// person). Computed metrics use rolling periods: the last 7, 30 or 90 days, or
// all time.
//
// Times are epoch ms on the engine's clock.

import { apiFetch } from './config'

// ─── Enums ───────────────────────────────────────────────────────────────────

export const GOAL_STATUSES = ['active', 'done', 'dropped'] as const
export type GoalStatus = (typeof GOAL_STATUSES)[number]

export const GOAL_HEALTHS = ['on_track', 'at_risk', 'off_track'] as const
export type GoalHealth = (typeof GOAL_HEALTHS)[number]

export const GOAL_UPDATE_STATES = ['draft', 'published', 'discarded'] as const
export type GoalUpdateState = (typeof GOAL_UPDATE_STATES)[number]

export const KPI_DIRECTIONS = ['up', 'down'] as const
export type KpiDirection = (typeof KPI_DIRECTIONS)[number]

/** `week`, `month`, `quarter`: the last 7, 30 or 90 days. `all`: all time. */
export const KPI_PERIODS = ['week', 'month', 'quarter', 'all'] as const
export type KpiPeriod = (typeof KPI_PERIODS)[number]

export const KPI_SOURCES = ['computed', 'agent', 'person'] as const
export type KpiSource = (typeof KPI_SOURCES)[number]

export const KPI_STATUSES = ['active', 'suggested', 'archived'] as const
export type KpiStatus = (typeof KPI_STATUSES)[number]

/**
 * The closed list of metrics a `computed` KPI can read. Each is worked out on
 * read for the KPI's period, for the KPI's team:
 *
 *   tasks_done            tasks moved to Done (requests' own cards not counted)
 *   tasks_checked_done    of those, the ones whose check passed
 *   requests_done         people's requests (main tasks) finished
 *   spend_usd             what the team's runs cost, estimates included
 *   budget_used_pct       the team budget's spend over its limit, now (no period)
 *   run_success_rate      finished runs that succeeded, as a percent
 *   needs_you_count       tasks waiting on a person now (no period)
 *   median_hours_to_done  median hours from created to Done, for tasks done in the period
 *   open_requests         people's requests still open now (no period)
 */
export const HOME_COMPUTED_METRICS = [
  'tasks_done',
  'tasks_checked_done',
  'requests_done',
  'spend_usd',
  'budget_used_pct',
  'run_success_rate',
  'needs_you_count',
  'median_hours_to_done',
  'open_requests',
] as const
export type HomeComputedMetric = (typeof HOME_COMPUTED_METRICS)[number]

/** The unit each computed metric reads in, for a KPI form's default. */
export const HOME_COMPUTED_METRIC_UNITS: Readonly<Record<HomeComputedMetric, string>> = {
  tasks_done: 'tasks',
  tasks_checked_done: 'tasks',
  requests_done: 'requests',
  spend_usd: '$',
  budget_used_pct: '%',
  run_success_rate: '%',
  needs_you_count: 'tasks',
  median_hours_to_done: 'hours',
  open_requests: 'requests',
}

/** Metrics that read the state now and ignore the KPI's period. */
export const HOME_POINT_IN_TIME_METRICS: readonly HomeComputedMetric[] = [
  'budget_used_pct',
  'needs_you_count',
  'open_requests',
]

// ─── Records ─────────────────────────────────────────────────────────────────

/** Who did something: a person (from the person check) or an agent. */
export interface HomeActor {
  kind: 'person' | 'agent'
  id: string
  name: string | null
}

export interface TeamGoal {
  id: string
  teamId: string
  /** One level only: a goal with a parent is never itself a parent. Same team. */
  parentGoalId: string | null
  title: string
  /** Markdown, possibly empty. */
  description: string
  owner: HomeActor | null
  targetDate: number | null
  status: GoalStatus
  /** Set by a person, directly or by publishing an update that names one. */
  health: GoalHealth | null
  healthSetBy: HomeActor | null
  healthSetAt: number | null
  /** How often an update is expected; past it with none published, `updateMissing`. */
  updateCadenceDays: number
  position: number
  createdBy: HomeActor | null
  createdAt: number
  updatedAt: number
  /** Archived goals are left out of lists unless asked for. */
  archivedAt: number | null
}

/**
 * Progress over the tasks linked to a goal: its own `goalId`, else its
 * request's, else its parent chain's. A request's own card (`isMainTask`) is a
 * container and is not counted; cancelled and removed tasks are left out.
 */
export interface GoalProgress {
  /** Linked tasks counted: everything but cancelled and removed ones. */
  total: number
  done: number
  /** Done tasks whose check passed. */
  doneChecked: number
  /** Linked tasks created in the last 7 days: how the scope changed. */
  addedLast7Days: number
  /** Linked tasks moved to Done in the last 7 days. */
  doneLast7Days: number
}

/** The sum of linked tasks' run cost. */
export interface GoalCost {
  usd: number
  /** True when any task's cost includes an estimate rather than a reported one. */
  includesEstimates: boolean
}

/** A goal with what a list row needs. */
export interface GoalSummary {
  goal: TeamGoal
  progress: GoalProgress
  cost: GoalCost
  /** The newest published update, or null. */
  lastUpdateAt: number | null
  /** Active, and no update published within `updateCadenceDays`. */
  updateMissing: boolean
  /** Drafts waiting for a person. */
  draftCount: number
  childCount: number
}

export interface GoalUpdate {
  id: string
  goalId: string
  teamId: string
  /** Markdown. */
  body: string
  health: GoalHealth | null
  author: HomeActor | null
  /** The run that drafted it, when an agent's run did. */
  executionId: string | null
  state: GoalUpdateState
  publishedBy: HomeActor | null
  publishedAt: number | null
  createdAt: number
}

/** One change of a goal's health. */
export interface GoalHealthChange {
  health: GoalHealth | null
  setBy: HomeActor | null
  setAt: number
  /** The update whose publishing set it, or null for a direct set. */
  updateId: string | null
}

export interface TeamKpi {
  id: string
  teamId: string
  goalId: string | null
  name: string
  /** Free text: '', '$', '%', 'signups'. */
  unit: string
  direction: KpiDirection
  target: number | null
  period: KpiPeriod
  source: KpiSource
  /** The metric read when `source` is `computed`, else null. */
  metric: HomeComputedMetric | null
  /** Agent source: the one agent who may report it; null means any agent on the team. */
  reporterAgentId: string | null
  /** Agent and person sources: a value older than this is stale. Null: never stale. */
  staleAfterHours: number | null
  status: KpiStatus
  /** Who suggested it, for a KPI an agent suggested. */
  suggestedBy: HomeActor | null
  /** Why the agent suggested it. */
  suggestionNote: string | null
  createdBy: HomeActor | null
  position: number
  createdAt: number
  updatedAt: number
}

export interface KpiValue {
  id: string
  kpiId: string
  value: number
  asOf: number
  reportedBy: HomeActor | null
  /** The run that reported it, for an agent's value. */
  executionId: string | null
  /** The task the reporting run was on. */
  taskId: string | null
  sourceUrl: string | null
  note: string | null
  createdAt: number
}

/** A KPI's current value and where it came from. */
export interface KpiReading {
  /** Null when there is no value yet. */
  value: number | null
  asOf: number | null
  source: KpiSource
  /** For a computed reading: the start of the period it covers (null for all time
   *  and for point-in-time metrics). */
  periodStart: number | null
  /** The stored value behind an agent or person reading; null for computed. */
  latest: KpiValue | null
  /** `ok`, `stale` (older than `staleAfterHours`) or `missing` (no value yet).
   *  A computed reading is always `ok`. */
  freshness: 'ok' | 'stale' | 'missing'
}

export interface KpiTile {
  kpi: TeamKpi
  reading: KpiReading
}

export interface TeamPage {
  id: string
  teamId: string
  goalId: string | null
  /** The newest revision's title. */
  title: string
  pinned: boolean
  archivedAt: number | null
  createdAt: number
  updatedAt: number
  /** The newest revision number. */
  revision: number
  /** Who wrote the newest revision. */
  updatedBy: HomeActor | null
}

/** A revision without its words: what the revision list returns. */
export interface TeamPageRevisionMeta {
  id: string
  pageId: string
  /** 1, 2, 3 for a page. Nothing is overwritten: a revert is a new revision. */
  revision: number
  title: string
  /** How long its body is, in characters. */
  bodyChars: number
  author: HomeActor | null
  executionId: string | null
  /** The revision this one copied, for a revert. */
  revertedFrom: number | null
  createdAt: number
}

/** One revision with its words (`getPageRevision`). */
export interface TeamPageRevision extends TeamPageRevisionMeta {
  /** Markdown. */
  body: string
}

/** A page of the revision list, newest first. */
export interface TeamPageRevisionList {
  revisions: TeamPageRevisionMeta[]
  /** Pass as `before` for the next, older page; null when there is none. */
  nextBefore: number | null
}

export interface TeamPageWithBody extends TeamPage {
  body: string
}

// ─── Status line ─────────────────────────────────────────────────────────────

/** The numbers behind a team's computed status line. */
export interface HomeStatusFacts {
  /** People's requests (main tasks) still open. */
  requestsInFlight: number
  needsYou: number
  /** Tasks moved to Done in the last 7 days. */
  doneLast7Days: number
  /** The team's run cost in the last 7 days. */
  spentLast7DaysUsd: number
  /** The team budget's limit and spend, when it has one. */
  budgetLimitUsd: number | null
  budgetSpentUsd: number | null
}

export interface HomeStatusLine {
  text: string
  /** `computed`: made from `facts` on read. `lead`: the team lead wrote it. */
  source: 'computed' | 'lead'
  asOf: number
  /** The lead, for a written line. */
  author: HomeActor | null
  executionId: string | null
  model: string | null
  facts: HomeStatusFacts
}

// ─── Sections of a team's Home ───────────────────────────────────────────────

export interface HomeTeamRef {
  id: string
  name: string
  icon: string | null
  color: string | null
  leaderAgentId: string | null
}

/** A task waiting on a person (the Board's Needs you reasons). */
export interface HomeNeedsYouTask {
  taskId: string
  identifier: string | null
  title: string
  teamId: string | null
  /** The board's attention reason: failed, timed_out, stopped, needs_review,
   *  blocked, unassigned, unstarted, and the others the Board shows. */
  reason: string
}

export interface HomeNeedsYouDraft {
  updateId: string
  goalId: string
  goalTitle: string
  teamId: string
  author: HomeActor | null
  createdAt: number
}

export interface HomeNeedsYouSuggestion {
  kpiId: string
  name: string
  teamId: string
  goalId: string | null
  suggestedBy: HomeActor | null
  note: string | null
  createdAt: number
}

export interface HomeNeedsYou {
  /** Everything below, counted once each. */
  total: number
  tasks: HomeNeedsYouTask[]
  /** Tool approvals waiting, for agents on the team(s). */
  approvals: number
  /** Agents' questions to a person still unanswered. */
  questions: number
  draftUpdates: HomeNeedsYouDraft[]
  suggestedKpis: HomeNeedsYouSuggestion[]
}

/** A person's request still open, with how far its work has got. */
export interface HomeInFlightRequest {
  taskId: string
  identifier: string | null
  title: string
  status: string
  goalId: string | null
  leadAgentId: string | null
  /** Work filed under it, at any depth. */
  subtaskCount: number
  subtasksDone: number
  createdAt: number
  updatedAt: number
}

export interface HomeSpend {
  /** Run cost in the last 7 and 30 days. */
  last7DaysUsd: number
  last30DaysUsd: number
  /** True when any of it is an estimate. */
  includesEstimates: boolean
  /** The team's budget, when it has one. */
  budget: {
    limitUsd: number
    spentUsd: number
    /** `warn` or `cap`. */
    mode: string
    /** `active`, or `paused` once a cap stopped runs. */
    status: string
  } | null
}

export interface HomeUpcomingRoutine {
  id: string
  /** The routine's title. */
  name: string
  /** `team` or `agent`. */
  target: string
  agentId: string | null
  nextRunAt: number
  status: string
}

/** A file an agent's work left in a task's folder or worktree. Open it through
 *  the board's folder routes (`GET /api/board/:taskId/folder/file?path=`). */
export interface HomeRecentFile {
  taskId: string
  taskIdentifier: string | null
  taskTitle: string
  /** Relative to the task's folder. */
  path: string
  sizeBytes: number
  modifiedAt: number
}

/**
 * Why a team's lead cannot write the status line:
 * - `no_lead`: the team has no lead.
 * - `openclaw_lead`: an OpenClaw lead's Tasks tools carry no identity, so they never
 *   include `write_home_summary`.
 * - `tasks_read_only`: a Clawboo native lead whose board access is read-only (the
 *   native default). Full board access in its settings gives it the tool.
 * - `tasks_off`: a Clawboo native lead with board access off.
 */
export type LeadCannotWriteReason = 'no_lead' | 'openclaw_lead' | 'tasks_read_only' | 'tasks_off'

export interface TeamHomeSettings {
  /** The team lead writes the status line (costs model calls). Off by default. */
  leadWritesStatus: boolean
  /** Whether the team's lead can write it at all: only a lead whose Tasks tools are
   *  bound to it and not read-only is offered `write_home_summary`. Turning the line
   *  on for a team whose lead cannot answers 409 `lead_cannot_write`. */
  leadCanWriteStatus: boolean
  /** Why not, when `leadCanWriteStatus` is false; null when it is true. */
  leadCannotWriteReason: LeadCannotWriteReason | null
  /** The routine that asks the lead for weekly goal updates, when turned on. */
  weeklyUpdatesRoutineId: string | null
}

export interface TeamHome {
  team: HomeTeamRef
  asOf: number
  status: HomeStatusLine
  settings: TeamHomeSettings
  needsYou: HomeNeedsYou
  /** Active goals, by position. */
  goals: GoalSummary[]
  /** Active KPIs, by position. */
  kpis: KpiTile[]
  inFlight: HomeInFlightRequest[]
  spend: HomeSpend
  routines: HomeUpcomingRoutine[]
  /** Pinned pages that are not archived. */
  pinnedPages: TeamPage[]
  /** Up to 8 files from the top of the folders of the team's most recently changed
   *  tasks, the most recently modified first. Each folder's first 40 entries by name
   *  are read, so this is not a search for the newest file anywhere. */
  recentFiles: HomeRecentFile[]
}

/** One team's headline numbers on the All teams Home. */
export interface AllTeamsHomeRow {
  team: HomeTeamRef
  status: HomeStatusLine
  goals: GoalSummary[]
  /** The first few active KPIs, by position. */
  kpis: KpiTile[]
  needsYouCount: number
  spend: HomeSpend
}

export interface AllTeamsHome {
  asOf: number
  teams: AllTeamsHomeRow[]
  totals: {
    requestsInFlight: number
    needsYou: number
    doneLast7Days: number
    spentLast7DaysUsd: number
    goalsActive: number
    goalsAtRisk: number
    goalsOffTrack: number
  }
  /** Needs you across every team. */
  needsYou: HomeNeedsYou
}

export type HomeResponse = { scope: 'team'; home: TeamHome } | { scope: 'all'; home: AllTeamsHome }

// ─── A goal's own page ───────────────────────────────────────────────────────

/** How a task reaches the goal it counts toward: its own `goalId`, its request's
 *  (the main task above it), or a parent's between. */
export type GoalLinkVia = 'own' | 'request' | 'parent'

/**
 * What board task rows (`GET /api/board`, `GET /api/board/:taskId`) and board change
 * frames carry about a task's goal. `goalId` is what the task itself stores (null for
 * none of its own); `effectiveGoalId` is the goal it counts toward, the one the goal
 * page and its progress use. Show a goal chip and filter "No goal" by
 * `effectiveGoalId`; edit with `setTaskGoal`.
 */
export interface BoardTaskGoal {
  goalId: string | null
  effectiveGoalId: string | null
  goalLinkedVia: GoalLinkVia | null
}

export interface GoalTask {
  taskId: string
  identifier: string | null
  title: string
  status: string
  isMainTask: boolean
  assigneeAgentId: string | null
  costUsd: number
  /** True when the check passed, false when it failed, null with no check. */
  checked: boolean | null
  /** How the task reaches the goal: its own `goalId`, its request's, or a parent's. */
  linkedVia: GoalLinkVia
  dropped: boolean
  createdAt: number
  completedAt: number | null
}

export interface GoalDetail {
  summary: GoalSummary
  parent: { id: string; title: string } | null
  children: GoalSummary[]
  healthHistory: GoalHealthChange[]
  tasks: GoalTask[]
  kpis: KpiTile[]
  /** Newest first: drafts, published and discarded. */
  updates: GoalUpdate[]
  pages: TeamPage[]
}

// ─── Inputs ──────────────────────────────────────────────────────────────────

export interface CreateGoalInput {
  title: string
  description?: string
  parentGoalId?: string | null
  owner?: HomeActor | null
  targetDate?: number | null
  updateCadenceDays?: number
}

export interface UpdateGoalInput {
  title?: string
  description?: string
  parentGoalId?: string | null
  owner?: HomeActor | null
  targetDate?: number | null
  status?: GoalStatus
  updateCadenceDays?: number
}

export interface CreateKpiInput {
  name: string
  unit?: string
  direction?: KpiDirection
  target?: number | null
  period?: KpiPeriod
  source: KpiSource
  /** Required when `source` is `computed`. */
  metric?: HomeComputedMetric | null
  goalId?: string | null
  reporterAgentId?: string | null
  staleAfterHours?: number | null
}

export type UpdateKpiInput = Partial<CreateKpiInput>

export interface AddKpiValueInput {
  value: number
  /** Defaults to now. */
  asOf?: number
  note?: string | null
  sourceUrl?: string | null
}

export interface CreatePageInput {
  title: string
  body?: string
  goalId?: string | null
  pinned?: boolean
}

export interface UpdatePageInput {
  /** A new title or body makes a new revision. */
  title?: string
  body?: string
  goalId?: string | null
}

export interface PublishGoalUpdateInput {
  /** An edit made before publishing. */
  body?: string
  health?: GoalHealth | null
}

export interface CreateGoalUpdateInput {
  body: string
  health?: GoalHealth | null
}

// ─── Calls ───────────────────────────────────────────────────────────────────

/** Why a Home call failed: the HTTP status and the server's error code. */
export class HomeRequestError extends Error {
  readonly status: number
  readonly code: string | null
  constructor(what: string, status: number, code: string | null) {
    super(`${what} failed (${status})${code ? `: ${code}` : ''}`)
    this.name = 'HomeRequestError'
    this.status = status
    this.code = code
  }
}

async function jsonOrThrow<T>(res: Response, what: string): Promise<T> {
  if (!res.ok) {
    let code: string | null = null
    try {
      const body = (await res.json()) as { error?: unknown }
      code = typeof body.error === 'string' ? body.error : null
    } catch {
      /* non-JSON error body */
    }
    throw new HomeRequestError(what, res.status, code)
  }
  return (await res.json()) as T
}

const JSON_HEADERS = { 'Content-Type': 'application/json' } as const

function send(path: string, method: string, body?: unknown): Promise<Response> {
  return apiFetch(path, {
    method,
    ...(body === undefined ? {} : { headers: JSON_HEADERS, body: JSON.stringify(body) }),
  })
}

const enc = encodeURIComponent

function teamPath(teamId: string, rest = ''): string {
  return `/api/home/teams/${enc(teamId)}${rest}`
}

function withQuery(path: string, query: Record<string, string | undefined>): string {
  const params = new URLSearchParams()
  for (const [k, v] of Object.entries(query)) if (v !== undefined) params.set(k, v)
  const qs = params.toString()
  return qs ? `${path}?${qs}` : path
}

/** `GET /api/home?teamId=`: one team's Home, or All teams with no team (or `'all'`). */
export async function fetchHome(teamId?: string | null): Promise<HomeResponse> {
  const team = teamId && teamId !== 'all' ? teamId : undefined
  const res = await apiFetch(withQuery('/api/home', { teamId: team }))
  return jsonOrThrow<HomeResponse>(res, 'Load Home')
}

// Goals

export async function listGoals(
  teamId: string,
  opts: { includeArchived?: boolean } = {},
): Promise<GoalSummary[]> {
  const res = await apiFetch(
    withQuery(teamPath(teamId, '/goals'), {
      includeArchived: opts.includeArchived ? 'true' : undefined,
    }),
  )
  return (await jsonOrThrow<{ goals: GoalSummary[] }>(res, 'List goals')).goals
}

/** A goal's own page. Null for a goal that is not on this team. */
export async function getGoal(teamId: string, goalId: string): Promise<GoalDetail | null> {
  const res = await apiFetch(teamPath(teamId, `/goals/${enc(goalId)}`))
  if (res.status === 404) return null
  return (await jsonOrThrow<{ goal: GoalDetail }>(res, 'Load goal')).goal
}

export async function createGoal(teamId: string, input: CreateGoalInput): Promise<TeamGoal> {
  const res = await send(teamPath(teamId, '/goals'), 'POST', input)
  return (await jsonOrThrow<{ goal: TeamGoal }>(res, 'Create goal')).goal
}

export async function updateGoal(
  teamId: string,
  goalId: string,
  input: UpdateGoalInput,
): Promise<TeamGoal> {
  const res = await send(teamPath(teamId, `/goals/${enc(goalId)}`), 'PATCH', input)
  return (await jsonOrThrow<{ goal: TeamGoal }>(res, 'Update goal')).goal
}

/** Archives the goal. Its tasks keep their link; its child goals lose their parent. */
export async function archiveGoal(teamId: string, goalId: string): Promise<TeamGoal> {
  const res = await send(teamPath(teamId, `/goals/${enc(goalId)}`), 'DELETE')
  return (await jsonOrThrow<{ goal: TeamGoal }>(res, 'Archive goal')).goal
}

/** A person sets a goal's health directly (null clears it). */
export async function setGoalHealth(
  teamId: string,
  goalId: string,
  health: GoalHealth | null,
): Promise<TeamGoal> {
  const res = await send(teamPath(teamId, `/goals/${enc(goalId)}/health`), 'POST', { health })
  return (await jsonOrThrow<{ goal: TeamGoal }>(res, 'Set goal health')).goal
}

/** The team's goals in this order; goals not named keep their order after them. */
export async function reorderGoals(teamId: string, goalIds: string[]): Promise<TeamGoal[]> {
  const res = await send(teamPath(teamId, '/goals/reorder'), 'POST', { goalIds })
  return (await jsonOrThrow<{ goals: TeamGoal[] }>(res, 'Reorder goals')).goals
}

// Goal updates

export async function listGoalUpdates(teamId: string, goalId: string): Promise<GoalUpdate[]> {
  const res = await apiFetch(teamPath(teamId, `/goals/${enc(goalId)}/updates`))
  return (await jsonOrThrow<{ updates: GoalUpdate[] }>(res, 'List goal updates')).updates
}

/** A person writes an update; it is published at once. */
export async function createGoalUpdate(
  teamId: string,
  goalId: string,
  input: CreateGoalUpdateInput,
): Promise<{ update: GoalUpdate; goal: TeamGoal }> {
  const res = await send(teamPath(teamId, `/goals/${enc(goalId)}/updates`), 'POST', input)
  return jsonOrThrow<{ update: GoalUpdate; goal: TeamGoal }>(res, 'Post goal update')
}

/** Publish a draft, edited first when `input` says so. A health on it sets the goal's. */
export async function publishGoalUpdate(
  teamId: string,
  updateId: string,
  input: PublishGoalUpdateInput = {},
): Promise<{ update: GoalUpdate; goal: TeamGoal }> {
  const res = await send(teamPath(teamId, `/updates/${enc(updateId)}/publish`), 'POST', input)
  return jsonOrThrow<{ update: GoalUpdate; goal: TeamGoal }>(res, 'Publish goal update')
}

export async function discardGoalUpdate(teamId: string, updateId: string): Promise<GoalUpdate> {
  const res = await send(teamPath(teamId, `/updates/${enc(updateId)}/discard`), 'POST')
  return (await jsonOrThrow<{ update: GoalUpdate }>(res, 'Discard goal update')).update
}

// KPIs

/** Active KPIs with their readings, plus suggested ones (and archived, if asked). */
export async function listKpis(
  teamId: string,
  opts: { includeArchived?: boolean } = {},
): Promise<KpiTile[]> {
  const res = await apiFetch(
    withQuery(teamPath(teamId, '/kpis'), {
      includeArchived: opts.includeArchived ? 'true' : undefined,
    }),
  )
  return (await jsonOrThrow<{ kpis: KpiTile[] }>(res, 'List KPIs')).kpis
}

export async function createKpi(teamId: string, input: CreateKpiInput): Promise<KpiTile> {
  const res = await send(teamPath(teamId, '/kpis'), 'POST', input)
  return (await jsonOrThrow<{ kpi: KpiTile }>(res, 'Create KPI')).kpi
}

export async function updateKpi(
  teamId: string,
  kpiId: string,
  input: UpdateKpiInput,
): Promise<KpiTile> {
  const res = await send(teamPath(teamId, `/kpis/${enc(kpiId)}`), 'PATCH', input)
  return (await jsonOrThrow<{ kpi: KpiTile }>(res, 'Update KPI')).kpi
}

export async function archiveKpi(teamId: string, kpiId: string): Promise<TeamKpi> {
  const res = await send(teamPath(teamId, `/kpis/${enc(kpiId)}`), 'DELETE')
  return (await jsonOrThrow<{ kpi: TeamKpi }>(res, 'Archive KPI')).kpi
}

/** Accept an agent's suggestion, with a person's edits (a target, a source). */
export async function acceptKpiSuggestion(
  teamId: string,
  kpiId: string,
  edits: UpdateKpiInput = {},
): Promise<KpiTile> {
  const res = await send(teamPath(teamId, `/kpis/${enc(kpiId)}/accept`), 'POST', edits)
  return (await jsonOrThrow<{ kpi: KpiTile }>(res, 'Accept KPI suggestion')).kpi
}

export async function dismissKpiSuggestion(teamId: string, kpiId: string): Promise<TeamKpi> {
  const res = await send(teamPath(teamId, `/kpis/${enc(kpiId)}/dismiss`), 'POST')
  return (await jsonOrThrow<{ kpi: TeamKpi }>(res, 'Dismiss KPI suggestion')).kpi
}

/** A person types a value. Only for an active KPI whose source is `person`. */
export async function addKpiValue(
  teamId: string,
  kpiId: string,
  input: AddKpiValueInput,
): Promise<{ value: KpiValue; kpi: KpiTile }> {
  const res = await send(teamPath(teamId, `/kpis/${enc(kpiId)}/values`), 'POST', input)
  return jsonOrThrow<{ value: KpiValue; kpi: KpiTile }>(res, 'Add KPI value')
}

/** Stored values, newest first (none for a computed KPI). */
export async function listKpiValues(
  teamId: string,
  kpiId: string,
  opts: { limit?: number } = {},
): Promise<KpiValue[]> {
  const res = await apiFetch(
    withQuery(teamPath(teamId, `/kpis/${enc(kpiId)}/values`), {
      limit: opts.limit !== undefined ? String(opts.limit) : undefined,
    }),
  )
  return (await jsonOrThrow<{ values: KpiValue[] }>(res, 'List KPI values')).values
}

// Pages

export async function listPages(
  teamId: string,
  opts: { includeArchived?: boolean; goalId?: string } = {},
): Promise<TeamPage[]> {
  const res = await apiFetch(
    withQuery(teamPath(teamId, '/pages'), {
      includeArchived: opts.includeArchived ? 'true' : undefined,
      goalId: opts.goalId,
    }),
  )
  return (await jsonOrThrow<{ pages: TeamPage[] }>(res, 'List pages')).pages
}

export async function getPage(teamId: string, pageId: string): Promise<TeamPageWithBody | null> {
  const res = await apiFetch(teamPath(teamId, `/pages/${enc(pageId)}`))
  if (res.status === 404) return null
  return (await jsonOrThrow<{ page: TeamPageWithBody }>(res, 'Load page')).page
}

export async function createPage(
  teamId: string,
  input: CreatePageInput,
): Promise<TeamPageWithBody> {
  const res = await send(teamPath(teamId, '/pages'), 'POST', input)
  return (await jsonOrThrow<{ page: TeamPageWithBody }>(res, 'Create page')).page
}

export async function updatePage(
  teamId: string,
  pageId: string,
  input: UpdatePageInput,
): Promise<TeamPageWithBody> {
  const res = await send(teamPath(teamId, `/pages/${enc(pageId)}`), 'PATCH', input)
  return (await jsonOrThrow<{ page: TeamPageWithBody }>(res, 'Update page')).page
}

/**
 * Revisions newest first, without their words, a page at a time: up to `limit`
 * (default 50, at most 200) older than `before`. Fetch one revision's words with
 * `getPageRevision`.
 */
export async function listPageRevisions(
  teamId: string,
  pageId: string,
  opts: { before?: number; limit?: number } = {},
): Promise<TeamPageRevisionList> {
  const res = await apiFetch(
    withQuery(teamPath(teamId, `/pages/${enc(pageId)}/revisions`), {
      before: opts.before !== undefined ? String(opts.before) : undefined,
      limit: opts.limit !== undefined ? String(opts.limit) : undefined,
    }),
  )
  return jsonOrThrow<TeamPageRevisionList>(res, 'List page revisions')
}

/** One revision with its words, or null when the page has no such revision. */
export async function getPageRevision(
  teamId: string,
  pageId: string,
  revision: number,
): Promise<TeamPageRevision | null> {
  const res = await apiFetch(teamPath(teamId, `/pages/${enc(pageId)}/revisions/${revision}`))
  if (res.status === 404) return null
  return (await jsonOrThrow<{ revision: TeamPageRevision }>(res, 'Load page revision')).revision
}

/** A new revision that copies `revision`. */
export async function revertPage(
  teamId: string,
  pageId: string,
  revision: number,
): Promise<TeamPageWithBody> {
  const res = await send(teamPath(teamId, `/pages/${enc(pageId)}/revert`), 'POST', { revision })
  return (await jsonOrThrow<{ page: TeamPageWithBody }>(res, 'Revert page')).page
}

export async function setPagePinned(
  teamId: string,
  pageId: string,
  pinned: boolean,
): Promise<TeamPage> {
  const res = await send(teamPath(teamId, `/pages/${enc(pageId)}/pin`), 'POST', { pinned })
  return (await jsonOrThrow<{ page: TeamPage }>(res, 'Pin page')).page
}

export async function archivePage(teamId: string, pageId: string): Promise<TeamPage> {
  const res = await send(teamPath(teamId, `/pages/${enc(pageId)}`), 'DELETE')
  return (await jsonOrThrow<{ page: TeamPage }>(res, 'Archive page')).page
}

// Team settings and the weekly routine

export async function getTeamHomeSettings(teamId: string): Promise<TeamHomeSettings> {
  const res = await apiFetch(teamPath(teamId, '/settings'))
  return (await jsonOrThrow<{ settings: TeamHomeSettings }>(res, 'Load Home settings')).settings
}

/**
 * Turn the lead-written status line on or off. Turning it on for a team whose lead
 * cannot write it (`leadCanWriteStatus` false) answers 409 `lead_cannot_write`.
 */
export async function updateTeamHomeSettings(
  teamId: string,
  input: { leadWritesStatus: boolean },
): Promise<TeamHomeSettings> {
  const res = await send(teamPath(teamId, '/settings'), 'PUT', input)
  return (await jsonOrThrow<{ settings: TeamHomeSettings }>(res, 'Save Home settings')).settings
}

/**
 * "Turn on weekly updates": a normal team routine, weekly in the routines' time
 * zone, that asks the lead to draft an update for each active goal. Repeating it
 * returns the routine already made. Turn it off from Routines like any other.
 */
export async function turnOnWeeklyUpdates(
  teamId: string,
): Promise<{ routineId: string; settings: TeamHomeSettings; created: boolean }> {
  const res = await send(teamPath(teamId, '/weekly-updates'), 'POST')
  return jsonOrThrow<{ routineId: string; settings: TeamHomeSettings; created: boolean }>(
    res,
    'Turn on weekly updates',
  )
}

// Board links

/**
 * Link a task to a goal on its own team, or take it off every goal with null (its
 * request's included; the work under it follows): `PATCH /api/board/:taskId` with
 * `goalId`. `POST /api/board` (the New task dialog) and a team chat message
 * (`goalId` on the send, for the request's main task) take `goalId` too. Board task
 * rows and board change frames carry `BoardTaskGoal`.
 */
export async function setTaskGoal(taskId: string, goalId: string | null): Promise<void> {
  const res = await send(`/api/board/${enc(taskId)}`, 'PATCH', { goalId })
  await jsonOrThrow<unknown>(res, 'Set task goal')
}
