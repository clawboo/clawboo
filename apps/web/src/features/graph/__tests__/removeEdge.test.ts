// What the canvas will and will not let you take back.
//
// The rule these pin: a surface that can only ADD is a surface people stop
// trusting. Everything the canvas can author it must also be able to remove,
// and everything it CANNOT remove must say so rather than offering a delete
// that silently does nothing or reappears on the next inventory read.

import { describe, expect, it } from 'vitest'

import { edgeRemovalRefusal } from '../operations/removeEdge'
import type { GraphEdge } from '../types'

const edge = (type: string, data: Record<string, unknown> = {}): GraphEdge =>
  ({ id: 'e1', source: 'boo-a', target: 't1', type, data }) as unknown as GraphEdge

describe('edgeRemovalRefusal', () => {
  it('allows a routing edge, which is a line in a markdown file', () => {
    expect(edgeRemovalRefusal(edge('dependency'))).toBeNull()
  })

  it('allows a curated skill, which is what the canvas installed', () => {
    expect(edgeRemovalRefusal(edge('skill', { capabilityId: 'c1', removable: true }))).toBeNull()
  })

  it('refuses a runtime built-in: it has a record, but the agent came with it', () => {
    const why = edgeRemovalRefusal(
      edge('skill', { capabilityId: 'native:builtins', removable: false }),
    )
    expect(why).toBeTruthy()
    expect(why).toMatch(/runtime/i)
  })

  it('refuses a synthetic orbital, which is a graph attribute and not a record', () => {
    // The model tile and the Leadership badge carry no capabilityId at all.
    const why = edgeRemovalRefusal(edge('skill', {}))
    expect(why).toBeTruthy()
    expect(why).toMatch(/part of the agent/i)
  })

  it('allows a grant-backed share, which is a revocable row', () => {
    expect(edgeRemovalRefusal(edge('grant', { grantId: 'g1' }))).toBeNull()
  })

  it('refuses a connector edge with no grant behind it', () => {
    const why = edgeRemovalRefusal(edge('resource', {}))
    expect(why).toBeTruthy()
    expect(why).toMatch(/grant/i)
  })

  it('refuses an edge type it does not know, rather than guessing a write', () => {
    expect(edgeRemovalRefusal(edge('mystery'))).toBeTruthy()
  })
})
