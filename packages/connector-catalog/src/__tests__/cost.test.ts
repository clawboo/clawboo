// The card's price tag. One predicate, so the shelf and the detail pane cannot
// disagree about what a connector will cost the reader.

import { describe, expect, it } from 'vitest'

import { CONNECTOR_DEFINITIONS, connectorBySlug } from '../index'
import { isReachable } from '../connectable'
import { byCost, connectorCost, COST_COPY, costRank } from '../cost'

describe('connectorCost', () => {
  it('calls a zero-input connector READY, not "not connected"', () => {
    // Five entries need nothing at all. They used to render "Not connected"
    // beside a Connect button, which reads as a chore for something that is one
    // gesture away.
    expect(connectorCost(connectorBySlug('memory')!)).toBe('ready')
    expect(connectorCost(connectorBySlug('playwright')!)).toBe('ready')
  })

  it('separates the three costs a user actually pays', () => {
    expect(connectorCost(connectorBySlug('linear')!)).toBe('one-click')
    expect(connectorCost(connectorBySlug('notion')!)).toBe('needs-key')
    expect(connectorCost(connectorBySlug('filesystem')!)).toBe('needs-folder')
  })

  it('reports ON over every other state', () => {
    // Live is the truth from the server and outranks anything derived from the
    // definition.
    expect(connectorCost(connectorBySlug('notion')!, { connected: true })).toBe('on')
    expect(connectorCost(connectorBySlug('memory')!, { connected: true })).toBe('on')
  })

  it('drops to READY once what it asked for is stored', () => {
    // The regression this exists for: a card that says "Needs a key" for a key
    // the operator entered last week is the same class of lie as a Connect
    // button the server refuses.
    expect(connectorCost(connectorBySlug('notion')!, { configured: true })).toBe('ready')
    expect(connectorCost(connectorBySlug('filesystem')!, { configured: true })).toBe('ready')
  })

  it('treats UNKNOWN configuration as different from unconfigured', () => {
    // A surface that has not fetched configuration must show the cost CLASS,
    // never assert the connector is unset up.
    expect(connectorCost(connectorBySlug('notion')!, {})).toBe('needs-key')
    expect(connectorCost(connectorBySlug('notion')!, { configured: false })).toBe('needs-key')
  })

  it('gives every catalog entry exactly one cost, and a word for it', () => {
    for (const def of CONNECTOR_DEFINITIONS) {
      const cost = connectorCost(def)
      expect(COST_COPY[cost]).toBeTruthy()
      expect(COST_COPY[cost].label.length).toBeGreaterThan(0)
      expect(COST_COPY[cost].action.length).toBeGreaterThan(0)
    }
  })

  it('orders the shelf by distance from working', () => {
    const ordered = byCost(CONNECTOR_DEFINITIONS, (d) => connectorCost(d))
    const ranks = ordered.map((d) => costRank(connectorCost(d)))
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b))
    // The top of the shelf is what you can have right now.
    expect(connectorCost(ordered[0]!)).toBe('ready')
  })

  it('is stable within a rank, so the shelf does not reshuffle under the reader', () => {
    const a = byCost(CONNECTOR_DEFINITIONS, (d) => connectorCost(d)).map((d) => d.slug)
    const b = byCost([...CONNECTOR_DEFINITIONS].reverse(), (d) => connectorCost(d)).map(
      (d) => d.slug,
    )
    expect(a).toEqual(b)
  })
})

describe('the price tag never invents an action the server would refuse', () => {
  it('prices an unreachable entry as BLOCKED rather than inventing a price', () => {
    // The regression this exists for: an entry that satisfies none of the
    // solvable predicates used to fall through to `ready`, putting a "Turn on"
    // button on something the server can never accept. GitHub was that entry
    // until it became a bearer connector, so the case is asserted against a
    // synthetic definition and the catalog-wide agreement test below is what
    // guards the real entries.
    const unreachable = {
      ...connectorBySlug('linear')!,
      auth: { ...connectorBySlug('linear')!.auth, needsPreregisteredApp: true },
    }
    expect(connectorCost(unreachable)).toBe('blocked')
    expect(COST_COPY.blocked.action).toBe('Why not')
  })

  it('prices GitHub as a key question now that its server takes a token', () => {
    const github = connectorBySlug('github')!
    expect(connectorCost(github)).toBe('needs-key')
    expect(connectorCost(github, { configured: true })).toBe('ready')
  })

  it('agrees with isReachable for every entry in the catalog', () => {
    // Two predicates, one truth. `connectRefusal` decides whether the server
    // would accept; this decides what to put on the card. They may never
    // disagree about whether an entry is obtainable at all.
    for (const def of CONNECTOR_DEFINITIONS) {
      const blocked = connectorCost(def) === 'blocked'
      expect(blocked).toBe(!isReachable(def))
    }
  })

  it('leaves nothing unobtainable in the shipped catalog', () => {
    // The strongest form of "the shelf is long and everything on it is
    // obtainable": there is no "cannot" tier left, only a "how far" tier.
    const blocked = CONNECTOR_DEFINITIONS.filter((d) => connectorCost(d) === 'blocked')
    expect(blocked.map((d) => d.slug)).toEqual([])
  })
})
