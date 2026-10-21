// Remembers, per team filter, what the person last saw of the board, so a board
// they come back to can say what changed while they were away. Kept in this
// browser's storage as a convenience: a missing or unreadable record only means
// nothing is marked.

import { useCallback, useMemo, useRef, useState } from 'react'

import {
  absorb,
  acknowledge,
  dottedIds,
  markAllSeen,
  noteRead,
  readSeen,
  seenSummary,
  watchedThrough,
  type SeenKind,
  type SeenRecord,
  type SeenSummary,
} from './seenModel'

const KEY_PREFIX = 'clawboo.board.seen.'

function load(team: string): SeenRecord | null {
  try {
    return readSeen(window.localStorage.getItem(KEY_PREFIX + team))
  } catch {
    return null
  }
}

function save(team: string, rec: SeenRecord): void {
  try {
    window.localStorage.setItem(KEY_PREFIX + team, JSON.stringify(rec))
  } catch {
    // Private mode or a full store: the board still works, it just forgets.
  }
}

/** Every team filter this browser holds a record for. */
function storedTeams(): string[] {
  try {
    const teams: string[] = []
    for (let i = 0; i < window.localStorage.length; i++) {
      const key = window.localStorage.key(i)
      if (key?.startsWith(KEY_PREFIX)) teams.push(key.slice(KEY_PREFIX.length))
    }
    return teams
  } catch {
    return []
  }
}

/** Whether the person can see the board right now. */
function watchingNow(): boolean {
  if (typeof document === 'undefined') return false
  return document.visibilityState === 'visible' && document.hasFocus()
}

/** A task as one read of the board saw it. */
export interface SeenTask {
  id: string
  /** The column the task is drawn in. */
  column: string
  /** Its team, so a change seen under one filter counts under that team's view too. */
  teamId?: string | null
}

export interface SeenBoard {
  summary: SeenSummary | null
  /** Cards that changed while the person was away and still carry a dot. */
  dotted: ReadonlySet<string>
  /** Every change not looked at yet, by task id. */
  pending: Readonly<Record<string, SeenKind>>
  /** A read of the board for `team`, each task with the column it is drawn in. */
  noteBoardRead: (team: string, read: ReadonlyArray<SeenTask>) => void
  /** The person looked at these cards. */
  acknowledge: (ids: Iterable<string>) => void
  /** The person asked to clear every mark. */
  markAllSeen: () => void
  /** The person moved or added this card, so it is not news to them. */
  absorbTask: (id: string, column: string, teamId?: string | null) => void
}

const NO_PENDING: Readonly<Record<string, SeenKind>> = {}

export function useSeenBoard(team: string): SeenBoard {
  // Records by team filter, loaded on first use. Every read rewrites the record
  // (its time is what says how long the person was away), so they live in a ref
  // and the board re-renders only when what is marked changes.
  const records = useRef(new Map<string, SeenRecord | null>())
  // Teams read since the board opened. The first read of each is a return,
  // whatever the clock says: nobody was watching while the board was closed.
  const looked = useRef(new Set<string>())
  // Where each task was in the newest read, so a card looked at under one filter
  // can be marked seen, in that column, under the others.
  const latest = useRef(new Map<string, SeenTask>())
  const [version, setVersion] = useState(0)

  const get = useCallback((t: string): SeenRecord | null => {
    if (!records.current.has(t)) records.current.set(t, load(t))
    return records.current.get(t) ?? null
  }, [])

  const put = useCallback(
    (t: string, next: SeenRecord) => {
      const before = records.current.get(t)
      records.current.set(t, next)
      save(t, next)
      if (t === team && JSON.stringify(before?.pending ?? null) !== JSON.stringify(next.pending)) {
        setVersion((v) => v + 1)
      }
    },
    [team],
  )

  // The person saw these tasks where they now are. That holds under every team
  // filter that shows them: All teams, the task's own team, and any view whose
  // record already tracks it. `skip` is a filter whose record is already current.
  const see = useCallback(
    (tasks: ReadonlyArray<SeenTask>, skip?: string) => {
      if (tasks.length === 0) return
      for (const t of new Set([team, ...records.current.keys(), ...storedTeams()])) {
        if (t === skip) continue
        const rec = get(t)
        if (!rec) continue
        let next = rec
        for (const task of tasks) {
          const shown =
            t === 'all' ||
            (task.teamId != null && t === task.teamId) ||
            (task.teamId === undefined && t === team) ||
            Object.hasOwn(next.columns, task.id)
          if (shown) next = absorb(next, task.id, task.column)
        }
        if (next !== rec) put(t, next)
      }
    },
    [get, put, team],
  )

  const noteBoardRead = useCallback(
    (t: string, read: ReadonlyArray<SeenTask>) => {
      let prev = get(t)
      if (prev && !looked.current.has(t)) prev = { ...prev, watching: false }
      looked.current.add(t)
      for (const task of read) latest.current.set(task.id, task)
      const at = Date.now()
      const watching = watchingNow()
      put(t, noteRead(prev, read, at, watching))
      // What moved while the person watched it move is not news under any other
      // filter either, once they get there.
      if (prev && watchedThrough(prev, at, watching)) {
        const before = prev.columns
        see(
          read.filter((task) => !Object.hasOwn(before, task.id) || before[task.id] !== task.column),
          t,
        )
      }
    },
    [get, put, see],
  )

  const ack = useCallback(
    (ids: Iterable<string>) => {
      const list = [...ids]
      if (list.length === 0) return
      const known: SeenTask[] = []
      const unknown: string[] = []
      for (const id of list) {
        const task = latest.current.get(id)
        if (task) known.push(task)
        else unknown.push(id)
      }
      see(known)
      if (unknown.length > 0) {
        for (const t of new Set([team, ...records.current.keys(), ...storedTeams()])) {
          const rec = get(t)
          if (rec) put(t, acknowledge(rec, unknown))
        }
      }
    },
    [get, put, see, team],
  )
  const markAll = useCallback(() => {
    const rec = get(team)
    if (!rec) return
    ack(Object.keys(rec.pending?.items ?? {}))
    const after = get(team)
    if (after) put(team, markAllSeen(after))
  }, [ack, get, put, team])
  // A card the person added or moved: the views it shows in take it as seen.
  const absorbTask = useCallback(
    (id: string, column: string, teamId?: string | null) => {
      const task: SeenTask = { id, column, teamId }
      latest.current.set(id, task)
      see([task])
    },
    [see],
  )

  // Recomputed only when what is marked changes, so the grid is not handed a new
  // set on every render.
  const marks = useMemo(() => {
    const record = get(team)
    return {
      summary: seenSummary(record),
      dotted: dottedIds(record),
      pending: record?.pending?.items ?? NO_PENDING,
    }
    // `version` bumps whenever the current team's marks change.
  }, [get, team, version])

  return { ...marks, noteBoardRead, acknowledge: ack, markAllSeen: markAll, absorbTask }
}
