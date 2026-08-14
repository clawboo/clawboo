// graphPhysics under `prefers-reduced-motion: reduce`.
//
// A SEPARATE file, and `.tsx` on purpose: that routes it to the jsdom project
// (which has a `window` to stub) and leaves the 18 KB node-env `graphPhysics.test.ts`
// completely untouched — that suite's whole premise is `wake()` ⇒ `isActive()`,
// which still holds because the helper reports "motion allowed" with no
// matchMedia at all.
//
// The contract: reduced motion means NEVER RUN the relaxation loop, not "snap to
// settled". ELK + computeOrbitalPositions already produce a complete,
// non-overlapping layout; physics is post-hoc relaxation. So the graph stays
// correct — only the settling animation and post-drag re-relaxation are skipped.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { GraphEdge, GraphNode } from '../types'

const original = window.matchMedia

function stubMatchMedia(matches: boolean) {
  window.matchMedia = (() => ({
    matches,
    media: '(prefers-reduced-motion: reduce)',
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia
}

function booNode(id: string, x: number, y: number): GraphNode {
  return {
    id: `boo-${id}`,
    type: 'boo',
    position: { x, y },
    data: { agentId: id, name: `Agent ${id}`, status: 'idle', model: null, isStreaming: false },
  } as GraphNode
}

function skillNode(agentId: string, skillId: string, x: number, y: number): GraphNode {
  return {
    id: `skill-${agentId}-${skillId}`,
    type: 'skill',
    position: { x, y },
    data: { skillId, name: skillId, category: 'code', description: null, agentIds: [agentId] },
  } as GraphNode
}

function skillEdge(agentId: string, skillId: string): GraphEdge {
  return {
    id: `skilledge-${agentId}-${skillId}`,
    type: 'skill',
    source: `boo-${agentId}`,
    target: `skill-${agentId}-${skillId}`,
    sourceHandle: 'center',
    targetHandle: 'center',
    data: {},
  } as GraphEdge
}

const NODES: GraphNode[] = [booNode('a1', 0, 0), skillNode('a1', 'web', 150, 0)]
const EDGES: GraphEdge[] = [skillEdge('a1', 'web')]

/** Re-import the module singleton so its lazy subscription reads the current stub. */
async function freshPhysics() {
  vi.resetModules()
  const { graphPhysics } = await import('../graphPhysics')
  return graphPhysics
}

beforeEach(() => {
  window.requestAnimationFrame = ((cb: FrameRequestCallback) =>
    setTimeout(() => cb(performance.now()), 0) as unknown as number) as typeof requestAnimationFrame
  window.cancelAnimationFrame = ((id: number) => clearTimeout(id)) as typeof cancelAnimationFrame
})

afterEach(() => {
  window.matchMedia = original
})

describe('graphPhysics with reduced motion requested', () => {
  it('initializes state but never starts the loop', async () => {
    stubMatchMedia(true)
    const graphPhysics = await freshPhysics()

    graphPhysics.initialize(NODES, EDGES)
    expect(graphPhysics.isActive()).toBe(false)

    graphPhysics.wake()
    expect(graphPhysics.isActive()).toBe(false)

    graphPhysics.dispose()
  })

  // pinNode/unpinNode still maintain particle state — a drag must be preserved
  // even though nothing relaxes afterwards.
  it('keeps pin / unpin working without waking the loop', async () => {
    stubMatchMedia(true)
    const graphPhysics = await freshPhysics()
    graphPhysics.initialize(NODES, EDGES)

    graphPhysics.pinNode('boo-a1')
    graphPhysics.unpinNode('boo-a1')
    expect(graphPhysics.isActive()).toBe(false)

    graphPhysics.dispose()
  })

  it('leaves restart inert', async () => {
    stubMatchMedia(true)
    const graphPhysics = await freshPhysics()
    graphPhysics.initialize(NODES, EDGES)

    graphPhysics.restart()
    expect(graphPhysics.isActive()).toBe(false)

    graphPhysics.dispose()
  })
})

describe('graphPhysics with motion allowed', () => {
  // The mirror case, so the guard is proven preference-driven rather than an
  // unconditional kill switch.
  it('still starts the loop on wake', async () => {
    stubMatchMedia(false)
    const graphPhysics = await freshPhysics()

    graphPhysics.initialize(NODES, EDGES)
    graphPhysics.wake()
    expect(graphPhysics.isActive()).toBe(true)

    graphPhysics.dispose()
    expect(graphPhysics.isActive()).toBe(false)
  })
})
