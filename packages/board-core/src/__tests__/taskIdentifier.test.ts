import { describe, expect, it } from 'vitest'

import {
  firstFreeTaskPrefix,
  isTaskIdentifier,
  isValidTaskPrefix,
  normalizeTaskPrefix,
  normalizeTaskTitle,
  taskPrefixCandidates,
} from '../taskIdentifier'

function firstCandidates(name: string, n: number): string[] {
  const out: string[] = []
  for (const c of taskPrefixCandidates(name)) {
    out.push(c)
    if (out.length === n) break
  }
  return out
}

describe('taskPrefixCandidates', () => {
  it('starts with three letters of the name, then the next free sets', () => {
    expect(firstCandidates('Marketing', 4)).toEqual(['MAR', 'MA2', 'MA3', 'MA4'])
  })

  it('skips spaces, digits and marks, and folds accents', () => {
    expect(firstCandidates('3D Team', 1)).toEqual(['DTE'])
    expect(firstCandidates('Équipe Été', 1)).toEqual(['EQU'])
  })

  it('keeps a two-letter name as it is', () => {
    expect(firstCandidates('QA', 2)).toEqual(['QA', 'QA2'])
  })

  it('gives a name with no usable letters a working prefix', () => {
    expect(firstCandidates('チーム', 2)).toEqual(['TEA', 'TE2'])
    expect(firstCandidates('X', 1)).toEqual(['XTE'])
  })

  it('never runs out, past the single digits', () => {
    const many = firstCandidates('Marketing', 12)
    expect(many[9]).toBe('MA10')
    expect(new Set(many).size).toBe(12)
    for (const c of many) expect(isValidTaskPrefix(c)).toBe(true)
  })
})

describe('firstFreeTaskPrefix', () => {
  it('takes the first set nobody holds', () => {
    const taken = new Set(['MAR', 'MA2'])
    expect(firstFreeTaskPrefix('Marathon', (p) => taken.has(p))).toBe('MA3')
    expect(firstFreeTaskPrefix('Sales', (p) => taken.has(p))).toBe('SAL')
  })
})

describe('prefix validity', () => {
  it('takes two to six letters and digits, starting with a letter', () => {
    expect(isValidTaskPrefix('CLB')).toBe(true)
    expect(isValidTaskPrefix('MA2')).toBe(true)
    expect(isValidTaskPrefix('AB')).toBe(true)
    expect(isValidTaskPrefix('ABCDEF')).toBe(true)
    expect(isValidTaskPrefix('A')).toBe(false)
    expect(isValidTaskPrefix('ABCDEFG')).toBe(false)
    expect(isValidTaskPrefix('2AB')).toBe(false)
    expect(isValidTaskPrefix('A-B')).toBe(false)
    expect(isValidTaskPrefix('abc')).toBe(false)
  })

  it('normalizes what a person types', () => {
    expect(normalizeTaskPrefix('  clb ')).toBe('CLB')
  })
})

describe('isTaskIdentifier', () => {
  it('reads an identifier and not a UUID', () => {
    expect(isTaskIdentifier('CLB-12')).toBe(true)
    expect(isTaskIdentifier('clb-12')).toBe(true)
    expect(isTaskIdentifier('MA2-1')).toBe(true)
    expect(isTaskIdentifier('5f2d0a64-7a4f-4a6b-9c1e-1f1f1f1f1f1f')).toBe(false)
    expect(isTaskIdentifier('CLB-0')).toBe(false)
    expect(isTaskIdentifier('CLB')).toBe(false)
  })
})

describe('normalizeTaskTitle', () => {
  it('ignores case, spacing and surrounding punctuation', () => {
    const want = normalizeTaskTitle('Write the tests')
    expect(normalizeTaskTitle('  write   THE tests. ')).toBe(want)
    expect(normalizeTaskTitle('"Write the tests!"')).toBe(want)
    expect(normalizeTaskTitle('Write\nthe\ttests')).toBe(want)
  })

  it('keeps different words different', () => {
    expect(normalizeTaskTitle('Write the tests')).not.toBe(normalizeTaskTitle('Write the docs'))
  })

  it('does not fold two titles of only punctuation into one', () => {
    expect(normalizeTaskTitle('???')).not.toBe(normalizeTaskTitle('!!!'))
  })
})
