// Home's closed lists, the people and agents its rows record, and the limits its
// writes keep. The REST answers and @clawboo/control-client's home.ts use the same
// lists; the server's contract test checks the two stay equal.

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

/** The metrics a computed KPI reads (see metrics.ts for what each counts). */
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

/** Metrics that read the state now and ignore the KPI's period. */
export const HOME_POINT_IN_TIME_METRICS: readonly HomeComputedMetric[] = [
  'budget_used_pct',
  'needs_you_count',
  'open_requests',
]

export const DAY_MS = 24 * 60 * 60 * 1000

/** How far back each period reaches; null for all time. */
export const KPI_PERIOD_MS: Readonly<Record<KpiPeriod, number | null>> = {
  week: 7 * DAY_MS,
  month: 30 * DAY_MS,
  quarter: 90 * DAY_MS,
  all: null,
}

// ─── Limits ──────────────────────────────────────────────────────────────────
// Agents write through tools, and a looping agent must not fill the database, so
// each agent-reachable write has a ceiling; a person's writes share the size caps.

export const HOME_TITLE_MAX_CHARS = 200
export const HOME_DESCRIPTION_MAX_CHARS = 20_000
export const GOAL_UPDATE_MAX_CHARS = 20_000
export const PAGE_BODY_MAX_CHARS = 200_000
export const KPI_NOTE_MAX_CHARS = 2_000
export const KPI_UNIT_MAX_CHARS = 40
export const SOURCE_URL_MAX_CHARS = 2_000
export const HOME_SUMMARY_MAX_CHARS = 400

/** Goals a team may have that are not archived. */
export const MAX_GOALS_PER_TEAM = 100
/** KPIs a team may have that are active or suggested. */
export const MAX_KPIS_PER_TEAM = 60
/** Suggestions waiting for a person, per team. */
export const MAX_OPEN_KPI_SUGGESTIONS = 10
/** Pages a team may have that are not archived. */
export const MAX_PAGES_PER_TEAM = 300
/** Revisions one page may have. */
export const MAX_PAGE_REVISIONS = 500
/** Drafts waiting on one goal. */
export const MAX_OPEN_DRAFTS_PER_GOAL = 5
/** Values one KPI may take in a rolling day. */
export const MAX_KPI_VALUES_PER_DAY = 100
/** The longest cadence a goal may ask for. */
export const MAX_UPDATE_CADENCE_DAYS = 365

// ─── People and agents ───────────────────────────────────────────────────────

/** Who did something on Home: a person (from the person check) or an agent. */
export interface HomeActor {
  kind: 'person' | 'agent'
  id: string
  name: string | null
}

const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v !== ''

/** The column value for an actor, or null for none. */
export function actorJson(actor: HomeActor | null | undefined): string | null {
  if (!actor || !nonEmpty(actor.id) || (actor.kind !== 'person' && actor.kind !== 'agent')) {
    return null
  }
  return JSON.stringify({ kind: actor.kind, id: actor.id, name: actor.name ?? null })
}

/** The actor a column holds, or null for none or anything unreadable. */
export function parseActor(raw: string | null | undefined): HomeActor | null {
  if (!raw) return null
  try {
    const doc = JSON.parse(raw) as Record<string, unknown> | null
    const kind = doc?.['kind']
    const id = doc?.['id']
    if ((kind !== 'person' && kind !== 'agent') || !nonEmpty(id)) return null
    const name = doc?.['name']
    return { kind, id, name: nonEmpty(name) ? name : null }
  } catch {
    return null
  }
}

/** A refused Home write, as data (never thrown for a policy reason). */
export type HomeRefusal =
  | 'team_not_found'
  | 'goal_not_found'
  | 'update_not_found'
  | 'kpi_not_found'
  | 'page_not_found'
  | 'revision_not_found'
  | 'invalid_parent'
  | 'parent_has_parent'
  | 'goal_has_children'
  | 'goal_other_team'
  | 'goal_archived'
  | 'empty'
  | 'too_long'
  | 'invalid'
  | 'too_many'
  | 'not_draft'
  | 'not_suggested'
  | 'not_active'
  | 'wrong_source'
  | 'not_reporter'
  | 'archived'

export type HomeResult<T> = { ok: true; value: T } | { ok: false; reason: HomeRefusal }

export function refuse<T>(reason: HomeRefusal): HomeResult<T> {
  return { ok: false, reason }
}

export function done<T>(value: T): HomeResult<T> {
  return { ok: true, value }
}

/** Trim a title, or null when it is empty or too long. */
export function cleanTitle(
  raw: unknown,
): { ok: true; title: string } | { ok: false; reason: 'empty' | 'too_long' } {
  const title = typeof raw === 'string' ? raw.trim() : ''
  if (!title) return { ok: false, reason: 'empty' }
  if (title.length > HOME_TITLE_MAX_CHARS) return { ok: false, reason: 'too_long' }
  return { ok: true, title }
}
