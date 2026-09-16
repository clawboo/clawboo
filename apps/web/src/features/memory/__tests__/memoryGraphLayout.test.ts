// Pure layout fallbacks — the deterministic floor under the async ELK path
// (ELK itself is covered by e2e, matching the repo's existing choice).

import { describe, expect, it } from 'vitest'

import {
  fallbackClusterLayout,
  phyllotaxisLayout,
  type MemLayoutEdge,
  type MemLayoutNode,
} from '../graph/memoryGraphLayout'

const node = (id: string, size = 40): MemLayoutNode => ({ id, width: size, height: size })

/** Deterministic shuffle (LCG) — same permutation every run. */
function shuffled<T>(arr: readonly T[], seed = 7): T[] {
  const out = [...arr]
  let s = seed
  for (let i = out.length - 1; i > 0; i--) {
    s = (s * 48271) % 2147483647
    const j = s % (i + 1)
    ;[out[i], out[j]] = [out[j]!, out[i]!]
  }
  return out
}

describe('phyllotaxisLayout', () => {
  it('is deterministic for identical input', () => {
    const nodes = Array.from({ length: 50 }, (_, i) => node(`n${i}`))
    const a = phyllotaxisLayout(nodes, { x: 100, y: 100 })
    const b = phyllotaxisLayout(nodes, { x: 100, y: 100 })
    expect([...a.entries()]).toEqual([...b.entries()])
  })

  it('keeps a min pairwise distance ≥ spacing·0.9 for 200 nodes (never a pile)', () => {
    const spacing = 60
    const nodes = Array.from({ length: 200 }, (_, i) => node(`n${i}`))
    const pos = [...phyllotaxisLayout(nodes, { x: 0, y: 0 }, spacing).values()]
    let min = Infinity
    for (let i = 0; i < pos.length; i++) {
      for (let j = i + 1; j < pos.length; j++) {
        const d = Math.hypot(pos[i]!.x - pos[j]!.x, pos[i]!.y - pos[j]!.y)
        if (d < min) min = d
      }
    }
    expect(min).toBeGreaterThanOrEqual(spacing * 0.9)
  })

  it('centers the spiral on the given center (node 0 at center minus half-size)', () => {
    const pos = phyllotaxisLayout([node('a', 40)], { x: 200, y: 300 })
    expect(pos.get('a')).toEqual({ x: 180, y: 280 })
  })
})

describe('fallbackClusterLayout', () => {
  const nodes = [
    // Component 1 (3 members), component 2 (2 members), two singletons.
    node('a'),
    node('b'),
    node('c'),
    node('d'),
    node('e'),
    node('f'),
    node('g'),
  ]
  const edges: MemLayoutEdge[] = [
    { id: 'e1', source: 'a', target: 'b' },
    { id: 'e2', source: 'b', target: 'c' },
    { id: 'e3', source: 'd', target: 'e' },
  ]

  function componentBBoxes(pos: Map<string, { x: number; y: number }>) {
    const groups: Record<string, string[]> = {
      c1: ['a', 'b', 'c'],
      c2: ['d', 'e'],
      c3: ['f'],
      c4: ['g'],
    }
    return Object.values(groups).map((ids) => {
      let minX = Infinity
      let minY = Infinity
      let maxX = -Infinity
      let maxY = -Infinity
      for (const id of ids) {
        const p = pos.get(id)!
        minX = Math.min(minX, p.x)
        minY = Math.min(minY, p.y)
        maxX = Math.max(maxX, p.x + 40)
        maxY = Math.max(maxY, p.y + 40)
      }
      return { minX, minY, maxX, maxY }
    })
  }

  it('places every node and keeps component bounding boxes disjoint', () => {
    const pos = fallbackClusterLayout(nodes, edges)
    expect(pos.size).toBe(nodes.length)
    const boxes = componentBBoxes(pos)
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i]!
        const b = boxes[j]!
        const overlap = a.minX < b.maxX && b.minX < a.maxX && a.minY < b.maxY && b.minY < a.maxY
        expect(overlap).toBe(false)
      }
    }
  })

  it('is input-order invariant (shuffled nodes + edges → identical positions)', () => {
    const base = fallbackClusterLayout(nodes, edges)
    const shuffledResult = fallbackClusterLayout(shuffled(nodes), shuffled(edges))
    expect(Object.fromEntries(shuffledResult)).toEqual(Object.fromEntries(base))
  })

  it('handles the fully-disconnected case (every node a singleton)', () => {
    const pos = fallbackClusterLayout(nodes, [])
    expect(pos.size).toBe(nodes.length)
    // No two singletons on the same spot.
    const seen = new Set([...pos.values()].map((p) => `${p.x}:${p.y}`))
    expect(seen.size).toBe(nodes.length)
  })

  it('returns an empty map for empty input', () => {
    expect(fallbackClusterLayout([], []).size).toBe(0)
  })
})
