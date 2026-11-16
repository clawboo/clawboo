// What a guest reads of text the board stored: another team's task titles left out.
//
// The board writes some notes that name a task by its title: the note a waiting task
// gets when the task it waited on closes, a list of sub-tasks that did not finish,
// a refused hand-off, a team room's lines about a task. Some can name a task of
// another team, and rows written before the board stopped doing so still carry the
// title. A guest (lib/roles) reads all of these through the board, so a guest's
// responses go through here once, at the guard (./guard), and so do the team chat
// stream's board frames. Only text the board writes is read: system comments, a wait
// reason the board set, a card's attention detail when it repeats one, and system
// posts in a team room. What people and agents write is their own.
//
// STRICT SHAPES. The board writes these notes from a small set of templates
// (NOTE_SHAPES). A note that may name a task (it holds a curly quote, or a straight
// quote where the board puts a title) is read against them strictly: their fixed
// words, quoted titles, and between the titles of a list only the separators the
// board writes, ending in the template's own words. When the note reads exactly one
// way, each title the guest may read stays and each other one becomes "a task on
// another team". When it reads no way, or more than one, the whole note is replaced
// with one sentence (HIDDEN_NOTE). An unusual old note can be hidden that way; a
// character of a title the guest may not read is not shown.
//
// QUOTES INSIDE A TITLE. New notes write a title's own curly quotes as straight ones
// (quoteTitle in @clawboo/board-core), so the note's curly quotes mark where it ends.
// Old notes may not have. So a curly-quoted span may hold a curly quote only when the
// whole span is a title the guest may read; otherwise a list could be read in more
// than one way. A template whose one title sits between fixed words at both ends (the
// release notes) takes any span, since it can be read only one way.
//
// THE RULE FOR A TITLE. A title is shown to a guest only when it is the title of a
// task on one of their teams, which they can already read (titlesOnTeams). That
// leaves out another team's task and also one since renamed or removed.

import { getTask, parseWaitingOn, tasks, type ClawbooDb } from '@clawboo/db'
import { inArray } from 'drizzle-orm'

/** The words for a task a guest may not see the title of. */
export const OTHER_TEAM_TASK = 'a task on another team'

/** What a guest reads in place of a note the board wrote that cannot be read strictly. */
export const HIDDEN_NOTE = 'A note about work that is not shown here.'

/** The longest a note quotes a title before cutting it (`subtaskNames`, `nameOfLink`). */
const QUOTED_TITLE_MAX = 60

/** Says whether a quoted title is one the guest may read. */
export type TitleCheck = (quoted: string) => boolean

/** The titles of every task on these teams, as a check: each title as a note may
 *  quote it (as stored, with its own quotes made straight or single as new notes
 *  write them), whole or cut to its first 60 characters. */
