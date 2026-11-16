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
// quotes (“…”), or in straight quotes in two notes ("handed out "…"," and "depends on
// "…"."). Curly quotes are replaced wherever they appear in board-written text; the
// straight ones only in those two notes, since other straight quotes (a hand-off's
// words, an error) are not titles of other tasks. Only text the board writes is read:
// system comments, a task's wait reason, a card's attention detail and system posts
// in a team room. What people and agents write is their own.

import { tasks, type ClawbooDb } from '@clawboo/db'
import { inArray } from 'drizzle-orm'

/** The words for a task a guest may not see the title of. */
export const OTHER_TEAM_TASK = 'a task on another team'

/** The longest a note quotes a title before cutting it (`subtaskNames`, `nameOfLink`). */
const QUOTED_TITLE_MAX = 60

/** The release note a waiting task got before guests were limited, with the title. */
const OLD_WAIT_NOTE =
  /^“([\s\S]+)”, the task this waited on, (is done\.|is done, and nothing started this one again\. Retry it or decide what happens next\.|was cancelled\. Decide what happens next\.)$/

/** Says whether a quoted title is one the guest may read. */
export type TitleCheck = (quoted: string) => boolean

/** The titles of every task on these teams, as a check: the whole title, or the
 *  first 60 characters of one that a note cut short. */
export function titlesOnTeams(db: ClawbooDb, teams: ReadonlySet<string>): TitleCheck {
  const whole = new Set<string>()
  const cut = new Set<string>()
  if (teams.size > 0) {
    const rows = db
      .select({ title: tasks.title })
      .from(tasks)
      .where(inArray(tasks.teamId, [...teams]))
      .all()
    for (const { title } of rows) {
      whole.add(title)
      if (title.length > QUOTED_TITLE_MAX) cut.add(title.slice(0, QUOTED_TITLE_MAX))
    }
  }
  return (quoted) => whole.has(quoted) || cut.has(quoted)
}

/** Board-written text with every title the guest may not read replaced. */
export function redactTitles(text: string, mayRead: TitleCheck): string {
  if (!text.includes('“') && !text.includes('"')) return text
  // The old release note reads as the one written now.
  const old = OLD_WAIT_NOTE.exec(text)
  if (old && !mayRead(old[1]!)) return `The task this waited on, on another team, ${old[2]}`
  return text
    .replace(/“([^”]*)”/g, (whole, title: string) => (mayRead(title) ? whole : OTHER_TEAM_TASK))
    .replace(/(handed out )"([^"]*)",/g, (whole, lead: string, title: string) =>
      mayRead(title) ? whole : `${lead}${OTHER_TEAM_TASK},`,
    )
    .replace(/(depends on )"([^"]*)"\./g, (whole, lead: string, title: string) =>
      mayRead(title) ? whole : `${lead}${OTHER_TEAM_TASK}.`,
    )
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
