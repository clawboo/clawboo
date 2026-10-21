// The Board's "Since you last looked" model: it remembers which column each task
// sat in the last time the person saw the board, and works out what changed
// while they were away. Pure and storage-free; the host persists the record.
//
// The watching rule: a change only counts as unseen when the person was not
// there to see it. Two reads in a row, both taken while the board was visible
// and focused and no more than WATCH_GAP_MS apart, mean they watched everything
// between them happen live, so nothing is added. Any other read (the tab was
// hidden or unfocused, or this is the first read after coming back) compares
// against the last snapshot and adds what moved to the pending list.

export type SeenKind = 'done' | 'started' | 'needs_you' | 'new' | 'cancelled' | 'moved'

export interface SeenRecord {
  v: 1
  /** When the snapshot was last taken. */
  at: number
  /** Whether the person was watching when it was taken. */
  watching: boolean
  /** Each task's column at that read, by task id. */
  columns: Record<string, string>
  /** Changes not looked at yet, and when the person was last caught up. */
  pending: { since: number; items: Record<string, SeenKind> } | null
}

/** The longest gap between two watched reads that still counts as watching throughout. */
export const WATCH_GAP_MS = 15_000

export const SEEN_KINDS: readonly SeenKind[] = [
  'done',
  'started',
  'needs_you',
  'new',
  'cancelled',
  'moved',
]

type Pending = SeenRecord['pending']

const KIND_SET: ReadonlySet<string> = new Set(SEEN_KINDS)
const EMPTY_IDS: ReadonlySet<string> = new Set()

// Own-property reads only, so a task id like "toString" never finds a prototype member.
function own<T>(obj: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(obj, key) ? obj[key] : undefined
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

function isKind(v: unknown): v is SeenKind {
  return typeof v === 'string' && KIND_SET.has(v)
}

/** The pending list without these ids; null once nothing is left. */
function withoutIds(pending: Pending, ids: ReadonlySet<string>): Pending {
  if (!pending) return null
  const items = Object.entries(pending.items).filter(([id]) => !ids.has(id))
  return items.length > 0 ? { since: pending.since, items: Object.fromEntries(items) } : null
}

/** Parse a stored record. Anything that is not exactly the current shape reads as none. */
export function readSeen(raw: string | null): SeenRecord | null {
  if (raw === null) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!isPlainObject(parsed)) return null
  const { v, at, watching, columns, pending } = parsed
  if (v !== 1 || !isFiniteNumber(at) || typeof watching !== 'boolean') return null
  if (!isPlainObject(columns)) return null
  const columnEntries = Object.entries(columns)
  if (!columnEntries.every(([, col]) => typeof col === 'string')) return null

  let outPending: Pending = null
  if (pending !== null) {
    if (!isPlainObject(pending) || !isFiniteNumber(pending.since)) return null
    if (!isPlainObject(pending.items)) return null
    const itemEntries = Object.entries(pending.items)
    if (!itemEntries.every(([, kind]) => isKind(kind))) return null
    outPending = {
      since: pending.since,
      items: Object.fromEntries(itemEntries) as Record<string, SeenKind>,
    }
  }
  return {
    v: 1,
    at,
    watching,
    columns: Object.fromEntries(columnEntries) as Record<string, string>,
    pending: outPending,
  }
}

/** What a move from `before` to `after` means to the person, or null when it did not move. */
export function seenKindOf(before: string | undefined, after: string): SeenKind | null {
  if (before === after) return null
  if (before === undefined) {
    if (after === 'done' || after === 'cancelled' || after === 'needs_you') return after
    return 'new'
  }
  if (after === 'done' || after === 'needs_you' || after === 'cancelled') return after
  if (after === 'in_progress') return 'started'
  return 'moved'
}

/**
 * Whether the person watched everything between the record's read and a read
 * taken at `at`: both reads taken while watching, close enough together.
 */
