// What Home's numbers and words say: every value names where it came from, and
// times, targets and progress read the way the page shows them.

import { describe, expect, it } from 'vitest'

import type { KpiTile } from '@clawboo/control-client'

import {
  actorName,
  formatKpiValue,
  formatUsd,
  fromDateInput,
  kpiWindow,
  meetsTarget,
  progressPercent,
  progressWords,
  provenanceWords,
  reasonLabel,
  relativeTime,
  scopeWords,
  sourceBadge,
  staleWords,
  targetDateWords,
  targetPercent,
  targetWords,
  toDateInput,
} from '../homeFormat'

const NOW = new Date(2026, 10, 16, 12, 0, 0).getTime()
const H = 3_600_000

function tile(kpi: Partial<KpiTile['kpi']>, reading: Partial<KpiTile['reading']> = {}): KpiTile {
  const k = {
    id: 'k1',
    teamId: 't1',
    goalId: null,
    name: 'Signups',
    unit: 'signups',
    direction: 'up' as const,
    target: null,
    period: 'week' as const,
    source: 'person' as const,
    metric: null,
    reporterAgentId: null,
    staleAfterHours: null,
    status: 'active' as const,
    suggestedBy: null,
    suggestionNote: null,
    createdBy: null,
    position: 0,
    createdAt: NOW,
    updatedAt: NOW,
    ...kpi,
  }
  return {
    kpi: k,
    reading: {
      value: null,
      asOf: null,
      source: k.source,
      periodStart: null,
      latest: null,
      freshness: 'missing',
      ...reading,
    },
  }
}

const names = { meId: 'local', agentName: (id: string) => (id === 'a1' ? 'Iris' : null) }

describe('values in their unit', () => {
  it('leads with $, trails % tightly and other units with a space', () => {
    expect(formatKpiValue(12.5, '$')).toBe('$12.50')
    expect(formatKpiValue(31, '%')).toBe('31%')
    expect(formatKpiValue(142, 'signups')).toBe('142 signups')
    expect(formatKpiValue(1234.6, '')).toBe('1,235')
    expect(formatKpiValue(2.345, 'hours')).toBe('2.35 hours')
    expect(formatUsd(0.004)).toBe('$0.0040')
  })
})

describe('where a value came from', () => {
  it('says computed from the board, runs or the budget for a computed KPI', () => {
    const t = tile(
      { source: 'computed', metric: 'tasks_done' },
      { value: 3, asOf: NOW, freshness: 'ok' },
    )
    expect(sourceBadge(t, names)).toBe('Computed')
    expect(provenanceWords(t, NOW, names)).toBe('Computed from the board, as of just now')
    expect(
      provenanceWords(
        tile({ source: 'computed', metric: 'spend_usd' }, { value: 1, asOf: NOW }),
        NOW,
        names,
      ),
    ).toMatch(/^Computed from runs/)
  })

  it('names the agent that reported a value, and the person who typed one', () => {
    const agentValue = {
      id: 'v1',
      kpiId: 'k1',
      value: 142,
      asOf: NOW - 3 * H,
      reportedBy: { kind: 'agent' as const, id: 'a1', name: 'old name' },
      executionId: 'e1',
      taskId: 'task-1',
      sourceUrl: null,
      note: null,
      createdAt: NOW - 3 * H,
    }
    const byAgent = tile(
      { source: 'agent' },
      { value: 142, asOf: NOW - 3 * H, latest: agentValue, freshness: 'ok' },
    )
    expect(sourceBadge(byAgent, names)).toBe('Iris')
    expect(provenanceWords(byAgent, NOW, names)).toBe('Reported by Iris 3h ago')

    const byMe = tile(
      { source: 'person' },
      {
        value: 31,
        asOf: NOW - 2 * H,
        freshness: 'ok',
        latest: { ...agentValue, reportedBy: { kind: 'person', id: 'local', name: 'You' } },
      },
    )
    expect(sourceBadge(byMe, names)).toBe('You')
    expect(provenanceWords(byMe, NOW, names)).toBe('Typed by you 2h ago')
  })

  it('says when no value has come in yet', () => {
    expect(provenanceWords(tile({ source: 'agent' }), NOW, names)).toBe('No value reported yet')
    expect(provenanceWords(tile({ source: 'person' }), NOW, names)).toBe('No value typed yet')
  })

  it('reads an agent by its name in the fleet, else the stored name', () => {
    expect(actorName({ kind: 'agent', id: 'a1', name: 'x' }, names)).toBe('Iris')
    expect(actorName({ kind: 'agent', id: 'gone', name: 'Old' }, names)).toBe('Old')
    expect(actorName({ kind: 'person', id: 'local', name: 'Sam' }, names)).toBe('you')
    expect(actorName({ kind: 'person', id: 'p2', name: 'Sam' }, names)).toBe('Sam')
    expect(actorName(null)).toBe('someone')
  })
})

