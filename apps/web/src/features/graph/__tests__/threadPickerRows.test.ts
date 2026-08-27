// The picker's mode machine, which is the whole behaviour of the two-step.
//
// The table in threadPickerRows.ts is the specification; these lock it down,
// plus the two properties that make the second step worth having: the chooser
// disappears the moment anything is typed, and a kind with nothing behind it is
// never offered.

import { describe, expect, it } from 'vitest'

import {
  availableKinds,
  nextEnabled,
  rowEnabled,
  threadCounts,
  threadPickerRows,
  type Row,
  type ThreadOption,
} from '../threadPickerRows'

const connector = (id: string, over: Partial<ThreadOption> = {}): ThreadOption => ({
  id: `connector:${id}`,
  kind: 'connector',
  label: id,
  slug: id,
  ...over,
})

const skill = (id: string, over: Partial<ThreadOption> = {}): ThreadOption => ({
  id: `skill:${id}`,
  kind: 'skill',
  label: id,
  ...over,
})

const OPTIONS: ThreadOption[] = [
  connector('notion'),
  connector('github', { disabledReason: 'Add key in the Connectors tab first' }),
  skill('Linter', { hint: 'Lint code for style issues' }),
  skill('Test Runner'),
]

const labels = (rows: Row[]): string[] =>
  rows.map((r) =>
    r.type === 'kind'
      ? `kind:${r.kind}`
      : r.type === 'option'
        ? r.option.label
        : `create:${r.name}`,
  )

describe('threadPickerRows', () => {
  it('opens on the chooser, not on a list', () => {
    const { rows, sections } = threadPickerRows({
      kind: null,
      query: '',
      options: OPTIONS,
      allowNewAgent: true,
    })
    expect(labels(rows)).toEqual(['kind:connector', 'kind:skill', 'kind:agent'])
    expect(sections).toEqual([{ label: 'What to add', start: 0, end: 3 }])
  })

  it('replaces the chooser the moment anything is typed', () => {
    const { rows } = threadPickerRows({
      kind: null,
      query: 'no',
      options: OPTIONS,
      allowNewAgent: true,
    })
    expect(labels(rows).some((l) => l.startsWith('kind:'))).toBe(false)
    expect(labels(rows)).toEqual(['notion', 'create:no'])
  })

  it('searches every kind at once from the chooser, connectors first', () => {
    const { rows, sections } = threadPickerRows({
      kind: null,
      query: 'n',
      options: OPTIONS,
      allowNewAgent: true,
    })
    // 'n' hits notion, Linter (via its hint) and Test Runner.
    expect(sections.map((s) => s.label)).toEqual(['Connectors', 'Skills', 'New agent'])
    expect(labels(rows)[0]).toBe('notion')
  })

  it('shows one kind only once a kind is chosen', () => {
    const { rows, sections } = threadPickerRows({
      kind: 'skill',
      query: '',
      options: OPTIONS,
      allowNewAgent: true,
    })
    expect(labels(rows)).toEqual(['Linter', 'Test Runner'])
    expect(sections.map((s) => s.label)).toEqual(['Skills'])
  })

  it('offers no create-agent row inside a kind', () => {
    const { rows } = threadPickerRows({
      kind: 'connector',
      query: 'zzz',
      options: OPTIONS,
      allowNewAgent: true,
    })
    expect(rows).toEqual([])
  })

  it('names the new agent from the query', () => {
    const { rows } = threadPickerRows({
      kind: 'agent',
      query: '  Scout  ',
      options: OPTIONS,
      allowNewAgent: true,
    })
    expect(rows).toEqual([{ type: 'createAgent', name: 'Scout' }])
  })

  it('leaves out a kind with nothing behind it', () => {
    const onlyConnectors = OPTIONS.filter((o) => o.kind === 'connector')
    expect(availableKinds(onlyConnectors, false)).toEqual(['connector'])
    const { rows } = threadPickerRows({
      kind: null,
      query: '',
      options: onlyConnectors,
      allowNewAgent: false,
    })
    expect(labels(rows)).toEqual(['kind:connector'])
  })

  it('sections address the flat row array exactly', () => {
    const { rows, sections } = threadPickerRows({
      kind: null,
      query: 'n',
      options: OPTIONS,
      allowNewAgent: true,
    })
    for (const s of sections) {
      expect(s.end).toBeGreaterThan(s.start)
      expect(rows.slice(s.start, s.end).length).toBe(s.end - s.start)
    }
    expect(sections.at(-1)?.end).toBe(rows.length)
  })
})

describe('threadCounts', () => {
  it('separates what can be finished here from what is merely listed', () => {
    expect(threadCounts(OPTIONS)).toEqual({ connector: 2, connectorReady: 1, skill: 2 })
  })
})

describe('rowEnabled and nextEnabled', () => {
  it('refuses a connector that needs a key, and an unnamed agent', () => {
    expect(rowEnabled({ type: 'option', option: OPTIONS[1]! })).toBe(false)
    expect(rowEnabled({ type: 'option', option: OPTIONS[0]! })).toBe(true)
    expect(rowEnabled({ type: 'createAgent', name: '' })).toBe(false)
    expect(rowEnabled({ type: 'createAgent', name: 'Scout' })).toBe(true)
    expect(rowEnabled(undefined)).toBe(false)
  })

  it('steps over an inert row rather than landing on it', () => {
    const { rows } = threadPickerRows({
      kind: null,
      query: '',
      options: OPTIONS,
      allowNewAgent: false,
    })
    // Chooser rows are all committable, so this is the plain wrap case.
    expect(nextEnabled(rows, 0, 1)).toBe(1)
    expect(nextEnabled(rows, 1, 1)).toBe(0)
    expect(nextEnabled(rows, 0, -1)).toBe(1)
  })

  it('skips the key-needing connector when arrowing through a kind', () => {
    const { rows } = threadPickerRows({
      kind: 'connector',
      query: '',
      options: OPTIONS,
      allowNewAgent: false,
    })
    expect(labels(rows)).toEqual(['notion', 'github'])
    // github is inert, so moving off notion wraps back to notion.
    expect(nextEnabled(rows, 0, 1)).toBe(0)
  })

  it('reports no target when every row is inert', () => {
    const allInert = [connector('github', { disabledReason: 'Add key' })]
    const { rows } = threadPickerRows({
      kind: 'connector',
      query: '',
      options: allInert,
      allowNewAgent: false,
    })
    expect(nextEnabled(rows, 0, 1)).toBe(-1)
    expect(nextEnabled([], 0, 1)).toBe(-1)
  })
})
