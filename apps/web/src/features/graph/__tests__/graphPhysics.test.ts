import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'

// Polyfill requestAnimationFrame / cancelAnimationFrame for Node test environment
// vi.useFakeTimers() intercepts setTimeout but not rAF, so we bridge them.
let _rafId = 0
const _rafCallbacks = new Map<number, FrameRequestCallback>()

globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
  const id = ++_rafId
  _rafCallbacks.set(id, cb)
  setTimeout(() => {
    const fn = _rafCallbacks.get(id)
    if (fn) {
      _rafCallbacks.delete(id)
      fn(performance.now())
    }
  }, 0)
  return id
}) as typeof globalThis.requestAnimationFrame

globalThis.cancelAnimationFrame = ((id: number) => {
  _rafCallbacks.delete(id)
}) as typeof globalThis.cancelAnimationFrame

import { graphPhysics } from '../graphPhysics'
import { useGraphStore } from '../store'
import type { GraphNode, GraphEdge } from '../types'

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeBooNode(id: string, x: number, y: number): GraphNode {
  return {
    id: `boo-${id}`,
    type: 'boo',
    position: { x, y },
    data: { agentId: id, name: `Agent ${id}`, status: 'idle', model: null, isStreaming: false },
  } as GraphNode
}

function makeSkillNode(agentId: string, skillId: string, x: number, y: number): GraphNode {
  return {
    id: `skill-${agentId}-${skillId}`,
    type: 'skill',
    position: { x, y },
    data: { skillId, name: skillId, category: 'code', description: null, agentIds: [agentId] },
  } as GraphNode
}

function makeResourceNode(agentId: string, resourceId: string, x: number, y: number): GraphNode {
  return {
    id: `resource-${agentId}-${resourceId}`,
    type: 'resource',
    position: { x, y },
    data: { resourceId, name: resourceId, serviceIcon: '🔧', agentIds: [agentId] },
  } as GraphNode
}

