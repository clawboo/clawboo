// What a guest reads of text the board stored: another team's task titles left out.
//
// The board writes some notes that name another task: the note a waiting task gets
// when the task it waited on closes, a parent's list of sub-tasks that did not finish,
// a hand-off refused because of a task its target handed out, a team room's line about
// a new dependency. Since the release that limited guests, the first and the last name
// a task of another team only generically, but rows written before then still carry
// the title, and the sub-task and hand-off notes still name every task. A guest
// (lib/roles) reads all of these through the board, so a guest's responses go through
// here once, at the guard (./guard), and so do the team chat stream's board frames.
//
// THE RULE. A title in such a note is shown to a guest only when it is the title of a
// task on one of their teams, which they can already read; anything else is replaced.
// That holds for a title of another team's task, and also for one of a task since
// renamed or removed, so nothing a guest could not read gets through.
//
// WHERE TITLES SIT. Every note that names another task quotes its title: in curly
// quotes (“…”), or in straight quotes in two notes ("handed out "…", which is still
// open" and "depends on "…"."). Curly quotes are read wherever they appear in
// board-written text; the straight ones only in those two notes, since other straight
// quotes (a hand-off's words, an error) are not titles of other tasks. Only text the
// board writes is read: system comments, a task's wait reason, a card's attention
// detail and system posts in a team room. What people and agents write is their own.
//
// FAIL CLOSED. A title can hold the quotes that mark it, and a long list was once cut
// inside one, so in a stored note where a title ends cannot always be told. New notes
// are written so it can (quoteTitle in @clawboo/board-core makes a title's own curly
// quotes straight, and lists are cut between names; a refused hand-off makes its
// straight quotes single). Reading a note's quoted spans in turn, a span is shown only
// when it is a title the guest may read and the words after it, up to the next opening
// quote, hold no closing quote (one there means the title went on). A span with no
// quote inside that ends the same way is replaced alone. Anything else, and the last
// span of a note long enough to have been cut, is replaced with everything after its
// opening quote. A readable title can be hidden that way; a character of one the guest
// may not read is not shown, short of a title built to look like several, which only a
// note written before quoteTitle can hold.

import { getTask, parseWaitingOn, tasks, type ClawbooDb } from '@clawboo/db'
import { inArray } from 'drizzle-orm'

/** The words for a task a guest may not see the title of. */
export const OTHER_TEAM_TASK = 'a task on another team'

/** The longest a note quotes a title before cutting it (`subtaskNames`, `nameOfLink`). */
const QUOTED_TITLE_MAX = 60

/** The release note a waiting task got before guests were limited, with the title. It
 *  is anchored at both ends, so a title with quotes of its own is read whole. */
const OLD_WAIT_NOTE =
  /^“([\s\S]+)”, the task this waited on, (is done\.|is done, and nothing started this one again\. Retry it or decide what happens next\.|was cancelled\. Decide what happens next\.)$/

const OPEN = '“'
const CLOSE = '”'

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

/** A note at least this long may have been cut inside its last title: a list of
 *  sub-tasks was once cut at 1000 characters, wherever that fell. */
const MAY_BE_CUT_AT = 1_000

/** The curly-quoted titles in a note, each kept only when the guest may read it. */
function redactCurly(text: string, mayRead: TitleCheck): string {
  if (!text.includes(OPEN)) return text
  // Whether the words after a closing quote at `j`, up to the next opening one, hold
  // no closing quote. If they do, the quote at `j` was inside a title.
  const endsCleanly = (j: number): boolean => {
    const next = text.indexOf(OPEN, j + 1)
    return !text.slice(j + 1, next === -1 ? text.length : next).includes(CLOSE)
  }
  const lastOpen = text.length >= MAY_BE_CUT_AT ? text.lastIndexOf(OPEN) : -1
  let out = ''
  let at = 0
  for (;;) {
    const open = text.indexOf(OPEN, at)
    if (open === -1) return out + text.slice(at)
    out += text.slice(at, open)
    // The last title of a note that may have been cut cannot be read whole.
    if (open === lastOpen) return out + OTHER_TEAM_TASK
    // A title they may read, quotes of its own and all: the longest that ends cleanly.
    let readable = -1
    for (let j = text.lastIndexOf(CLOSE); j > open; j = text.lastIndexOf(CLOSE, j - 1)) {
      if (mayRead(text.slice(open + 1, j)) && endsCleanly(j)) {
        readable = j
        break
      }
    }
    if (readable !== -1) {
      out += text.slice(open, readable + 1)
      at = readable + 1
      continue
    }
    // One with no quote inside that ends cleanly: it alone is replaced.
    const first = text.indexOf(CLOSE, open + 1)
    if (first !== -1 && !text.slice(open + 1, first).includes(OPEN) && endsCleanly(first)) {
      out += OTHER_TEAM_TASK
      at = first + 1
      continue
    }
    // Where this title ends cannot be told, so nothing after its opening quote shows.
    return out + OTHER_TEAM_TASK
  }
}

