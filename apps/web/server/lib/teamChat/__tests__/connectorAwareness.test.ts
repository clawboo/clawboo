// The clause that tells an agent what it could have.
//
// Its job is not to list connectors. It is to stop an agent working around a
// missing one, which is what they all do by default: browse to the vendor's
// site, hit a login wall, and ask the human to sign in to an account the human
// is already signed in to.

import { describe, expect, it } from 'vitest'

import { buildConnectorAwareness } from '../connectorAwareness'

describe('buildConnectorAwareness', () => {
  it('says nothing on a turn no human will read', () => {
    // A suggestion on a background worker's turn is spent on a transcript nobody
    // opens, and it rides EVERY request's context to get there.
    expect(buildConnectorAwareness({ connected: [], isUserFacing: false })).toBeNull()
    expect(buildConnectorAwareness({ connected: ['memory'], isUserFacing: false })).toBeNull()
  })

  it('forbids the workarounds, which is the part that changes behaviour', () => {
    const block = buildConnectorAwareness({ connected: [], isUserFacing: true })!
    expect(block).toMatch(/Never work around a missing connector/i)
    expect(block).toMatch(/Do not browse to the vendor/i)
    expect(block).toMatch(/Never ask the user to sign in/i)
  })

  it('prices each offer, so the agent asks differently for each', () => {
    // The thing clawboo can do that the reference implementations cannot: their
    // catalogues carry no cost, so the best they can say is "you do not have X".
    const block = buildConnectorAwareness({ connected: [], isUserFacing: true })!
    expect(block).toMatch(/one click/i)
    expect(block).toMatch(/needs a key/i)
  })

  it('names what is already usable, and does not offer it again', () => {
    const block = buildConnectorAwareness({ connected: ['memory'], isUserFacing: true })!
    expect(block).toMatch(/Connected and usable right now: .*Knowledge Graph Memory/)
    expect(block).toMatch(/mcp__/)
    const offered = block.split('Not connected, but the user can add these:')[1] ?? ''
    expect(offered).not.toMatch(/Knowledge Graph Memory/)
  })

  it('names a connected CUSTOM connector instead of an empty list', () => {
    // The names came from filtering the catalog by the live slugs, so a connector
    // the operator added themselves matched nothing and the sentence rendered as
    // "Connected and usable right now: ." with an empty list.
    const block = buildConnectorAwareness({ connected: ['my-own-server'], isUserFacing: true })!
    expect(block).toMatch(/Connected and usable right now: my-own-server\./)
  })

  it('caps the offer, because this rides every turn', () => {
    const block = buildConnectorAwareness({ connected: [], isUserFacing: true })!
    const offered = block.split('Not connected, but the user can add these:')[1]!.split('\n')[0]!
    expect(offered.split(';').length).toBeLessThanOrEqual(6)
  })

  it('names one of EVERY tier, not just the cheapest', () => {
    // Straight cheapest-first filled the whole budget with zero-input developer
    // tools and never mentioned Notion or Figma, so an agent asked about a Notion
    // page would still conclude no such thing was possible.
    const block = buildConnectorAwareness({ connected: [], isUserFacing: true })!
    const offered = block.split('Not connected, but the user can add these:')[1]!.split('\n')[0]!
    expect(offered).toMatch(/nothing to set up/)
    expect(offered).toMatch(/they sign in/)
    expect(offered).toMatch(/needs a key/)
    // Cheapest still leads, so the agent's first suggestion is the easiest one.
    expect(offered.indexOf('nothing to set up')).toBeLessThan(offered.indexOf('needs a key'))
  })
})
