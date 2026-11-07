// A person's request on the board: its main task, with the helpers' work nested under
// it instead of a flat pile of top-level cards. Pure, so the board, the chat and the
// tests read one answer. A sub-task that needs a person is the exception: it stays in
// Needs you, labelled with its main task, because nothing that needs a person hides.

import { createContext } from 'react'

import { isPlanHolder, type TaskRunCost } from '@clawboo/board-core'

import type { BoardTask } from '@/lib/boardClient'

import { taskAttentionOf } from './boardStatus'
import { runCostOf } from './taskCost'

/** What a task needs for this. The board's rows and the chat's projection both fit. */
export interface NestableTask {
  id: string
  status: string
  parentTaskId?: unknown
  isMainTask?: unknown
  attention?: unknown
  waitingOn?: unknown
  createdAt?: unknown
  /** A board row says so through this, and a chat's view through `planHolder`. */
  sourceDelegationId?: unknown
  planHolder?: unknown
}

/** A card that only held a plan, once its plan is answered: the steps are the work, and
 *  a request's progress does not count it. While it waits it counts as open. */
const answeredPlanCard = (task: NestableTask): boolean =>
  (task.status === 'done' || task.status === 'cancelled') &&
  (task.planHolder === true ||
    (typeof task.sourceDelegationId === 'string' && isPlanHolder(task.sourceDelegationId)))

/** Is this task a person's main task? The API says 1, a live frame says true. */
export function isMainTask(task: { isMainTask?: unknown } | null | undefined): boolean {
  return task?.isMainTask === 1 || task?.isMainTask === true
}

export interface RequestProgress {
  total: number
  done: number
  cancelled: number
  open: number
}

const NONE: RequestProgress = { total: 0, done: 0, cancelled: 0, open: 0 }

export interface RequestNesting<T extends NestableTask> {
  /** The main task above this one, or null. Never the task itself. */
  mainOf(task: { id: string; parentTaskId?: unknown }): T | null
  /** Everything filed under this main task, at any depth, oldest first. */
  subtasksOf(mainId: string): T[]
  progressOf(mainId: string): RequestProgress
}

/** Read the tree once. A corrupt parent loop ends the walk rather than the page. */
export function buildRequestNesting<T extends NestableTask>(tasks: Iterable<T>): RequestNesting<T> {
  const all = [...tasks]
  const byId = new Map(all.map((t) => [t.id, t]))
  const mainFor = (task: { id: string; parentTaskId?: unknown }): T | null => {
    const seen = new Set<string>([task.id])
    let parent = task.parentTaskId
    while (typeof parent === 'string' && parent && !seen.has(parent)) {
      seen.add(parent)
      const above = byId.get(parent)
      if (!above) return null
      if (isMainTask(above)) return above
      parent = above.parentTaskId
    }
    return null
  }
  const under = new Map<string, T[]>()
  for (const t of all) {
    const main = mainFor(t)
    if (!main) continue
    const list = under.get(main.id)
    if (list) list.push(t)
    else under.set(main.id, [t])
  }
  const madeAt = (t: T): number => (typeof t.createdAt === 'number' ? t.createdAt : 0)
  for (const list of under.values()) list.sort((a, b) => madeAt(a) - madeAt(b))
  const progress = new Map<string, RequestProgress>()
  return {
    mainOf: mainFor,
    subtasksOf: (mainId) => under.get(mainId) ?? [],
    progressOf: (mainId) => {
      const known = progress.get(mainId)
      if (known) return known
      const list = under.get(mainId)?.filter((t) => !answeredPlanCard(t))
      if (!list) return NONE
      const done = list.filter((t) => t.status === 'done').length
      const cancelled = list.filter((t) => t.status === 'cancelled').length
      const counted = {
        total: list.length,
        done,
        cancelled,
        open: list.length - done - cancelled,
      }
      progress.set(mainId, counted)
      return counted
    },
  }
}

const isFinished = (status: string): boolean => status === 'done' || status === 'cancelled'

/** Open work under a request that says it is finished. Nothing should make any, but if
 *  something did, it must not sit folded away inside a card that says Done. */
export function openUnderFinished<T extends NestableTask>(task: T, main: T): boolean {
  return isFinished(main.status) && !isFinished(task.status)
}

/**
 * What the lanes draw from `shown`: every task but one nested under a main task that is
 * also shown. One that needs a person stays, labelled, and so does one whose main task
 * a filter left out, or the filter would find it and show nothing, and any open work
 * under a finished request.
 */
export function tasksOnTheirOwn<T extends NestableTask>(
  shown: readonly T[],
  nesting: RequestNesting<T>,
): T[] {
  const shownIds = new Set(shown.map((t) => t.id))
  return shown.filter((t) => {
    const main = nesting.mainOf(t)
    return (
      !main || !shownIds.has(main.id) || taskAttentionOf(t) !== null || openUnderFinished(t, main)
    )
  })
}

/** "2 of 3 done", with what was cancelled when any was. */
export function progressLabel(p: RequestProgress): string {
  if (p.total === 0) return 'No sub-tasks'
  const base = `${p.done} of ${p.total} done`
  return p.cancelled > 0 ? `${base}, ${p.cancelled} cancelled` : base
}

/** What a sub-task says about the request it belongs to. */
export function requestLabel(main: { identifier?: unknown; title?: unknown }): string {
  if (typeof main.identifier === 'string' && main.identifier) return `For ${main.identifier}`
  const title = typeof main.title === 'string' ? main.title.trim() : ''
  return title ? `For “${title.length > 40 ? `${title.slice(0, 39)}…` : title}”` : 'For a request'
}

/** What a request's work has cost so far: what its sub-tasks' runs cost. */
export function requestCost(subtasks: readonly BoardTask[]): TaskRunCost {
  let usd: number | null = null
  let estimated = false
  for (const t of subtasks) {
    const cost = runCostOf(t)
    if (cost.usd === null) continue
    usd = (usd ?? 0) + cost.usd
    if (cost.estimated) estimated = true
  }
  return { usd, estimated }
}

export interface RequestNestingValue {
  nesting: RequestNesting<BoardTask>
  onOpen: (taskId: string) => void
  /** The request to hold open, because something asked to see a sub-task under it. */
  unfoldedId?: string | null
  /** The person folded that request: stop holding it open. */
  onFolded?: () => void
}

/** The board's nesting, for the cards deep in its grid. Null off the board. */
export const RequestNestingContext = createContext<RequestNestingValue | null>(null)
