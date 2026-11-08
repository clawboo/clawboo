// The journal of the work folder move (`workDirMigration.ts`): one settings row
// holding every folder the move has planned, started, finished or left where it
// was. Each change of state is written before the step it describes, so a boot
// after a crash finds every item that was in flight and finishes or undoes it.
//
// The path code reads this module's copy, never the database: `teamWorkdirPath`
// and the worktree roots are called from tests and tools that have no database
// of their own. The copy is loaded at boot and kept current by the move.

import path from 'node:path'

import { getSetting, type ClawbooDb } from '@clawboo/db'
import { assertSafeTaskId } from '@clawboo/worktrees'

import { repoHash } from './workDir'

export const WORK_DIR_JOURNAL_KEY = 'work-dir-migration'

/**
 * - `planned`: about to move; nothing has changed yet.
 * - `moving`: a step that changes the disk has started. A boot that finds one
 *   looks at the disk and git to finish or undo it.
 * - `moved`: done, with a link at the old path.
 * - `left`: kept where it was (another volume, a checkout git does not list, a
 *   run still going in it). It keeps working there; the next boot tries again.
 * - `conflict`: something is already at the new path. Both are kept as they are.
 */
export type WorkDirItemState = 'planned' | 'moving' | 'moved' | 'left' | 'conflict'

export interface TeamFolderItem {
  kind: 'team'
  /** The folder's name: the team's sanitized id, or `_no-team`. */
  name: string
  from: string
  to: string
  state: WorkDirItemState
  note?: string
}

export interface WorktreeItem {
  kind: 'worktree'
  taskId: string
  workspaceId: string
  repoPath: string
  from: string
  to: string
  state: WorkDirItemState
  note?: string
}

export type WorkDirItem = TeamFolderItem | WorktreeItem

export interface WorkDirJournal {
  version: 1
  items: WorkDirItem[]
}

let current: WorkDirJournal = { version: 1, items: [] }

const STATES: ReadonlySet<string> = new Set(['planned', 'moving', 'moved', 'left', 'conflict'])

const isSegment = (name: unknown): name is string =>
  typeof name === 'string' && name !== '' && name !== '.' && name !== '..' && !/[\\/]/.test(name)

/** One parent up from `p` is named `name`. */
const under = (p: string, name: string): boolean => path.basename(path.dirname(p)) === name

/**
 * True for an entry shaped the way the move writes one, so a damaged row can
 * never steer a rename or a removal: a team folder is `<root>/workspaces/<name>`
 * or `<root>/teams/<name>` going to `<root>/teams/<name>`, and a checkout is
 * `<root>/worktrees/<repo hash>/<task id>` on both ends, absolute paths.
 */
function wellFormed(i: Partial<WorkDirItem> | null): i is WorkDirItem {
  if (!i || typeof i.from !== 'string' || typeof i.to !== 'string') return false
  if (typeof i.state !== 'string' || !STATES.has(i.state)) return false
  const { from, to } = i
  if (!path.isAbsolute(from) || !path.isAbsolute(to)) return false
  if (i.kind === 'team') {
    if (!isSegment(i.name) || path.basename(from) !== i.name || path.basename(to) !== i.name) {
      return false
    }
    return (under(from, 'workspaces') || under(from, 'teams')) && under(to, 'teams')
  }
  if (i.kind === 'worktree') {
    if (typeof i.repoPath !== 'string' || typeof i.workspaceId !== 'string') return false
    try {
      assertSafeTaskId(i.taskId ?? '')
    } catch {
      return false
    }
    const hash = repoHash(i.repoPath)
    return [from, to].every(
      (p) => path.basename(p) === i.taskId && under(p, hash) && under(path.dirname(p), 'worktrees'),
    )
  }
  return false
}

function parse(raw: string | null): WorkDirJournal {
  if (!raw) return { version: 1, items: [] }
  try {
    const parsed = JSON.parse(raw) as Partial<WorkDirJournal>
    const items = Array.isArray(parsed.items)
      ? (parsed.items as Array<Partial<WorkDirItem> | null>).filter(wellFormed)
      : []
    return { version: 1, items }
  } catch {
    return { version: 1, items: [] }
  }
}

/** Read the journal from the database into this module's copy, and return it. */
export function loadWorkDirJournal(db: ClawbooDb): WorkDirJournal {
  current = parse(getSetting(db, WORK_DIR_JOURNAL_KEY))
  return current
}

/** This module's copy: what the path code reads. */
export function workDirJournal(): WorkDirJournal {
  return current
}

/** Replace this module's copy (the move does this after each write). */
export function setWorkDirJournal(next: WorkDirJournal): void {
  current = next
}

export function serializeWorkDirJournal(journal: WorkDirJournal): string {
  return JSON.stringify(journal)
}

/** Kept at the old place: still being worked out, kept, or in conflict. */
const stays = (item: WorkDirItem): boolean =>
  item.state === 'moving' || item.state === 'left' || item.state === 'conflict'

/**
 * Where the team folder named `name` stays when the move kept it at the old
 * place, or null when it lives at the new one.
 */
export function stayingTeamFolder(name: string): string | null {
  for (const item of current.items) {
    if (item.kind === 'team' && item.name === name && stays(item)) return item.from
  }
  return null
}

/**
 * The roots of task checkouts the move kept at their old place, for one
 * repository (or all), each the folder the checkout is directly under. Pause,
 * complete and resume accept a recorded checkout under one of them, the way they
 * accept the data folder's and the work folder's.
 */
export function stayingWorktreeRoots(repoPath?: string): string[] {
  const out = new Set<string>()
  for (const item of current.items) {
    if (item.kind !== 'worktree' || !stays(item)) continue
    if (repoPath !== undefined && path.resolve(item.repoPath) !== path.resolve(repoPath)) continue
    out.add(path.dirname(path.resolve(item.from)))
  }
  return [...out]
}

/** Every folder an item the move kept at its old place sits directly under, for
 *  the verify gate's list of places a checkout or team folder may be. */
export function stayingRoots(): string[] {
  const out = new Set<string>()
  for (const item of current.items) {
    if (stays(item)) out.add(path.dirname(path.resolve(item.from)))
  }
  return [...out]
}
