// The Board's Find popover, as a pure model: which tasks and routines a query
// matches, how well they match, and whether each task is in the range the board
// shows or sits before or after it. No React and no stores: the caller passes in
// everything it needs, so the node test project covers it.
//
// Matching is all-tokens: every word of the query has to appear somewhere on the
// task. The weakest word decides the score, so a query whose words are all in
// the title outranks one that only reaches a description.

import type { BoardTask } from '@/lib/boardClient'
import type { RoutineOccurrences } from '@/lib/schedulesClient'

import { isFinishedStatus, rangeContains, taskPlacedAt, type CalendarRange } from './calendarModel'

export type FindWhere = 'here' | 'before' | 'after'
export type FindField = 'title' | 'agent' | 'description' | 'id'

export interface FindTaskResult {
  kind: 'task'
  id: string
  task: BoardTask
  /** The column the task is drawn in. */
  column: string
  /** The instant that places it on a day, or null when it carries none. */
  at: number | null
  where: FindWhere
  /** The field that decided the score. */
  matchedOn: FindField
  score: number
}

export interface FindRoutineResult {
  kind: 'routine'
  id: string
  routine: RoutineOccurrences
  name: string
  score: number
}

export type FindResult = FindTaskResult | FindRoutineResult

export interface FindInput {
  tasks: readonly BoardTask[]
  /** The column a task is drawn in; `'needs_you'` for Needs you. */
  columnOf: (task: BoardTask) => string
  /** The agent a task belongs to. */
  ownerOf: (task: BoardTask) => string | null
  agentName: (agentId: string) => string | null
  routines: readonly RoutineOccurrences[]
  routineName: (routine: RoutineOccurrences) => string
  /** Null for the All view, which shows every task. */
  range: CalendarRange | null
  /** True when open work from before the range shows in an Earlier row. */
  showEarlier: boolean
  now: number
}

/** How many results the popover lists before it says there are more. */
export const FIND_LIMIT = 8

/** Lowercase, accents dropped, trimmed, runs of whitespace as one space. */
export function normalizeQuery(q: string): string {
  return q.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim().replace(/\s+/g, ' ')
}

// A task's words are normalized once, not on every keystroke and every read of
// the board. Bounded: emptied when it grows past what any board holds.
const normalizedText = new Map<string, string>()
const NORMALIZED_MAX = 5000

function normalizedOf(text: string): string {
  let out = normalizedText.get(text)
  if (out === undefined) {
    if (normalizedText.size >= NORMALIZED_MAX) normalizedText.clear()
    out = normalizeQuery(text)
    normalizedText.set(text, out)
  }
  return out
}

/**
 * Whether a task is in the range shown (its Earlier row included), or before or
 * after it. Needs you sits in today's row, so it is in the range exactly when
 * today is.
 */
export function whereOf(
  task: BoardTask,
  column: string,
  input: Pick<FindInput, 'range' | 'showEarlier' | 'now'>,
): FindWhere {
  const { range, showEarlier, now } = input
  if (!range) return 'here'
  if (column === 'needs_you') {
    if (rangeContains(range, now)) return 'here'
    return range.start > now ? 'before' : 'after'
  }
  const at = taskPlacedAt(task) ?? now
  if (rangeContains(range, at)) return 'here'
  if (at < range.start) return !isFinishedStatus(task.status) && showEarlier ? 'here' : 'before'
  return 'after'
}

// ─── Matching ───────────────────────────────────────────────────────────────

// Field scores per token. Any title hit outranks every other field, and the
// tiers never tie across fields, so a token's best field is never ambiguous.
const TITLE_START = 100
const TITLE_WORD = 80
const TITLE_CONTAINS = 60
const AGENT_WORD = 45
const AGENT_CONTAINS = 35
const ID_PREFIX = 30
const DESCRIPTION_CONTAINS = 20

/** Ids are long and random, so a short token would match them by chance. */
const ID_MIN_TOKEN = 4

const WORD_CHAR = /[\p{L}\p{N}]/u

/**
 * How well `token` sits in `text`: `start` at the very beginning, `word` at the
 * start of any later word, `contains` anywhere else, 0 when absent.
 */
function textScore(text: string, token: string, start: number, word: number, contains: number) {
  let idx = text.indexOf(token)
  if (idx < 0) return 0
  if (idx === 0) return start
  while (idx >= 0) {
    if (!WORD_CHAR.test(text[idx - 1]!)) return word
    idx = text.indexOf(token, idx + 1)
  }
  return contains
}

interface TaskText {
  title: string
  agent: string
  description: string
  id: string
}

/** A token's best field on a task, or null when no field holds it. */
function bestField(token: string, text: TaskText): { score: number; field: FindField } | null {
  const title = textScore(text.title, token, TITLE_START, TITLE_WORD, TITLE_CONTAINS)
  if (title > 0) return { score: title, field: 'title' }
  const agent = textScore(text.agent, token, AGENT_WORD, AGENT_WORD, AGENT_CONTAINS)
  if (agent > 0) return { score: agent, field: 'agent' }
  if (token.length >= ID_MIN_TOKEN && text.id.startsWith(token)) {
    return { score: ID_PREFIX, field: 'id' }
  }
  if (text.description.includes(token)) return { score: DESCRIPTION_CONTAINS, field: 'description' }
  return null
}

