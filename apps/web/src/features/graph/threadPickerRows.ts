// Which rows the thread picker shows, for a given kind and query.
//
// PURE, and separate from the component, because this is the whole behaviour of
// the picker and none of it needs a DOM. The component owns focus, motion and
// the layer stack; this owns the question "what is on screen right now", which
// is the part with edge cases worth locking down.
//
// FOUR MODES, and the table is the specification:
//
//   kind    query   rows
//   null    empty   one chooser row per kind that has something behind it
//   null    text    matching connectors, then skills, then a create-agent row
//   a kind  any     that kind's matches only
//   agent   any     one create-agent row, named by the query
//
// The chooser is on screen ONLY while the query is empty, which is what makes
// typing skip it. Two things fall out of that and neither needs code: choosing
// a kind never has to clear the query, and backspacing to empty is already the
// way back.

/** The three things a thread can end in. */
export type ThreadKind = 'connector' | 'skill' | 'agent'

/** A thing the thread could end in. */
export interface ThreadOption {
  id: string
  /** Which chooser row owns this option. Agents are a branch, never a row. */
  kind: 'connector' | 'skill'
  label: string
  /** One line, truncated. */
  hint?: string
  /** The verb the row commits to, e.g. "Turn on" or "Add key". */
  action?: string
  /** A connector slug, so the row can carry the real brand mark. */
  slug?: string
  /** Rows that cannot be completed on the canvas render inert with a reason. */
  disabledReason?: string
}

export type Row =
  | { type: 'kind'; kind: ThreadKind }
  | { type: 'option'; option: ThreadOption }
  | { type: 'createAgent'; name: string }

export interface Section {
  label: string
  /** Index of this section's first row in the flat `rows` array. */
  start: number
  /** One past its last. */
  end: number
}

export const KIND_LABEL: Readonly<Record<ThreadKind, string>> = {
  connector: 'Connectors',
  skill: 'Skills',
  agent: 'New agent',
}

export interface ThreadRowsInput {
  kind: ThreadKind | null
  /** Raw, as typed. Trimmed here so callers cannot disagree about it. */
  query: string
  options: readonly ThreadOption[]
  allowNewAgent: boolean
}

export interface ThreadRows {
  /** One flat, index-addressable array in every mode, so a highlight is always meaningful. */
  rows: Row[]
  /** Group wrappers over `rows`. Headings are not rows and are not selectable. */
  sections: Section[]
}

/** How many of each kind are on offer, for the chooser's sub-lines. */
export function threadCounts(options: readonly ThreadOption[]): {
  connector: number
  connectorReady: number
  skill: number
} {
  const connectors = options.filter((o) => o.kind === 'connector')
  return {
    connector: connectors.length,
    connectorReady: connectors.filter((o) => !o.disabledReason).length,
    skill: options.filter((o) => o.kind === 'skill').length,
  }
}

/**
 * The kinds worth offering.
 *
 * A kind with nothing behind it is left out: every skill already installed is a
 * real state, and a chooser row that opens an empty list is the dead end the
 * chooser exists to prevent.
 */
export function availableKinds(
  options: readonly ThreadOption[],
  allowNewAgent: boolean,
): ThreadKind[] {
  const counts = threadCounts(options)
  const out: ThreadKind[] = []
  if (counts.connector > 0) out.push('connector')
  if (counts.skill > 0) out.push('skill')
  if (allowNewAgent) out.push('agent')
  return out
}

function matches(o: ThreadOption, q: string): boolean {
  return o.label.toLowerCase().includes(q) || (o.hint ?? '').toLowerCase().includes(q)
}

export function threadPickerRows(input: ThreadRowsInput): ThreadRows {
  const name = input.query.trim()
  const q = name.toLowerCase()
  const rows: Row[] = []
  const sections: Section[] = []
  const push = (label: string, items: Row[]): void => {
    if (items.length === 0) return
    sections.push({ label, start: rows.length, end: rows.length + items.length })
    rows.push(...items)
  }

  if (input.kind === 'agent') {
    push(KIND_LABEL.agent, [{ type: 'createAgent', name }])
    return { rows, sections }
  }

  if (input.kind === null && q === '') {
    push(
      'What to add',
      availableKinds(input.options, input.allowNewAgent).map((k) => ({
        type: 'kind' as const,
        kind: k,
      })),
    )
    return { rows, sections }
  }

  const pool = input.options.filter((o) => input.kind === null || o.kind === input.kind)
  const hits = q === '' ? pool : pool.filter((o) => matches(o, q))
  for (const k of ['connector', 'skill'] as const) {
    if (input.kind !== null && input.kind !== k) continue
    push(
      KIND_LABEL[k],
      hits.filter((o) => o.kind === k).map((o) => ({ type: 'option' as const, option: o })),
    )
  }
  // The query doubles as the name, the way Linear and GitHub offer "create one
  // called ..." under a search that found nothing quite right. It replaces a
  // second text field that used to sit inside the list and fight the search box
  // for keystrokes.
  if (input.kind === null && input.allowNewAgent && name !== '') {
    push(KIND_LABEL.agent, [{ type: 'createAgent', name }])
  }
  return { rows, sections }
}

/** Whether this row can be committed. An inert row still renders and still reads. */
export function rowEnabled(row: Row | undefined): boolean {
  if (!row) return false
  if (row.type === 'option') return !row.option.disabledReason
  if (row.type === 'createAgent') return row.name !== ''
  return true
}

/** The next committable row in `delta` direction, wrapping. Returns -1 when none is. */
export function nextEnabled(rows: readonly Row[], from: number, delta: number): number {
  if (rows.length === 0) return -1
  let i = from
  for (let n = 0; n < rows.length; n += 1) {
    i = (i + delta + rows.length) % rows.length
    if (rowEnabled(rows[i])) return i
  }
  return rowEnabled(rows[from]) ? from : -1
}