export function titlesOnTeams(db: ClawbooDb, teams: ReadonlySet<string>): TitleCheck {
  const readable = new Set<string>()
  if (teams.size > 0) {
    const rows = db
      .select({ title: tasks.title })
      .from(tasks)
      .where(inArray(tasks.teamId, [...teams]))
      .all()
    for (const { title } of rows) {
      for (const form of [title, title.replace(/[“”]/g, '"'), title.replace(/"/g, "'")]) {
        readable.add(form)
        if (form.length > QUOTED_TITLE_MAX) readable.add(form.slice(0, QUOTED_TITLE_MAX))
      }
    }
  }
  return (quoted) => readable.has(quoted)
}

// ─── The notes the board writes ──────────────────────────────────────────────

type Part =
  /** These words exactly. */
  | { lit: string }
  /** A task's title in quotes. `anyInside`: the span may hold anything, because
   *  fixed words pin both its ends. */
  | { title: 'curly' | 'straight'; anyInside?: true }
  /** A name in curly quotes that is not a task's title (a routine's): shown as it is. */
  | { name: true }
  /** One or more titles in curly quotes, joined by ", ". `more`: the list may end
   *  with ", and N more". */
  | { list: { more: boolean } }
  /** The rest of a list: see `list`. */
  | { listRest: { more: boolean } }
  /** One or more characters with no quote among them (a name, a status). */
  | { words: true }
  /** The rest of the note, as a person or an agent wrote it. */
  | { rest: true }
  /** A whole number. */
  | { num: true }
  /** One of these. */
  | { oneOf: readonly (readonly Part[])[] }
  /** These, or nothing. */
  | { maybe: readonly Part[] }

interface NoteShape {
  parts: readonly Part[]
  /** The whole note when its one title is not shown, as the board writes it now. */
  hidden?: string
}

const CURLY_TITLE: Part = { title: 'curly' }
const CURLY_ANY: Part = { title: 'curly', anyInside: true }
const STRAIGHT_TITLE: Part = { title: 'straight', anyInside: true }
const LIST: Part = { list: { more: false } }

const DONE = 'is done.'
const DONE_NOT_STARTED =
  'is done, and nothing started this one again. Retry it or decide what happens next.'
const CANCELLED = 'was cancelled. Decide what happens next.'

/** Every note the board writes that can name a task by its title, as a guest reads it. */
export const NOTE_SHAPES: readonly NoteShape[] = [
  // A waiting task's note, and its wait reason, when the task it waited on closed.
  ...[DONE, DONE_NOT_STARTED, CANCELLED].map((end) => ({
    parts: [CURLY_ANY, { lit: `, the task this waited on, ${end}` }],
    hidden: `The task this waited on, on another team, ${end}`,
  })),
  // The wait reason of a task whose handed-out work did not finish (unfinishedNeed).
  {
    parts: [
      { list: { more: true } },
      { lit: ' did not finish. Retry them, or mark this task done.' },
    ],
  },
  // A task closed over sub-tasks that did not get done.
  {
    parts: [
      { lit: 'This closed over sub-tasks that did not get done.' },
      { maybe: [{ lit: ' ' }, LIST, { lit: ' did not finish.' }] },
      { maybe: [{ lit: ' ' }, LIST, { lit: ' cancelled.' }] },
    ],
  },
  // A request a routine made.
  { parts: [{ lit: 'From the routine ' }, { name: true }, { lit: '.' }] },
  // A newer plan replaced one that was waiting.
  {
    parts: [
      { lit: 'A newer plan took the place of ' },
      STRAIGHT_TITLE,
      { lit: '. Nothing from that one started, and it stays readable as revision ' },
      { num: true },
      { lit: '.' },
    ],
  },
  // A hand-off refused because its target handed out work still open (nameOfLink).
  {
    parts: [
      { lit: 'Not handed to ' },
      { words: true },
      { lit: ': they handed out ' },
      { oneOf: [[STRAIGHT_TITLE], [{ words: true }]] },
      { lit: ', which is still open.' },
    ],
  },
  // A team room's lines about a task (api/board.ts).
  {
    parts: [
      { lit: 'Task ' },
      STRAIGHT_TITLE,
      { lit: ' claimed by ' },
      { words: true },
      { lit: '.' },
    ],
  },
  {
    parts: [
      { oneOf: [[{ lit: 'A person' }], [{ lit: 'A local API call' }]] },
      { lit: ' moved ' },
      STRAIGHT_TITLE,
      { lit: ' to ' },
      { words: true },
      { lit: '.' },
    ],
  },
  {
    parts: [{ words: true }, { lit: ' on ' }, STRAIGHT_TITLE, { lit: ': ' }, { rest: true }],
  },
  {
    parts: [
      { lit: 'Task ' },
      STRAIGHT_TITLE,
      { lit: ' now depends on ' },
      STRAIGHT_TITLE,
      { lit: '.' },
    ],
  },
  {
    parts: [{ lit: 'Task ' }, STRAIGHT_TITLE, { lit: ' now depends on a task on another team.' }],
  },
]

/** Where a note was found: it decides which straight quotes may hold a title. */
export type NoteField = 'comment' | 'need' | 'post'

/** Straight-quoted words where the board puts a title, outside a team room. */
const STRAIGHT_TITLE_MARKS = ['handed out "', 'took the place of "', 'depends on "', 'Task "']

/** Whether a note may name a task by its title, and so must be read strictly. A team
 *  room's system posts are all the board's lines about tasks; elsewhere, straight
 *  quotes are titles only where the board puts one (an error's quotes are not). */
function mayNameATask(text: string, field: NoteField): boolean {
  if (text.includes('“') || text.includes('”')) return true
  if (field === 'post') return text.includes('"')
  return STRAIGHT_TITLE_MARKS.some((mark) => text.includes(mark))
}

type Piece = { title: false; text: string } | { title: 'curly' | 'straight'; text: string }

/** The longest a note is walked for before it counts as unreadable. */
const STEP_LIMIT = 100_000

/** The one way the note reads against NOTE_SHAPES, or null for none or more than one. */
function readNote(text: string, mayRead: TitleCheck): { shape: NoteShape; pieces: Piece[] } | null {
  let found: { shape: NoteShape; pieces: Piece[] } | null = null
  let ways = 0
  let steps = 0
  // Walks `parts` from `i` at `pos`; `done` hears each complete reading. True: stop.
  const walk = (
    parts: readonly Part[],
    i: number,
    pos: number,
    got: Piece[],
    done: (pos: number, got: Piece[]) => boolean,
  ): boolean => {
    if (++steps > STEP_LIMIT) return true
    if (i === parts.length) return done(pos, got)
    const part = parts[i]!
    const next = (to: number, piece?: Piece): boolean =>
      walk(parts, i + 1, to, piece ? [...got, piece] : got, done)
    const then = (more: readonly Part[]): boolean =>
      walk([...more, ...parts.slice(i + 1)], 0, pos, got, done)

    if ('lit' in part)
      return (
        text.startsWith(part.lit, pos) &&
        next(pos + part.lit.length, { title: false, text: part.lit })
      )
    if ('num' in part) {
      let end = pos
      while (end < text.length && text[end]! >= '0' && text[end]! <= '9') end += 1
      return end > pos && next(end, { title: false, text: text.slice(pos, end) })
    }
    if ('words' in part) {
      for (let end = pos + 1; end <= text.length; end += 1) {
        if (/[“”"]/.test(text[end - 1]!)) break
        if (next(end, { title: false, text: text.slice(pos, end) })) return true
      }
      return false
    }
    if ('rest' in part) return next(text.length, { title: false, text: text.slice(pos) })
    if ('oneOf' in part) return part.oneOf.some((alt) => then(alt))
    if ('maybe' in part) return then(part.maybe) || next(pos)
    if ('list' in part) return then([CURLY_TITLE, { listRest: part.list }])
    if ('listRest' in part) {
      if (then([{ lit: ', ' }, CURLY_TITLE, part])) return true
      if (part.listRest.more && then([{ lit: ', and ' }, { num: true }, { lit: ' more' }]))
        return true
      return next(pos)
    }
    // A quoted span: a task's title, or a routine's name.
    const curly = 'name' in part || part.title === 'curly'
    const [open, close] = curly ? ['“', '”'] : ['"', '"']
    if (text[pos] !== open) return false
    for (let end = text.indexOf(close, pos + 1); end !== -1; end = text.indexOf(close, end + 1)) {
      const inside = text.slice(pos + 1, end)
      const quotesInside = /[“”]/.test(inside)
      if ('name' in part) {
        if (quotesInside) continue
        if (next(end + 1, { title: false, text: `“${inside}”` })) return true
        continue
      }
      // In a list, a span holding a curly quote is one only when it is theirs whole.
      if (curly && quotesInside && !part.anyInside && !mayRead(inside)) continue
      if (next(end + 1, { title: part.title, text: inside })) return true
    }
    return false
  }

  for (const shape of NOTE_SHAPES) {
    walk(shape.parts, 0, 0, [], (pos, pieces) => {
      if (pos !== text.length) return false
      ways += 1
      if (ways === 1) found = { shape, pieces }
      return ways > 1
    })
    if (ways > 1 || steps > STEP_LIMIT) return null
  }
  return ways === 1 ? found : null
}

/** A note the board wrote, as a guest reads it: see the top of this file. */
export function redactNote(text: string, field: NoteField, mayRead: TitleCheck): string {
  if (!mayNameATask(text, field)) return text
  const read = readNote(text, mayRead)
  if (!read) return HIDDEN_NOTE
  let hidden = false
  const shown = read.pieces
    .map((piece) => {
      if (piece.title === false) return piece.text
      if (mayRead(piece.text))
        return piece.title === 'curly' ? `“${piece.text}”` : `"${piece.text}"`
      hidden = true
      return OTHER_TEAM_TASK
    })
    .join('')
  return hidden && read.shape.hidden ? read.shape.hidden : shown
}

/**
 * What a guest may read of a card's `waitingOnDetail`: the title of the task it waits
 * on only when that task is on one of their teams; else an empty title, as for a task
 * that is gone. The board's REST answers and the team chat stream's board frames both
 * use this, so the two cannot drift. `teams` null: not a guest, the detail as it is.
 */
export function guestWaitingOnDetail<D extends { taskTitle?: string }>(
  db: ClawbooDb,
  waitingOn: string | null | undefined,
  detail: D | null | undefined,
  teams: ReadonlySet<string> | null,
): D | { taskTitle: string } | null | undefined {
  if (!teams || !detail?.taskTitle) return detail
  const w = parseWaitingOn(waitingOn ?? null)
  const teamId = w?.kind === 'task' ? (getTask(db, w.taskId)?.teamId ?? null) : null
  return teamId !== null && teams.has(teamId) ? detail : { taskTitle: '' }
}

// ─── A guest's answers ───────────────────────────────────────────────────────

/** A wait reason read back as an object, from JSON text or as it is. */
function waitObject(value: unknown): Record<string, unknown> | null {
  let doc = value
  if (typeof value === 'string') {
    try {
      doc = JSON.parse(value)
    } catch {
      return null
    }
  }
  return doc && typeof doc === 'object' && !Array.isArray(doc)
    ? (doc as Record<string, unknown>)
    : null
}

/** Whether the board wrote this wait's reason. A person's or an agent's own words
 *  (`by`) are theirs; the board's own reasons carry no `by`, and a wait on unfinished
 *  sub-tasks (`untilSubtasks`) is the board's whoever set it. */
function boardWroteNeed(wait: Record<string, unknown>): boolean {
  return wait['untilSubtasks'] === true || (wait['by'] !== 'agent' && wait['by'] !== 'person')
}

/** A wait reason, stored as JSON text or read back as an object, with a reason the
 *  board wrote read as a note. Anything else comes back as it was. */
function redactWaitingOn(value: unknown, mayRead: TitleCheck): unknown {
  const wait = waitObject(value)
  const need = wait?.['need']
  if (!wait || typeof need !== 'string' || !boardWroteNeed(wait)) return value
  const redacted = redactNote(need, 'need', mayRead)
  if (redacted === need) return value
  const out = { ...wait, need: redacted }
  return typeof value === 'string' ? JSON.stringify(out) : out
}

/**
 * A response body as a guest reads it: board-written text in it with the titles
 * they may not read replaced. It reads the shapes the board answers with: a comment
 * (`authorType: 'system'`, `body`), a task's `waitingOn`, an `attention` with a
 * `detail`, and a team room post (`kind: 'system'`, `body`). Everything else, and
 * every value it leaves alone, comes back as the same object.
 */
export function redactForGuest(value: unknown, mayRead: () => TitleCheck): unknown {
  // The titles are read once, and only when some note may name a task.
  let check: TitleCheck | null = null
  const lazy: TitleCheck = (quoted) => (check ??= mayRead())(quoted)
  const visit = (v: unknown, depth: number): unknown => {
    // A response is plain JSON, so this never stops short of a real one.
    if (depth > 64 || v === null || typeof v !== 'object') return v
    if (Array.isArray(v)) {
      let changed = false
      const out = v.map((item) => {
        const next = visit(item, depth + 1)
        if (next !== item) changed = true
        return next
      })
      return changed ? out : v
    }
    const obj = v as Record<string, unknown>
    let out: Record<string, unknown> | null = null
    const set = (key: string, next: unknown): void => {
      if (next === obj[key]) return
      out ??= { ...obj }
      out[key] = next
    }
    if (typeof obj['body'] === 'string') {
      if (obj['authorType'] === 'system') set('body', redactNote(obj['body'], 'comment', lazy))
      else if (obj['kind'] === 'system') set('body', redactNote(obj['body'], 'post', lazy))
    }
    if ('waitingOn' in obj && obj['waitingOn'] != null) {
      set('waitingOn', redactWaitingOn(obj['waitingOn'], lazy))
    }
    for (const [key, child] of Object.entries(obj)) {
      if (key === 'body' || key === 'waitingOn') continue
      if (key === 'attention' && child && typeof child === 'object') {
        const detail = (child as { detail?: unknown }).detail
        if (typeof detail === 'string') {
          // A card's detail repeats its wait reason, or says why a run failed. The
          // reason is read as the wait is (a person's or an agent's stays theirs);
          // anything else is read as a note the board wrote.
          const task = obj['task'] as Record<string, unknown> | undefined
          const wait = waitObject(obj['waitingOn'] ?? task?.['waitingOn'] ?? null)
          const theirs = wait && wait['need'] === detail && !boardWroteNeed(wait)
          const redacted = theirs ? detail : redactNote(detail, 'need', lazy)
          if (redacted !== detail) {
            set(key, { ...(child as object), detail: redacted })
            continue
          }
        }
      }
      set(key, visit(child, depth + 1))
    }
    return out ?? obj
  }
  return visit(value, 0)
}