export function watchedThrough(prev: SeenRecord, at: number, watching: boolean): boolean {
  return watching && prev.watching && at - prev.at <= WATCH_GAP_MS
}

/** Fold one read of the board into the record. */
export function noteRead(
  prev: SeenRecord | null,
  read: ReadonlyArray<{ id: string; column: string }>,
  at: number,
  watching: boolean,
): SeenRecord {
  // The snapshot is always exactly this read, so the record never outgrows the board.
  const columns: Record<string, string> = Object.fromEntries(read.map((t) => [t.id, t.column]))
  // The first look sees everything.
  if (!prev) return { v: 1, at, watching, columns, pending: null }

  const continuous = watchedThrough(prev, at, watching)
  const items = new Map<string, SeenKind>(Object.entries(prev.pending?.items ?? {}))
  for (const [id, column] of Object.entries(columns)) {
    const kind = seenKindOf(own(prev.columns, id), column)
    if (kind === null) continue
    // Watching: they saw it move, so an older unseen change is no longer news.
    if (continuous) items.delete(id)
    else items.set(id, kind)
  }
  for (const id of [...items.keys()]) {
    if (!Object.hasOwn(columns, id)) items.delete(id)
  }

  const pending: Pending =
    items.size > 0
      ? { since: prev.pending?.since ?? prev.at, items: Object.fromEntries(items) }
      : null
  return { v: 1, at, watching, columns, pending }
}

/** The person has looked at these changes. */
export function acknowledge(rec: SeenRecord, ids: Iterable<string>): SeenRecord {
  return { ...rec, pending: withoutIds(rec.pending, new Set(ids)) }
}

/** The person has looked at everything. */
export function markAllSeen(rec: SeenRecord): SeenRecord {
  return { ...rec, pending: null }
}

/** Record the person's own change, so it never comes back as news. */
export function absorb(rec: SeenRecord, id: string, column: string): SeenRecord {
  return {
    ...rec,
    columns: { ...rec.columns, [id]: column },
    pending: withoutIds(rec.pending, new Set([id])),
  }
}

export interface SeenSummary {
  since: number
  counts: Record<SeenKind, number>
  total: number
}

/** How many unseen changes of each kind, or null when there are none. */
export function seenSummary(rec: SeenRecord | null): SeenSummary | null {
  if (!rec?.pending) return null
  const counts = Object.fromEntries(SEEN_KINDS.map((k) => [k, 0])) as Record<SeenKind, number>
  let total = 0
  for (const kind of Object.values(rec.pending.items)) {
    counts[kind] += 1
    total += 1
  }
  return { since: rec.pending.since, counts, total }
}

const KIND_LABEL: Record<SeenKind, string> = {
  done: 'done',
  started: 'started',
  needs_you: 'needs you',
  new: 'new',
  cancelled: 'cancelled',
  moved: 'moved',
}

/** The one phrase whose verb follows its count: "1 needs you", "2 need you". */
const labelFor = (kind: SeenKind, n: number): string =>
  kind === 'needs_you' && n !== 1 ? 'need you' : KIND_LABEL[kind]

/** The nonzero counts as short phrases, in SEEN_KINDS order: "3 done", "1 needs you". */
export function summaryParts(counts: Record<SeenKind, number>): string[] {
  return SEEN_KINDS.filter((k) => counts[k] > 0).map(
    (k) => `${counts[k]} ${labelFor(k, counts[k])}`,
  )
}

/** Task ids that get an unseen dot. Needs you keeps its own list, so its changes are counted but not dotted. */
export function dottedIds(rec: SeenRecord | null): ReadonlySet<string> {
  if (!rec?.pending) return EMPTY_IDS
  const ids = Object.entries(rec.pending.items)
    .filter(([, kind]) => kind !== 'needs_you')
    .map(([id]) => id)
  return ids.length > 0 ? new Set(ids) : EMPTY_IDS
}