/** A title in straight quotes after `lead` (which ends with the opening quote), up to
 *  the note's own end (`endOf`), never to a quote inside the title. With no end found
 *  (a note cut short), everything from the opening quote is replaced. */
function redactStraight(
  text: string,
  mayRead: TitleCheck,
  lead: string,
  endOf: (text: string, start: number) => number,
): string {
  const at = text.indexOf(lead)
  if (at === -1) return text
  const start = at + lead.length
  const end = endOf(text, start)
  const head = `${text.slice(0, at)}${lead.slice(0, -1)}`
  if (end === -1) return `${head}${OTHER_TEAM_TASK}`
  if (mayRead(text.slice(start, end))) return text
  return `${head}${OTHER_TEAM_TASK}${text.slice(end + 1)}`
}

/** Board-written text with every title the guest may not read replaced. */
export function redactTitles(text: string, mayRead: TitleCheck): string {
  if (!text.includes(OPEN) && !text.includes(CLOSE) && !text.includes('"')) return text
  // The old release note reads as the one written now.
  const old = OLD_WAIT_NOTE.exec(text)
  if (old && !mayRead(old[1]!)) return `The task this waited on, on another team, ${old[2]}`
  let out = redactCurly(text, mayRead)
  out = redactStraight(out, mayRead, 'handed out "', (t, start) => {
    const end = t.lastIndexOf('", which is still open')
    return end >= start ? end : -1
  })
  out = redactStraight(out, mayRead, 'depends on "', (t, start) =>
    t.endsWith('".') && t.length - 2 >= start ? t.length - 2 : -1,
  )
  return out
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

/** A wait reason, stored as JSON text or read back as an object, with its `need`
 *  redacted. Anything else comes back as it was. */
function redactWaitingOn(value: unknown, mayRead: TitleCheck): unknown {
  if (typeof value === 'string') {
    let parsed: unknown
    try {
      parsed = JSON.parse(value)
    } catch {
      return value
    }
    const out = redactWaitingOn(parsed, mayRead)
    return out === parsed ? value : JSON.stringify(out)
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const need = (value as { need?: unknown }).need
    if (typeof need === 'string') {
      const redacted = redactTitles(need, mayRead)
      if (redacted !== need) return { ...(value as object), need: redacted }
    }
  }
  return value
}

/**
 * A response body as a guest reads it: board-written text in it with the titles
 * they may not read replaced. It reads the shapes the board answers with: a comment
 * (`authorType: 'system'`, `body`), a task's `waitingOn`, an `attention` with a
 * `detail`, and a team room post (`kind: 'system'`, `body`). Everything else, and
 * every value it leaves alone, comes back as the same object.
 */
export function redactForGuest(value: unknown, mayRead: () => TitleCheck): unknown {
  // The titles are read once, and only when some text quotes one.
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
    const boardWritten = obj['authorType'] === 'system' || obj['kind'] === 'system'
    if (boardWritten && typeof obj['body'] === 'string') {
      set('body', redactTitles(obj['body'], lazy))
    }
    if ('waitingOn' in obj && obj['waitingOn'] != null) {
      set('waitingOn', redactWaitingOn(obj['waitingOn'], lazy))
    }
    for (const [key, child] of Object.entries(obj)) {
      if (key === 'body' || key === 'waitingOn') continue
      if (key === 'attention' && child && typeof child === 'object') {
        const detail = (child as { detail?: unknown }).detail
        if (typeof detail === 'string') {
          const redacted = redactTitles(detail, lazy)
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
