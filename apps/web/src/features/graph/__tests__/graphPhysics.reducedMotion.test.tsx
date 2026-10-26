// graphPhysics under `prefers-reduced-motion: reduce`.
//
// A SEPARATE file, and `.tsx` on purpose: that routes it to the jsdom project
// (which has a `window` to stub) and leaves the 18 KB node-env `graphPhysics.test.ts`
// completely untouched — that suite's whole premise is `wake()` ⇒ `isActive()`,
// which still holds because the helper reports "motion allowed" with no
// matchMedia at all.
//
// The contract: reduced motion means NO LOOP, not no settle. A wake runs the
// simulation to rest in one go and the nodes land where the animation would
// have left them, so any overlap the starting positions hold still resolves.

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

/** Two Boos dropped almost on top of each other, and one well clear of both. */
const PILED: GraphNode[] = [booNode('a1', 0, 0), booNode('a2', 40, 10), booNode('a3', 900, 0)]

/**
 * Re-import the module singleton so its lazy subscription reads the current
 * stub, with the store it writes to (the same fresh module graph).
 */
async function freshPhysics() {
  vi.resetModules()
  const { graphPhysics } = await import('../graphPhysics')
  const { useGraphStore } = await import('../store')
  return { graphPhysics, useGraphStore }
}

type Store = Awaited<ReturnType<typeof freshPhysics>>['useGraphStore']

function positions(store: Store): Record<string, { x: number; y: number }> {
  return Object.fromEntries(store.getState().nodes.map((n) => [n.id, n.position]))
}

function gap(store: Store, a: string, b: string): number {
  const p = positions(store)
  return Math.hypot(p[a]!.x - p[b]!.x, p[a]!.y - p[b]!.y)
}

// Frames by hand: each one advances the clock by three fixed steps, so the
// animated run is deterministic and fast.
let frames: FrameRequestCallback[] = []
let clock = 0

function runFrames(max = 2000) {
  for (let i = 0; i < max && frames.length > 0; i++) {
    const due = frames
    frames = []
    clock += 50
    for (const cb of due) cb(clock)
  }
}

beforeEach(() => {
  frames = []
  clock = 0
  window.requestAnimationFrame = ((cb: FrameRequestCallback) =>
    frames.push(cb)) as typeof requestAnimationFrame
  window.cancelAnimationFrame = (() => {}) as typeof cancelAnimationFrame
})

afterEach(() => {
  window.matchMedia = original
})