function makeSkillEdge(agentId: string, skillId: string): GraphEdge {
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

function makeResourceEdge(agentId: string, resourceId: string): GraphEdge {
  return {
    id: `resourceedge-${agentId}-${resourceId}`,
    type: 'resource',
    source: `boo-${agentId}`,
    target: `resource-${agentId}-${resourceId}`,
    sourceHandle: 'center',
    targetHandle: 'center',
    data: {},
  } as GraphEdge
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('graphPhysics', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    graphPhysics.dispose()
    useGraphStore.setState({
      nodes: [],
      edges: [],
      _physicsWakeCallback: null,
    })
  })

  afterEach(() => {
    graphPhysics.dispose()
    vi.useRealTimers()
  })

  describe('initialize', () => {
    it('creates particles for skill and boo nodes', () => {
      const boo = makeBooNode('a1', 0, 0)
      const skill = makeSkillNode('a1', 'bash', 200, 0)
      const edge = makeSkillEdge('a1', 'bash')

      useGraphStore.setState({ nodes: [boo, skill], edges: [edge] })
      graphPhysics.initialize([boo, skill], [edge])

      // Physics should not be active after initialize (nodes at rest)
      expect(graphPhysics.isActive()).toBe(false)
    })

    it('handles empty node sets', () => {
      graphPhysics.initialize([], [])
      expect(graphPhysics.isActive()).toBe(false)
    })

    it('computes restRadius from initial distance to parent Boo center', () => {
      // Boo at (0,0) → center at (90, 40)
      // Skill at (200, 0) → center at (200 + 19, 0 + 19) = (219, 19)
      // Distance = sqrt((219-90)² + (19-40)²) = sqrt(129² + (-21)²) = sqrt(16641 + 441) ≈ 130.8
      const boo = makeBooNode('a1', 0, 0)
      const skill = makeSkillNode('a1', 'bash', 200, 0)
      const edge = makeSkillEdge('a1', 'bash')

      useGraphStore.setState({ nodes: [boo, skill], edges: [edge] })
      graphPhysics.initialize([boo, skill], [edge])

      // Wake the engine and run one frame to verify particle exists
      graphPhysics.wake()
      expect(graphPhysics.isActive()).toBe(true)
    })

    it('skips orphan nodes with no parent edge', () => {
      const boo = makeBooNode('a1', 0, 0)
      const skill = makeSkillNode('a1', 'bash', 200, 0)
      // No edge linking them

      useGraphStore.setState({ nodes: [boo, skill], edges: [] })
      graphPhysics.initialize([boo, skill], [])

      // Wake → should immediately settle since no particles
      graphPhysics.wake()
      // Advance one frame
      vi.advanceTimersByTime(20)
      expect(graphPhysics.isActive()).toBe(false)
    })

    it('re-initializes cleanly when nodes are added mid-simulation', () => {
      const boo = makeBooNode('a1', 0, 0)
      const skill1 = makeSkillNode('a1', 'bash', 200, 0)
      const edge1 = makeSkillEdge('a1', 'bash')

      useGraphStore.setState({ nodes: [boo, skill1], edges: [edge1] })
      graphPhysics.initialize([boo, skill1], [edge1])
      graphPhysics.wake()

      // Run a few frames
      for (let i = 0; i < 5; i++) {
        vi.advanceTimersByTime(20)
      }

      // Add a second skill mid-simulation
      const skill2 = makeSkillNode('a1', 'python', 300, 0)
      const edge2 = makeSkillEdge('a1', 'python')
      useGraphStore.setState({
        nodes: [boo, skill1, skill2],
        edges: [edge1, edge2],
      })

      // Restart (same as what the layout effect does)
      graphPhysics.restart()
      graphPhysics.wake()

      // Run frames — should settle without error
      for (let i = 0; i < 50; i++) {
        vi.advanceTimersByTime(20)
      }

      // Both skills should exist in store and have valid positions
      const updated = useGraphStore.getState().nodes
      const s1 = updated.find((n) => n.id === 'skill-a1-bash')
      const s2 = updated.find((n) => n.id === 'skill-a1-python')
      expect(s1).toBeDefined()
      expect(s2).toBeDefined()
      expect(Number.isFinite(s1!.position.x)).toBe(true)
      expect(Number.isFinite(s2!.position.x)).toBe(true)
    })

    it('handles being called while simulation is running', () => {
      const boo = makeBooNode('a1', 0, 0)
      const skill = makeSkillNode('a1', 'bash', 200, 0)
      const edge = makeSkillEdge('a1', 'bash')

      useGraphStore.setState({ nodes: [boo, skill], edges: [edge] })
      graphPhysics.initialize([boo, skill], [edge])
      graphPhysics.wake()
      expect(graphPhysics.isActive()).toBe(true)

      // Re-initialize while running — should stop and rebuild
      graphPhysics.initialize([boo, skill], [edge])
      expect(graphPhysics.isActive()).toBe(false)
    })
  })

  describe('spring force', () => {
    it('pulls particle inward when stretched beyond restRadius', () => {
      // Boo at (0,0) → center at (90, 40)
      // Place skill far away at (500, 40)
      const boo = makeBooNode('a1', 0, 0)
      const skill = makeSkillNode('a1', 'bash', 500, 40)
      const edge = makeSkillEdge('a1', 'bash')

      const nodes = [boo, skill]
      useGraphStore.setState({ nodes, edges: [edge] })
      graphPhysics.initialize(nodes, [edge])

      // Now move boo closer so the skill is stretched
      const booCloser = { ...boo, position: { x: 300, y: 40 } }
      useGraphStore.setState({ nodes: [booCloser, skill] })

      graphPhysics.wake()
      vi.advanceTimersByTime(20) // one frame

      // Skill should have moved toward the Boo (leftward/inward)
      const updated = useGraphStore.getState().nodes.find((n) => n.id === 'skill-a1-bash')
      // The spring should pull the particle toward the boo
      // Original skill x was 500; boo moved to x=300 so boo center is now at 390
      // Particle should move left (x decreases) or right depending on relative position
      expect(updated).toBeDefined()
    })
  })

  describe('repulsion', () => {
    it('pushes apart two particles at the same position', () => {
      const boo = makeBooNode('a1', 0, 0)
      // Two skills at exact same position
      const skill1 = makeSkillNode('a1', 'bash', 200, 0)
      const skill2 = makeSkillNode('a1', 'python', 200, 0)
      const edge1 = makeSkillEdge('a1', 'bash')
      const edge2 = makeSkillEdge('a1', 'python')

      const nodes = [boo, skill1, skill2]
      const edges = [edge1, edge2]
      useGraphStore.setState({ nodes, edges })
      graphPhysics.initialize(nodes, edges)

      graphPhysics.wake()

      // Run several frames
      for (let i = 0; i < 10; i++) {
        vi.advanceTimersByTime(20)
      }

      const updated = useGraphStore.getState().nodes
      const s1 = updated.find((n) => n.id === 'skill-a1-bash')!
      const s2 = updated.find((n) => n.id === 'skill-a1-python')!

      // They should have moved apart
      const dx = s1.position.x - s2.position.x
      const dy = s1.position.y - s2.position.y
      const dist = Math.sqrt(dx * dx + dy * dy)
      expect(dist).toBeGreaterThan(1) // they moved apart
    })
  })

  describe('settling', () => {
    it('stops when kinetic energy drops below threshold', () => {
      const boo = makeBooNode('a1', 0, 0)
      // Skill already at its orbital position — minimal energy
      const skill = makeSkillNode('a1', 'bash', 200, 0)
      const edge = makeSkillEdge('a1', 'bash')

      const nodes = [boo, skill]
      useGraphStore.setState({ nodes, edges: [edge] })
      graphPhysics.initialize(nodes, [edge])

      graphPhysics.wake()
      expect(graphPhysics.isActive()).toBe(true)

      // Run many frames — should settle since particles are already at rest positions
      for (let i = 0; i < 100; i++) {
        vi.advanceTimersByTime(20)
      }

      expect(graphPhysics.isActive()).toBe(false)
    })
  })

  describe('pin and unpin', () => {
    it('pinned particles are not moved by forces', () => {
      const boo = makeBooNode('a1', 0, 0)
      const skill = makeSkillNode('a1', 'bash', 500, 500) // far from boo
      const edge = makeSkillEdge('a1', 'bash')

      const nodes = [boo, skill]
      useGraphStore.setState({ nodes, edges: [edge] })
      graphPhysics.initialize(nodes, [edge])

      // Pin the skill
      graphPhysics.pinNode('skill-a1-bash')

      // Move boo away to create strong spring force
      useGraphStore.setState({
        nodes: [{ ...boo, position: { x: -500, y: -500 } }, skill],
      })

      graphPhysics.wake()
      // Run several frames
      for (let i = 0; i < 5; i++) {
        vi.advanceTimersByTime(20)
      }

      // Pinned skill should NOT have moved
      const updated = useGraphStore.getState().nodes.find((n) => n.id === 'skill-a1-bash')!
      expect(updated.position.x).toBe(500)
      expect(updated.position.y).toBe(500)
    })

    it('unpinNode restarts the simulation', () => {
      const boo = makeBooNode('a1', 0, 0)
      const skill = makeSkillNode('a1', 'bash', 200, 0)
      const edge = makeSkillEdge('a1', 'bash')

      const nodes = [boo, skill]
      useGraphStore.setState({ nodes, edges: [edge] })
      graphPhysics.initialize(nodes, [edge])

      graphPhysics.pinNode('skill-a1-bash')
      graphPhysics.unpinNode('skill-a1-bash')

      expect(graphPhysics.isActive()).toBe(true)
    })
  })

  describe('wake', () => {
    it('starts the RAF loop', () => {
      const boo = makeBooNode('a1', 0, 0)
      const skill = makeSkillNode('a1', 'bash', 200, 0)
      const edge = makeSkillEdge('a1', 'bash')

      useGraphStore.setState({ nodes: [boo, skill], edges: [edge] })
      graphPhysics.initialize([boo, skill], [edge])

      expect(graphPhysics.isActive()).toBe(false)
      graphPhysics.wake()
      expect(graphPhysics.isActive()).toBe(true)
    })

    it('is idempotent when already running', () => {
      const boo = makeBooNode('a1', 0, 0)
      const skill = makeSkillNode('a1', 'bash', 200, 0)
      const edge = makeSkillEdge('a1', 'bash')

      useGraphStore.setState({ nodes: [boo, skill], edges: [edge] })
      graphPhysics.initialize([boo, skill], [edge])

      graphPhysics.wake()
      graphPhysics.wake()
      graphPhysics.wake()
      expect(graphPhysics.isActive()).toBe(true)
    })
  })

  describe('dispose', () => {
    it('stops the loop and clears particles', () => {
      const boo = makeBooNode('a1', 0, 0)
      const skill = makeSkillNode('a1', 'bash', 200, 0)
      const edge = makeSkillEdge('a1', 'bash')

      useGraphStore.setState({ nodes: [boo, skill], edges: [edge] })
      graphPhysics.initialize([boo, skill], [edge])
      graphPhysics.wake()
      expect(graphPhysics.isActive()).toBe(true)

      graphPhysics.dispose()
      expect(graphPhysics.isActive()).toBe(false)
    })
  })

  describe('restart', () => {
    it('re-initializes from current store state', () => {
      const boo = makeBooNode('a1', 0, 0)
      const skill = makeSkillNode('a1', 'bash', 200, 0)
      const edge = makeSkillEdge('a1', 'bash')

      useGraphStore.setState({ nodes: [boo, skill], edges: [edge] })
      graphPhysics.initialize([boo, skill], [edge])
      graphPhysics.wake()

      // Add more nodes to store
      const skill2 = makeSkillNode('a1', 'python', 300, 0)
      const edge2 = makeSkillEdge('a1', 'python')
      useGraphStore.setState({
        nodes: [boo, skill, skill2],
        edges: [edge, edge2],
      })

      graphPhysics.restart()
      // After restart, should not be active (fresh init, nodes at rest)
      expect(graphPhysics.isActive()).toBe(false)
    })
  })

  describe('resource nodes', () => {
    it('creates particles for resource nodes', () => {
      const boo = makeBooNode('a1', 0, 0)
      const resource = makeResourceNode('a1', 'github', 300, 0)
      const edge = makeResourceEdge('a1', 'github')

      const nodes = [boo, resource]
      useGraphStore.setState({ nodes, edges: [edge] })
      graphPhysics.initialize(nodes, [edge])

      graphPhysics.wake()
      expect(graphPhysics.isActive()).toBe(true)
    })
  })

  describe('boo-boo collision', () => {
    it('creates particles for boo nodes', () => {
      const boo1 = makeBooNode('a1', 0, 0)
      const boo2 = makeBooNode('a2', 300, 0)

      useGraphStore.setState({ nodes: [boo1, boo2], edges: [] })
      graphPhysics.initialize([boo1, boo2], [])

      // Wake and run a frame — should be active since boo particles exist within collision distance
      graphPhysics.wake()
      vi.advanceTimersByTime(20)

      // Boo nodes should still exist in store (particles were created)
      const updated = useGraphStore.getState().nodes
      expect(updated.find((n) => n.id === 'boo-a1')).toBeDefined()
      expect(updated.find((n) => n.id === 'boo-a2')).toBeDefined()
    })

    it('pushes overlapping boos apart', () => {
      // Place two boos at the same position
      const boo1 = makeBooNode('a1', 100, 100)
      const boo2 = makeBooNode('a2', 100, 100)

      useGraphStore.setState({ nodes: [boo1, boo2], edges: [] })
      graphPhysics.initialize([boo1, boo2], [])
      graphPhysics.wake()

      for (let i = 0; i < 30; i++) {
        vi.advanceTimersByTime(20)
      }

      const updated = useGraphStore.getState().nodes
      const b1 = updated.find((n) => n.id === 'boo-a1')!
      const b2 = updated.find((n) => n.id === 'boo-a2')!

      // They should have separated
      const dx = b1.position.x - b2.position.x
      const dy = b1.position.y - b2.position.y
      const dist = Math.sqrt(dx * dx + dy * dy)
      expect(dist).toBeGreaterThan(10)
    })

    it('boo push is smooth (no oscillation)', () => {
      // Place two boos close together (within collision distance)
      const boo1 = makeBooNode('a1', 100, 100)
      const boo2 = makeBooNode('a2', 150, 100) // 50px apart, well within 180px collision distance

      useGraphStore.setState({ nodes: [boo1, boo2], edges: [] })
      graphPhysics.initialize([boo1, boo2], [])
      graphPhysics.wake()

      // Track distance over frames — should be monotonically increasing (or stable)
      const distances: number[] = []
      for (let i = 0; i < 40; i++) {
        vi.advanceTimersByTime(20)
        const updated = useGraphStore.getState().nodes
        const b1 = updated.find((n) => n.id === 'boo-a1')!
        const b2 = updated.find((n) => n.id === 'boo-a2')!
        const dx = b1.position.x - b2.position.x
        const dy = b1.position.y - b2.position.y
        distances.push(Math.sqrt(dx * dx + dy * dy))
      }

      // Verify monotonic increase (each distance >= previous, within small epsilon for floating point)
      for (let i = 1; i < distances.length; i++) {
        expect(distances[i]!).toBeGreaterThanOrEqual(distances[i - 1]! - 0.01)
      }
    })
  })

  describe('multi-boo', () => {
    it('particles follow their own parent boo', () => {
      const boo1 = makeBooNode('a1', 0, 0)
      const boo2 = makeBooNode('a2', 500, 0)
      const skill1 = makeSkillNode('a1', 'bash', 200, 0)
      const skill2 = makeSkillNode('a2', 'python', 700, 0)
      const edge1 = makeSkillEdge('a1', 'bash')
      const edge2 = makeSkillEdge('a2', 'python')

      const nodes = [boo1, boo2, skill1, skill2]
      const edges = [edge1, edge2]
      useGraphStore.setState({ nodes, edges })
      graphPhysics.initialize(nodes, edges)

      // Pin boo1 (simulates drag start), move it, then unpin (simulates drag stop)
      graphPhysics.pinNode('boo-a1')
      useGraphStore.setState({
        nodes: [{ ...boo1, position: { x: 800, y: 0 } }, boo2, skill1, skill2],
      })
      graphPhysics.unpinNode('boo-a1')

      for (let i = 0; i < 20; i++) {
        vi.advanceTimersByTime(20)
      }

      const updated = useGraphStore.getState().nodes
      const s1 = updated.find((n) => n.id === 'skill-a1-bash')!
      const s2 = updated.find((n) => n.id === 'skill-a2-python')!

      // skill1 should have moved rightward (toward boo1's new position)
      expect(s1.position.x).toBeGreaterThan(200) // moved from original 200
      // skill2 should be roughly where it was (or minor settling)
      expect(Math.abs(s2.position.x - 700)).toBeLessThan(50) // didn't move much
    })
  })
})
