// How the calendar names days, ranges and times. Local time and the viewer's
// locale throughout. Range labels join their ends with "to" rather than a dash:
// the words read the same in every font and to a screen reader.

import { addDays, isSameDay, startOfDay, startOfWeek, type CalendarRange } from './calendarModel'

// Building a formatter costs far more than using one, and a busy board formats
// every card's stamp on every render, so each set of options is built once. The
// viewer's locale is fixed for the life of the page.
const formatters = new Map<string, Intl.DateTimeFormat>()

function formatter(opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = JSON.stringify(opts)
  let f = formatters.get(key)
  if (!f) {
    f = new Intl.DateTimeFormat(undefined, opts)
    formatters.set(key, f)
  }
  return f
}

const fmt = (ms: number, opts: Intl.DateTimeFormatOptions): string => formatter(opts).format(ms)

export function weekdayShort(ms: number): string {
  return fmt(ms, { weekday: 'short' })
}

export function monthShort(ms: number): string {
  return fmt(ms, { month: 'short' })
}

/** "9:14 AM", or the 24-hour form where the locale uses it. */
export function timeLabel(ms: number): string {
  return fmt(ms, { hour: 'numeric', minute: '2-digit' })
}

/** "Oct 14" */
export function dayMonth(ms: number): string {
  return fmt(ms, { month: 'short', day: 'numeric' })
}

/** "Tue, Oct 14" */
export function shortDate(ms: number): string {
  return fmt(ms, { weekday: 'short', month: 'short', day: 'numeric' })
}

/** "Tuesday, October 14", the name a screen reader hears for a day. */
export function longDate(ms: number): string {
  return fmt(ms, { weekday: 'long', month: 'long', day: 'numeric' })
}

/** Today, Tomorrow or Yesterday for those three days, else null. */
export function relativeDayWord(day: number, now: number): string | null {
  if (isSameDay(day, now)) return 'Today'
  if (isSameDay(day, addDays(now, 1))) return 'Tomorrow'
  if (isSameDay(day, addDays(now, -1))) return 'Yesterday'
  return null
}

/** The ISO 8601 week number of the day holding `ms`. */
export function isoWeek(ms: number): number {
  const d = new Date(startOfDay(ms))
  // Thursday of this ISO week decides which year the week belongs to.
  d.setDate(d.getDate() + 3 - ((d.getDay() + 6) % 7))
  const jan4 = new Date(d.getFullYear(), 0, 4)
  const diffDays = Math.round((d.getTime() - jan4.getTime()) / 86_400_000)
  return 1 + Math.round((diffDays - 3 + ((jan4.getDay() + 6) % 7)) / 7)
}

/**
 * A range's title in two weights: the dates, and the year beside them.
 *   day                → "Tuesday, Oct 14" · "2026"
 *   week, one month    → "Oct 12 to 18" · "2026"
 *   week, two months   → "Sep 28 to Oct 4" · "2026"
 *   week, two years    → "Dec 28, 2026 to Jan 3, 2027" · ""
 *   month              → "October" · "2026"
 */
export function rangeTitle(range: CalendarRange): { dates: string; year: string } {
  const first = new Date(range.start)
  const last = new Date(range.days[range.days.length - 1]!)
  if (range.mode === 'day') {
    return {
      dates: fmt(range.start, { weekday: 'long', month: 'short', day: 'numeric' }),
      year: String(first.getFullYear()),
    }
  }
  if (range.mode === 'month') {
    return { dates: fmt(range.start, { month: 'long' }), year: String(first.getFullYear()) }
  }
  if (first.getFullYear() !== last.getFullYear()) {
    const full: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', year: 'numeric' }
    return { dates: `${fmt(first.getTime(), full)} to ${fmt(last.getTime(), full)}`, year: '' }
  }
  const md: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' }
  const end =
    first.getMonth() === last.getMonth() ? String(last.getDate()) : fmt(last.getTime(), md)
  return { dates: `${fmt(first.getTime(), md)} to ${end}`, year: String(first.getFullYear()) }
}

/** "Today", "This week", "Next week", "Last week", "This month" and so on, else null. */
export function rangeRelation(range: CalendarRange, now: number): string | null {
  if (range.mode === 'day') return relativeDayWord(range.start, now)
  if (range.mode === 'week') {
    // A week range starts on the locale's first weekday, so the week holding
    // `now` starts on that same weekday.
    const thisWeek = startOfWeek(now, new Date(range.start).getDay())
    if (isSameDay(range.start, thisWeek)) return 'This week'
    if (isSameDay(range.start, addDays(thisWeek, 7))) return 'Next week'
    if (isSameDay(range.start, addDays(thisWeek, -7))) return 'Last week'
    return null
  }
  const n = new Date(now)
  const s = new Date(range.start)
  const months = (s.getFullYear() - n.getFullYear()) * 12 + (s.getMonth() - n.getMonth())
  if (months === 0) return 'This month'
  if (months === 1) return 'Next month'
  if (months === -1) return 'Last month'
  return null
}

/** "1 task", "3 tasks" */
export function countLabel(n: number, one: string, many: string = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`
}

/**
 * How long something has been going, as a card has room for: "<1m", "14m",
 * "2h 5m", "4d 2h". A start in the future (another machine's clock) reads "<1m".
 */
export function elapsedLabel(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000)
  if (minutes < 1) return '<1m'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`
  const days = Math.floor(hours / 24)
  return hours % 24 ? `${days}d ${hours % 24}h` : `${days}d`
}

/** "9:14 AM" today, "Tue, Oct 14 at 9:14 AM" on any other day. */
export function timeOnDay(ms: number, now: number): string {
  return isSameDay(ms, now) ? timeLabel(ms) : `${shortDate(ms)} at ${timeLabel(ms)}`
}

/**
 * When the person last caught up, for "Since …": the time today, "yesterday"
 * and the time, the weekday and time within the week, else the date.
 */
export function sinceLabel(since: number, now: number): string {
  if (isSameDay(since, now)) return timeLabel(since)
  if (isSameDay(since, addDays(now, -1))) return `yesterday ${timeLabel(since)}`
  if (since > addDays(startOfDay(now), -6)) return `${weekdayShort(since)} ${timeLabel(since)}`
  return dayMonth(since)
}

/**
 * How long ago something happened, as a card on the Kanban board says it: "Just
 * now", "4m ago", "3h ago" today, "Yesterday", "3d ago" within the week, else the
 * date. A moment in the future (another machine's clock) reads "Just now".
 */
export function agoLabel(at: number, now: number): string {
  const minutes = Math.floor((now - at) / 60_000)
  if (minutes < 1) return 'Just now'
  if (minutes < 60) return `${minutes}m ago`
  if (isSameDay(at, now)) return `${Math.floor(minutes / 60)}h ago`
  if (isSameDay(at, addDays(now, -1))) return 'Yesterday'
  const days = Math.round((startOfDay(now) - startOfDay(at)) / 86_400_000)
  if (days < 7) return `${days}d ago`
  return dayMonth(at)
}
