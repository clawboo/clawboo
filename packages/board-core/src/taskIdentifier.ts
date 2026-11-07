// ─── Readable task ids ──────────────────────────────────────────────────────
// A task's readable id is its team's prefix and a number, like `CLB-12`. The
// prefix is letters from the team's name, unique across the workspace; a clash
// takes the next free set, like `MA2`. These are the pure rules: which sets a
// name may take, what a person may type, and what an id looks like. The database
// layer picks and stores one inside its write transaction.
//
// Import-free, like the rest of board-core: it ships into the Vite SPA.

/** Two to six letters and digits, starting with a letter: what a person may set. */
const PREFIX_RE = /^[A-Z][A-Z0-9]{1,5}$/

/** A prefix, a dash and a number from 1, in either case. A UUID never matches: it
 *  has four dashes. */
const IDENTIFIER_RE = /^[A-Za-z][A-Za-z0-9]{1,9}-[1-9][0-9]*$/

/** Pads a name too short to make a prefix, and stands in for one with no letters
 *  the prefix can use. */
const FALLBACK_LETTERS = 'TEAM'

/** The latin letters of a team's name, upper-cased, with accents folded. */
function lettersOf(name: string): string {
  return name
    .normalize('NFKD')
    .toUpperCase()
    .replace(/[^A-Z]/g, '')
}

/**
 * The prefixes a team of this name may take, best first: three letters of its
 * name, then its first two letters and a number from 2 up. A two-letter name
 * keeps its two letters. Endless, so a caller always finds a free one.
 */
export function* taskPrefixCandidates(teamName: string): Generator<string, never, void> {
  const letters = lettersOf(teamName)
  const base = letters.length >= 2 ? letters.slice(0, 3) : (letters + FALLBACK_LETTERS).slice(0, 3)
  yield base
  const stem = base.slice(0, 2)
  for (let n = 2; ; n += 1) yield `${stem}${n}`
}

/** The first prefix for this name that `taken` says nobody holds. */
export function firstFreeTaskPrefix(teamName: string, taken: (prefix: string) => boolean): string {
  for (const candidate of taskPrefixCandidates(teamName)) {
    if (!taken(candidate)) return candidate
  }
  throw new Error('unreachable: the candidates never run out')
}

export function normalizeTaskPrefix(raw: string): string {
  return raw.trim().toUpperCase()
}

export function isValidTaskPrefix(prefix: string): boolean {
  return PREFIX_RE.test(prefix)
}

export function formatTaskIdentifier(prefix: string, n: number): string {
  return `${prefix}-${n}`
}

/** Does this read as a readable task id? It says nothing of whether the task exists. */
export function isTaskIdentifier(ref: string): boolean {
  return IDENTIFIER_RE.test(ref)
}

/**
 * A title as the duplicate check compares it: same words, whatever the case,
 * spacing or surrounding punctuation. A title of nothing but punctuation stays
 * as it is, so two different ones do not fold into one empty string.
 */
export function normalizeTaskTitle(title: string): string {
  const spaced = title.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim()
  return stripEdgePunctuation(spaced) || spaced
}

/** Walks in from each end, so a very long title of punctuation stays linear: a regex
 *  anchored on the end would retry from every position. */
function stripEdgePunctuation(text: string): string {
  const chars = Array.from(text)
  let start = 0
  let end = chars.length
  while (start < end && EDGE_CHAR.test(chars[start]!)) start += 1
  while (end > start && EDGE_CHAR.test(chars[end - 1]!)) end -= 1
  return chars.slice(start, end).join('')
}

const EDGE_CHAR = /^[\p{P}\p{S}\s]$/u

/** How long a hand-off's title may be; the engine keeps the whole ask as the
 *  description. A title this long may be cut, so it alone does not say two asks
 *  are the same. */
export const HAND_OFF_TITLE_CHARS = 200