describe('graphPhysics with reduced motion requested', () => {
  it('never starts the loop', async () => {
    stubMatchMedia(true)
    const { graphPhysics, useGraphStore } = await freshPhysics()
    useGraphStore.setState({ nodes: NODES, edges: EDGES })

    graphPhysics.initialize(NODES, EDGES)
    expect(graphPhysics.isActive()).toBe(false)

    graphPhysics.wake()
    expect(graphPhysics.isActive()).toBe(false)
    expect(frames).toHaveLength(0)

    graphPhysics.dispose()
  })

  it('lands overlapping Boos apart within the wake itself', async () => {
    stubMatchMedia(true)
    const { graphPhysics, useGraphStore } = await freshPhysics()
    useGraphStore.setState({ nodes: PILED, edges: [] })
    graphPhysics.initialize(PILED, [])

    graphPhysics.wake(0.25)

    // No frame ran: the store already holds the settled positions.
    expect(frames).toHaveLength(0)
    expect(gap(useGraphStore, 'boo-a1', 'boo-a2')).toBeGreaterThan(150)
    // A Boo nothing touched stays exactly where it was.
    expect(positions(useGraphStore)['boo-a3']).toEqual({ x: 900, y: 0 })

    graphPhysics.dispose()
  })

  it('lands where the animation comes to rest', async () => {
    // The animated run, motion allowed.
    stubMatchMedia(false)
    const animated = await freshPhysics()
    animated.useGraphStore.setState({ nodes: PILED, edges: [] })
    animated.graphPhysics.initialize(PILED, [])
    animated.graphPhysics.wake(0.25)
    expect(animated.graphPhysics.isActive()).toBe(true)
    runFrames()
    expect(animated.graphPhysics.isActive()).toBe(false)
    const rest = positions(animated.useGraphStore)
    animated.graphPhysics.dispose()

    // The same wake with reduced motion requested.
    stubMatchMedia(true)
    const reduced = await freshPhysics()
    reduced.useGraphStore.setState({ nodes: PILED, edges: [] })
    reduced.graphPhysics.initialize(PILED, [])
    reduced.graphPhysics.wake(0.25)
    const landed = positions(reduced.useGraphStore)

    for (const id of Object.keys(rest)) {
      // Within the loop's own write threshold (POSITION_EPSILON, 0.02).
      expect(landed[id]!.x).toBeCloseTo(rest[id]!.x, 1)
      expect(landed[id]!.y).toBeCloseTo(rest[id]!.y, 1)
    }
    reduced.graphPhysics.dispose()
  })

  // A drag moves only the dragged node; its release settles the rest, the way
  // the animated release would.
  it('holds still through a drag and settles on release', async () => {
    stubMatchMedia(true)
    const { graphPhysics, useGraphStore } = await freshPhysics()
    const apart = [booNode('a1', 0, 0), booNode('a2', 600, 0)]
    useGraphStore.setState({ nodes: apart, edges: [] })
    graphPhysics.initialize(apart, [])

    graphPhysics.pinNode('boo-a2')
    // The drag puts a2 on top of a1; the wake the store fires changes nothing.
    useGraphStore.setState({
      nodes: useGraphStore
        .getState()
        .nodes.map((n) => (n.id === 'boo-a2' ? { ...n, position: { x: 30, y: 0 } } : n)),
    })
    graphPhysics.wake()
    expect(positions(useGraphStore)['boo-a1']).toEqual({ x: 0, y: 0 })

    graphPhysics.unpinNode('boo-a2')
    expect(graphPhysics.isActive()).toBe(false)
    expect(frames).toHaveLength(0)
    expect(gap(useGraphStore, 'boo-a1', 'boo-a2')).toBeGreaterThan(150)

    graphPhysics.dispose()
  })

  // A collapsed Boo's tiles are invisible and touch only each other, so the
  // settle leaves them out; they settle with their Boo once it opens.
  it("settles a collapsed Boo's tiles only once it opens", async () => {
    stubMatchMedia(true)
    const { graphPhysics, useGraphStore } = await freshPhysics()
    // Three tiles stacked on one spot: siblings that would push apart.
    const stacked = [
      booNode('a1', 0, 0),
      skillNode('a1', 'one', 150, 0),
      skillNode('a1', 'two', 150, 0),
      skillNode('a1', 'three', 150, 0),
    ]
    const edges = [skillEdge('a1', 'one'), skillEdge('a1', 'two'), skillEdge('a1', 'three')]
    useGraphStore.setState({ nodes: stacked, edges, expandedBooNodeIds: new Set() })
    graphPhysics.initialize(stacked, edges)

    graphPhysics.wake()
    expect(positions(useGraphStore)['skill-a1-two']).toEqual({ x: 150, y: 0 })

    useGraphStore.setState({ expandedBooNodeIds: new Set(['boo-a1']) })
    graphPhysics.wake()
    expect(gap(useGraphStore, 'skill-a1-one', 'skill-a1-two')).toBeGreaterThan(40)
    expect(frames).toHaveLength(0)

    graphPhysics.dispose()
  })

  it('leaves restart inert', async () => {
    stubMatchMedia(true)
    const { graphPhysics } = await freshPhysics()
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
    const { graphPhysics } = await freshPhysics()

    graphPhysics.initialize(NODES, EDGES)
    graphPhysics.wake()
    expect(graphPhysics.isActive()).toBe(true)

    graphPhysics.dispose()
    expect(graphPhysics.isActive()).toBe(false)
  })
})
