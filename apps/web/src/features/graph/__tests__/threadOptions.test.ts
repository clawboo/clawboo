// What the picker is allowed to offer.
//
// The rows are priced from one source and filtered from another, and the two go
// out of step whenever either is stale. These lock the properties that keep a
// stale moment from producing a row whose label and handler disagree.

import { describe, expect, it } from 'vitest'

import type { ConnectorCost, ConnectorDefinition } from '@clawboo/connector-catalog'

import { looseNodeId } from '../looseNodes'
import { threadOptionsFor } from '../threadOptions'

const base = {
  fromNodeType: 'boo',
  ownedSkillNames: new Set<string>(),
  liveConnectorSlugs: new Set<string>(),
}

const priced =
  (cost: ConnectorCost) =>
  (_def: ConnectorDefinition): ConnectorCost =>
    cost

const connectors = (opts: ReturnType<typeof threadOptionsFor>) =>
  opts.filter((o) => o.kind === 'connector')

describe('threadOptionsFor', () => {
  it('offers nothing from a node that cannot spawn', () => {
    expect(
      threadOptionsFor({ ...base, fromNodeType: 'skill', costOf: priced('one-click') }),
    ).toEqual([])
  })

  it('offers a connector that is already on, as access to give', () => {
    // Connecting no longer grants anybody, so a running connector this agent
    // does not have is exactly the thing a thread should be able to end in. The
    // shelf's verb for that state is "Turn off", which is a switch for the whole
    // install and the wrong offer to make on a thread that names one agent.
    const rows = connectors(threadOptionsFor({ ...base, costOf: priced('on') }))
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.every((r) => r.action === 'Give access')).toBe(true)
    expect(rows.every((r) => r.disabledReason === undefined)).toBe(true)
  })

  it('offers a connector that can be finished here, with no reason to refuse it', () => {
    const rows = connectors(threadOptionsFor({ ...base, costOf: priced('one-click') }))
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.every((r) => r.disabledReason === undefined)).toBe(true)
  })

  it('lists a connector that needs setup, but inert and carrying the reason', () => {
    const rows = connectors(threadOptionsFor({ ...base, costOf: priced('needs-key') }))
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.every((r) => typeof r.disabledReason === 'string')).toBe(true)
  })

  it('offers an authorised brokered app, keyed on the BROKER toolkit', () => {
    // The grant is checked against the toolkit read off a call's arguments, so
    // the row must carry `googlesheets` and not clawboo's `google-sheets`.
    const rows = threadOptionsFor({
      ...base,
      costOf: priced('needs-key'),
      brokeredApps: [
        { toolkit: 'googlesheets', slug: 'google-sheets', name: 'Google Sheets', description: 'x' },
      ],
    }).filter((o) => o.id.startsWith('brokered:'))
    expect(rows).toHaveLength(1)
    expect(rows[0]!.id).toBe('brokered:googlesheets')
    expect(rows[0]!.slug).toBe('google-sheets')
    expect(rows[0]!.action).toBe('Give access')
    expect(rows[0]!.disabledReason).toBeUndefined()
  })

  it('never offers an app this agent already holds', () => {
    const rows = threadOptionsFor({
      ...base,
      costOf: priced('needs-key'),
      brokeredApps: [
        { toolkit: 'gmail', slug: 'gmail', name: 'Gmail', description: 'x' },
        { toolkit: 'googlesheets', slug: 'google-sheets', name: 'Google Sheets', description: 'x' },
      ],
      agentToolkits: new Set(['gmail']),
    }).filter((o) => o.id.startsWith('brokered:'))
    expect(rows.map((r) => r.id)).toEqual(['brokered:googlesheets'])
  })

  it('drops a connector already live on the canvas', () => {
    const all = connectors(threadOptionsFor({ ...base, costOf: priced('one-click') }))
    const first = all[0]!
    const fewer = connectors(
      threadOptionsFor({
        ...base,
        liveConnectorSlugs: new Set([first.slug!]),
        costOf: priced('one-click'),
      }),
    )
    expect(fewer.map((r) => r.slug)).not.toContain(first.slug)
    expect(fewer).toHaveLength(all.length - 1)
  })
})

describe('threadOptionsFor, free mode (the + button)', () => {
  const free = {
    fromNodeType: null,
    mode: 'free' as const,
    ownedSkillNames: new Set<string>(),
    liveConnectorSlugs: new Set<string>(),
  }

  it('offers rows with no agent behind them', () => {
    const rows = threadOptionsFor({ ...free, costOf: priced('one-click') })
    expect(rows.some((r) => r.kind === 'skill')).toBe(true)
    expect(rows.some((r) => r.kind === 'connector')).toBe(true)
  })

  it('places a running connector rather than offering access to nobody', () => {
    const rows = connectors(threadOptionsFor({ ...free, costOf: priced('on') }))
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.every((r) => r.action === 'Add')).toBe(true)
  })

  it('never offers a second copy of what is already on the canvas', () => {
    const all = threadOptionsFor({ ...free, costOf: priced('on') })
    const skill = all.find((r) => r.kind === 'skill')!
    const connector = all.find((r) => r.kind === 'connector')!
    const onCanvas = new Set([
      looseNodeId('skill', skill.id.slice('skill:'.length)),
      looseNodeId('connector', connector.id.slice('connector:'.length)),
    ])
    const rows = threadOptionsFor({ ...free, costOf: priced('on'), onCanvas })
    expect(rows.some((r) => r.id === skill.id)).toBe(false)
    expect(rows.some((r) => r.id === connector.id)).toBe(false)
  })

  it('ignores what an agent already holds, since no agent is named', () => {
    const all = threadOptionsFor({ ...free, costOf: priced('on') })
    const skill = all.find((r) => r.kind === 'skill')!
    const rows = threadOptionsFor({
      ...free,
      costOf: priced('on'),
      ownedSkillNames: new Set([skill.label]),
    })
    expect(rows.some((r) => r.id === skill.id)).toBe(true)
  })
})