function matchTask(
  tokens: readonly string[],
  text: TaskText,
): { score: number; matchedOn: FindField } | null {
  let weakest: { score: number; field: FindField } | null = null
  let allInTitle = true
  for (const token of tokens) {
    const best = bestField(token, text)
    if (!best) return null
    if (!text.title.includes(token)) allInTitle = false
    if (!weakest || best.score < weakest.score) weakest = best
  }
  if (!weakest) return null
  return { score: weakest.score, matchedOn: allInTitle ? 'title' : weakest.field }
}

/** A routine matches on its name alone, scored like a task title. */
function matchName(tokens: readonly string[], name: string): number | null {
  let weakest: number | null = null
  for (const token of tokens) {
    const score = textScore(name, token, TITLE_START, TITLE_WORD, TITLE_CONTAINS)
    if (score === 0) return null
    if (weakest === null || score < weakest) weakest = score
  }
  return weakest
}

// ─── Results ────────────────────────────────────────────────────────────────

const WHERE_RANK: Record<FindWhere, number> = { here: 0, before: 1, after: 2 }

function rankOf(r: FindResult): number {
  return r.kind === 'task' ? WHERE_RANK[r.where] : WHERE_RANK.here
}

function atOf(r: FindResult): number | null {
  return r.kind === 'task' ? r.at : null
}

function titleOf(r: FindResult): string {
  return r.kind === 'task' ? (r.task.title ?? '') : r.name
}

/** Best score first, then the shown range before elsewhere, newest first, then by title. */
function compareResults(a: FindResult, b: FindResult): number {
  if (a.score !== b.score) return b.score - a.score
  const rank = rankOf(a) - rankOf(b)
  if (rank !== 0) return rank
  const atA = atOf(a)
  const atB = atOf(b)
  if (atA !== atB) {
    if (atA === null) return 1
    if (atB === null) return -1
    return atB - atA
  }
  const title = titleOf(a).localeCompare(titleOf(b), 'en', { sensitivity: 'base' })
  if (title !== 0) return title
  if (a.kind !== b.kind) return a.kind === 'task' ? -1 : 1
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

/** Every task and routine the query matches, best first; none for a blank query. */
export function matchBoard(query: string, input: FindInput): FindResult[] {
  const normalized = normalizeQuery(query)
  if (!normalized) return []
  const tokens = normalized.split(' ')
  const results: FindResult[] = []

  for (const task of input.tasks) {
    const owner = input.ownerOf(task)
    const text: TaskText = {
      title: normalizedOf(task.title ?? ''),
      agent: normalizedOf((owner && input.agentName(owner)) ?? ''),
      description: typeof task.description === 'string' ? normalizedOf(task.description) : '',
      id: task.id.toLowerCase(),
    }
    const match = matchTask(tokens, text)
    if (!match) continue
    const column = input.columnOf(task)
    results.push({
      kind: 'task',
      id: task.id,
      task,
      column,
      at: taskPlacedAt(task),
      where: whereOf(task, column, input),
      matchedOn: match.matchedOn,
      score: match.score,
    })
  }

  // The same routine can arrive once per window; list it once.
  const seen = new Set<string>()
  for (const routine of input.routines) {
    const id = routine.schedule.id
    if (seen.has(id)) continue
    seen.add(id)
    const name = input.routineName(routine)
    const score = matchName(tokens, normalizedOf(name))
    if (score === null) continue
    results.push({ kind: 'routine', id, routine, name, score })
  }

  return results.sort(compareResults)
}

export interface FindGroup {
  id: FindWhere | 'routines'
  label: string
  items: FindResult[]
}

const GROUP_ORDER: ReadonlyArray<FindGroup['id']> = ['here', 'before', 'after', 'routines']

/** What the board shows, for naming Find's sections: a day, week or month, or every task. */
export type FindScope = 'day' | 'week' | 'month' | 'all'

const SCOPE_LABELS: Record<FindScope, Record<FindGroup['id'], string>> = {
  all: { here: 'Tasks', before: 'Tasks', after: 'Tasks', routines: 'Routines' },
  day: { here: 'Today', before: 'Before today', after: 'After today', routines: 'Routines' },
  week: {
    here: 'In this week',
    before: 'Before this week',
    after: 'After this week',
    routines: 'Routines',
  },
  month: {
    here: 'In this month',
    before: 'Before this month',
    after: 'After this month',
    routines: 'Routines',
  },
}

/**
 * Results split into the popover's sections, keeping their order inside each:
 * the shown range (its Earlier row included), before it, after it, then
 * routines. Empty sections are left out. The All view has no range, so its
 * first section is just "Tasks".
 */
export function findGroups(results: readonly FindResult[], scope: FindScope): FindGroup[] {
  const labels = SCOPE_LABELS[scope]
  const byId = new Map<FindGroup['id'], FindResult[]>()
  for (const r of results) {
    const id = r.kind === 'task' ? r.where : 'routines'
    const list = byId.get(id)
    if (list) list.push(r)
    else byId.set(id, [r])
  }
  return GROUP_ORDER.filter((id) => byId.has(id)).map((id) => ({
    id,
    label: labels[id],
    items: byId.get(id)!,
  }))
}
