// One grammar for both canvases.
//
// The Ghost Graph and the agent detail view's MiniGraph each carried their own
// answer to "may these connect", and the MiniGraph's was narrower: it allowed
// only skill→boo, so dragging a connector onto an agent worked on one surface
// and snapped back with no message on the other.

import { describe, expect, it } from 'vitest'

import { connectionRefusal, isConnectionAllowed } from '../connectionGrammar'

describe('connectionGrammar', () => {
  it('allows the three pairs the canvas can actually write', () => {
    expect(connectionRefusal('skill', 'boo', false)).toBeNull()
    expect(connectionRefusal('resource', 'boo', false)).toBeNull()
    expect(connectionRefusal('boo', 'boo', false)).toBeNull()
  })

  it('refuses an agent routing to itself, and says why', () => {
    expect(connectionRefusal('boo', 'boo', true)).toMatch(/itself/i)
  })

  it('points at the agent when the target is anything else', () => {
    expect(connectionRefusal('skill', 'skill', false)).toMatch(/on an agent/i)
    expect(connectionRefusal('boo', 'resource', false)).toMatch(/on an agent/i)
  })

  it('refuses an unknown source onto an agent rather than allowing it', () => {
    expect(connectionRefusal('team-root', 'boo', false)).toBe('That connection is not supported.')
  })

  it('gives React Flow the boolean without a second implementation', () => {
    // The regression this pins: the MiniGraph derived its own boolean and drifted.
    for (const [s, t, same] of [
      ['skill', 'boo', false],
      ['resource', 'boo', false],
      ['boo', 'boo', false],
      ['boo', 'boo', true],
      ['skill', 'skill', false],
    ] as const) {
      expect(isConnectionAllowed(s, t, same)).toBe(connectionRefusal(s, t, same) === null)
    }
  })

  it('treats an undefined type as unconnectable rather than throwing', () => {
    expect(isConnectionAllowed(undefined, undefined, false)).toBe(false)
  })
})

describe('connectionGrammar: the single-agent surface', () => {
  // The agent detail view draws ONE Boo. Widening its validity to match the big
  // canvas without widening its handler made a resource drop validate, land,
  // and do nothing: exactly the silent no-op the shared grammar exists to stop.
  it('refuses routing there, because there is no second agent to route to', () => {
    expect(connectionRefusal('boo', 'boo', false, 'single-agent')).toMatch(/only one agent/i)
    expect(isConnectionAllowed('boo', 'boo', false, 'single-agent')).toBe(false)
  })

  it('refuses sharing there, and points at the surface that can do it', () => {
    expect(connectionRefusal('resource', 'boo', false, 'single-agent')).toMatch(/full graph/i)
  })

  it('still allows the one direction that surface CAN write', () => {
    expect(connectionRefusal('skill', 'boo', false, 'single-agent')).toBeNull()
  })

  it('leaves the full canvas unnarrowed', () => {
    expect(connectionRefusal('boo', 'boo', false, 'canvas')).toBeNull()
    expect(connectionRefusal('resource', 'boo', false, 'canvas')).toBeNull()
  })
})
