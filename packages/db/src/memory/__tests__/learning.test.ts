import { describe, expect, it } from 'vitest'

import { computeLearningOverlay, LEARNING_HALF_LIFE_MS } from '../learning'
import type { MemoryOutcome, OutcomeKind } from '../types'

const NOW = 1_800_000_000_000 // fixed "now" — the overlay is pure

let seq = 0
function outcome(
  factId: string,
  kind: OutcomeKind,
  ageMs: number,
  extra: Partial<MemoryOutcome> = {},
): MemoryOutcome {
  seq += 1
  return {
    id: `o-${String(seq).padStart(4, '0')}`,
    factId,
    outcome: kind,
    note: null,
    agentId: null,
    teamId: null,
    taskId: null,
    runtime: null,
    createdAt: NOW - ageMs,
    ...extra,
  }
}

describe('computeLearningOverlay — decay math', () => {
  it('halves a signal weight at exactly one half-life', () => {
    const fresh = computeLearningOverlay([outcome('f', 'useful', 0)], NOW).get('f')!
    const aged = computeLearningOverlay([outcome('f', 'useful', LEARNING_HALF_LIFE_MS)], NOW).get(
      'f',
    )!
    expect(fresh.score).toBe(1)
    expect(aged.score).toBe(0.5)
  })

  it('a future timestamp clamps to weight 1 (never amplifies)', () => {
    const entry = computeLearningOverlay([outcome('f', 'useful', -LEARNING_HALF_LIFE_MS)], NOW).get(
      'f',
    )!
    expect(entry.score).toBe(1)
  })

  it('recency wins: a new dead_end overrides aged-out useful signals (contested, verdict avoid)', () => {
    const entries = computeLearningOverlay(
      [outcome('f', 'useful', 4 * LEARNING_HALF_LIFE_MS), outcome('f', 'dead_end', 0)],
      NOW,
    )
    const e = entries.get('f')!
    expect(e.status).toBe('contested')
    expect(e.verdict).toBe('avoid')
    expect(e.score).toBeLessThan(0)
  })
})

describe('computeLearningOverlay — corroboration + status', () => {
  it('the same (agent, task) reporter twice stays tentative; two distinct reporters mint preferred', () => {
    const same = computeLearningOverlay(
      [
        outcome('f', 'useful', 0, { agentId: 'a1', taskId: 't1' }),
        outcome('f', 'useful', 0, { agentId: 'a1', taskId: 't1' }),
      ],
      NOW,
    ).get('f')!
    expect(same.status).toBe('tentative')
    expect(same.usefulCount).toBe(1)

    const distinct = computeLearningOverlay(
      [
        outcome('f', 'useful', 0, { agentId: 'a1', taskId: 't1' }),
        outcome('f', 'useful', 0, { agentId: 'a2', taskId: 't2' }),
      ],
      NOW,
    ).get('f')!
    expect(distinct.status).toBe('preferred')
    expect(distinct.usefulCount).toBe(2)
  })

  it('one agent across two tasks also corroborates (cross-task signal is genuine)', () => {
    const e = computeLearningOverlay(
      [
        outcome('f', 'useful', 0, { agentId: 'a1', taskId: 't1' }),
        outcome('f', 'useful', 0, { agentId: 'a1', taskId: 't2' }),
      ],
      NOW,
    ).get('f')!
    expect(e.status).toBe('preferred')
  })

  it('negatives only → dead_end; corrected counts as a negative', () => {
    const e = computeLearningOverlay(
      [outcome('f', 'corrected', 0, { note: 'actually port 18790' })],
      NOW,
    ).get('f')!
    expect(e.status).toBe('dead_end')
    expect(e.negativeCount).toBe(1)
  })

  it('an exact score tie on contested resolves to avoid (conservative)', () => {
    const e = computeLearningOverlay(
      [outcome('f', 'useful', 0), outcome('f', 'dead_end', 0)],
      NOW,
    ).get('f')!
    expect(e.status).toBe('contested')
    expect(e.score).toBe(0)
    expect(e.verdict).toBe('avoid')
  })

  it('cited-only facts get a null status with honest uses/lastUsedAt', () => {
    const e = computeLearningOverlay(
      [outcome('f', 'cited', 1000), outcome('f', 'cited', 0)],
      NOW,
    ).get('f')!
    expect(e.status).toBeNull()
    expect(e.score).toBe(0)
    expect(e.uses).toBe(2)
    expect(e.lastUsedAt).toBe(NOW)
  })
})

describe('computeLearningOverlay — determinism + trail', () => {
  it('is byte-stable under input shuffle', () => {
    const rows = [
      outcome('f1', 'useful', 1000, { agentId: 'a1' }),
      outcome('f1', 'dead_end', 500),
      outcome('f1', 'cited', 0),
      outcome('f2', 'useful', 0, { agentId: 'a2', taskId: 't9' }),
      outcome('f2', 'useful', 100, { agentId: 'a3', taskId: 't2' }),
    ]
    const forward = computeLearningOverlay(rows, NOW)
    const reversed = computeLearningOverlay([...rows].reverse(), NOW)
    expect(Object.fromEntries(reversed)).toEqual(Object.fromEntries(forward))
    expect(JSON.stringify([...reversed])).toBe(JSON.stringify([...forward]))
  })

  it('recentTrail is newest-first and capped at trailSize', () => {
    const rows = [0, 1, 2, 3, 4, 5, 6].map((i) =>
      outcome('f', 'cited', i * 1000, { taskId: `t${i}` }),
    )
    const e = computeLearningOverlay(rows, NOW, { trailSize: 3 }).get('f')!
    expect(e.recentTrail).toHaveLength(3)
    expect(e.recentTrail.map((t) => t.taskId)).toEqual(['t0', 't1', 't2'])
    expect(e.uses).toBe(7)
  })

  it('empty input → empty map', () => {
    expect(computeLearningOverlay([], NOW).size).toBe(0)
  })
})