describe('staleness', () => {
  it('says how old the last value is against how often one is expected', () => {
    const t = tile(
      { source: 'agent', staleAfterHours: 24 },
      { value: 1, asOf: NOW - 30 * H, freshness: 'stale' },
    )
    expect(staleWords(t, NOW)).toBe('Stale: last value 1d ago, expected every day')
    const fresh = { ...t, reading: { ...t.reading, asOf: NOW - 2 * H, freshness: 'ok' as const } }
    expect(staleWords(fresh, NOW)).toBeNull()
  })

  it('turns stale on the clock once the value passes its threshold', () => {
    // Read as fresh, then left open: 30 hours on, a daily value is stale.
    const t = tile(
      { source: 'person', staleAfterHours: 24 },
      { value: 1, asOf: NOW - 30 * H, freshness: 'ok' },
    )
    expect(staleWords(t, NOW)).toBe('Stale: last value 1d ago, expected every day')
    expect(staleWords(t, NOW - 7 * H)).toBeNull()
    // A computed KPI is worked out on read and never goes stale; nor does one with no
    // threshold, or no value yet.
    expect(staleWords({ ...t, kpi: { ...t.kpi, source: 'computed' } }, NOW)).toBeNull()
    expect(staleWords({ ...t, kpi: { ...t.kpi, staleAfterHours: null } }, NOW)).toBeNull()
    expect(
      staleWords({ ...t, reading: { ...t.reading, asOf: null, freshness: 'missing' } }, NOW),
    ).toBeNull()
  })
})

describe('targets and windows', () => {
  it('reads the target in the KPI direction', () => {
    expect(targetWords({ target: 200, unit: 'signups', direction: 'up' })).toBe(
      'target 200 signups',
    )
    expect(targetWords({ target: 25, unit: '$', direction: 'down' })).toBe('target at most $25.00')
    expect(targetWords({ target: null, unit: '', direction: 'up' })).toBeNull()
  })

  it('tells whether the value meets its target, and how far along it is', () => {
    const up = tile({ target: 200 }, { value: 142 })
    expect(meetsTarget(up)).toBe(false)
    expect(targetPercent(up)).toBe(71)
    const down = tile({ target: 25, direction: 'down' }, { value: 11 })
    expect(meetsTarget(down)).toBe(true)
    // A bar toward a lower-is-better target means nothing.
    expect(targetPercent(down)).toBeNull()
    expect(meetsTarget(tile({ target: 5 }))).toBeNull()
  })

  it('reads a point-in-time metric as Now, others by their period', () => {
    expect(kpiWindow({ source: 'computed', metric: 'open_requests', period: 'week' })).toBe('Now')
    expect(kpiWindow({ source: 'computed', metric: 'tasks_done', period: 'month' })).toBe(
      'Last 30 days',
    )
    expect(kpiWindow({ source: 'person', metric: null, period: 'all' })).toBe('All time')
  })
})

describe('progress', () => {
  const p = { total: 8, done: 3, doneChecked: 2, addedLast7Days: 3, doneLast7Days: 2 }
  it('counts done over linked, with how many passed their check', () => {
    expect(progressPercent(p)).toBe(38)
    expect(progressWords(p)).toBe('3 of 8 tasks done, 2 checked')
    expect(progressWords({ ...p, total: 0, done: 0 })).toBe('No linked tasks yet')
    expect(progressPercent({ total: 0, done: 0 })).toBe(0)
  })

  it('says how the scope moved this week', () => {
    expect(scopeWords(p)).toBe('+3 added, 2 done this week')
    expect(scopeWords({ ...p, addedLast7Days: 0, doneLast7Days: 0 })).toBeNull()
  })
})

describe('time', () => {
  it('reads past times short, and a time a moment ahead as just now', () => {
    expect(relativeTime(NOW - 10_000, NOW)).toBe('just now')
    expect(relativeTime(NOW - 5 * 60_000, NOW)).toBe('5m ago')
    expect(relativeTime(NOW - 26 * H, NOW)).toBe('1d ago')
    // The server stamps a read a few seconds after the page's clock ticked.
    expect(relativeTime(NOW + 20_000, NOW)).toBe('just now')
    expect(relativeTime(NOW + 3 * H, NOW)).toBe('in 3h')
  })

  it('says when a target date is near or late', () => {
    expect(targetDateWords(NOW, NOW)).toEqual({ text: 'Due today', overdue: false })
    expect(targetDateWords(NOW + 24 * H, NOW)).toEqual({ text: 'Due tomorrow', overdue: false })
    expect(targetDateWords(NOW - 48 * H, NOW)).toEqual({
      text: 'Due Nov 14, 2d late',
      overdue: true,
    })
  })

  it('round-trips a date field', () => {
    const at = fromDateInput('2026-12-04')!
    expect(toDateInput(at)).toBe('2026-12-04')
    expect(fromDateInput('not a date')).toBeNull()
    expect(toDateInput(null)).toBe('')
  })
})

describe('needs you reasons', () => {
  it("uses the Board's words, and a readable fallback", () => {
    expect(reasonLabel('unassigned')).toBe('Unassigned')
    expect(reasonLabel('some_new_reason')).toBe('Some new reason')
  })
})
