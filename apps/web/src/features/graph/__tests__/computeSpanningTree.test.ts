import { describe, it, expect } from 'vitest'
import { computeSpanningTree, type SpanningEdge } from '../computeSpanningTree'

const edge = (id: string, source: string, target: string): SpanningEdge => ({
  id,
  source,
  target,
})

describe('computeSpanningTree', () => {
  it('returns just the root for an empty edge set', () => {
    const result = computeSpanningTree([], 'leader')
    expect(result.primaryEdgeIds.size).toBe(0)
    expect(result.parentMap.size).toBe(0)
    expect([...result.reachableNodeIds]).toEqual(['leader'])
  })

  it('builds a hub-spoke spanning tree (leader → 3 direct reports)', () => {
    const edges = [edge('e1', 'leader', 'a'), edge('e2', 'leader', 'b'), edge('e3', 'leader', 'c')]
    const result = computeSpanningTree(edges, 'leader')
    expect([...result.primaryEdgeIds].sort()).toEqual(['e1', 'e2', 'e3'])
    expect(result.parentMap.get('a')).toBe('leader')
    expect(result.parentMap.get('b')).toBe('leader')
    expect(result.parentMap.get('c')).toBe('leader')
    expect(result.reachableNodeIds.size).toBe(4)
  })

  it('builds a chain spanning tree (leader → a → b → c)', () => {
    const edges = [edge('e1', 'leader', 'a'), edge('e2', 'a', 'b'), edge('e3', 'b', 'c')]
    const result = computeSpanningTree(edges, 'leader')
    expect([...result.primaryEdgeIds].sort()).toEqual(['e1', 'e2', 'e3'])
    expect(result.parentMap.get('a')).toBe('leader')
    expect(result.parentMap.get('b')).toBe('a')
    expect(result.parentMap.get('c')).toBe('b')
  })

  it('keeps the FIRST discovering edge for nodes reached via multiple paths', () => {
    // Both `leader` and `a` route to `b`. Undirected BFS visits leader's
    // neighbours in adjacency-insertion order — leader's edges are added
    // first (e1, e2), so e1 (leader→b) discovers b before e3 (a→b) gets
    // a chance.
    const edges = [edge('e1', 'leader', 'b'), edge('e2', 'leader', 'a'), edge('e3', 'a', 'b')]
    const result = computeSpanningTree(edges, 'leader')
    expect(result.primaryEdgeIds.has('e1')).toBe(true)
    expect(result.primaryEdgeIds.has('e3')).toBe(false) // secondary — b already reached
    expect(result.parentMap.get('b')).toBe('leader')
  })

  it('handles cycles without infinite-looping', () => {
    // a → b → c → a: undirected BFS visits each node once, regardless of
    // edge direction. From `leader` we reach `a` via e1; from `a` we
    // reach `b` (e2) AND `c` (e4 — undirected, so c→a is also a→c).
    // Result: e3 (b→c) doesn't make the spanning tree because c was
    // already discovered via a's e4 neighbour.
    const edges = [
      edge('e1', 'leader', 'a'),
      edge('e2', 'a', 'b'),
      edge('e3', 'b', 'c'), // not primary — c reached earlier via a
      edge('e4', 'c', 'a'),
    ]
    const result = computeSpanningTree(edges, 'leader')
    expect(result.primaryEdgeIds.has('e1')).toBe(true)
    expect(result.primaryEdgeIds.has('e2')).toBe(true)
    expect(result.primaryEdgeIds.has('e4')).toBe(true)
    expect(result.primaryEdgeIds.has('e3')).toBe(false)
    expect(result.reachableNodeIds.size).toBe(4)
  })

  it('marks unreachable nodes as orphans (not in reachableNodeIds, no parent)', () => {
    // `orphan` is not connected to leader's tree.
    const edges = [
      edge('e1', 'leader', 'a'),
      edge('e2', 'orphan-src', 'orphan'), // disconnected component
    ]
    const result = computeSpanningTree(edges, 'leader')
    expect(result.reachableNodeIds.has('orphan')).toBe(false)
    expect(result.reachableNodeIds.has('orphan-src')).toBe(false)
    expect(result.parentMap.has('orphan')).toBe(false)
    expect(result.primaryEdgeIds.has('e2')).toBe(false)
  })

  it('produces an empty spanning tree if the root has no edges at all (in or out)', () => {
    const edges = [edge('e1', 'a', 'b'), edge('e2', 'b', 'c')]
    const result = computeSpanningTree(edges, 'leader')
    expect(result.primaryEdgeIds.size).toBe(0)
    expect(result.parentMap.size).toBe(0)
    expect([...result.reachableNodeIds]).toEqual(['leader'])
  })

  // Undirected behavior — production bug: a leader with INCOMING routing
  // ("teammates delegate to @Leader") would yield an empty spanning tree
  // with the previous outgoing-only BFS, leaving ELK with no constraints
  // and producing arbitrary placement. Undirected BFS makes the leader
  // discoverable via either direction.
  it('finds the leader via INCOMING edges when leader has no outgoing routes', () => {
    const edges = [
      edge('e1', 'a', 'leader'), // a delegates to leader
      edge('e2', 'b', 'leader'), // b delegates to leader
      edge('e3', 'c', 'a'), // c delegates to a — discovered via a
    ]
    const result = computeSpanningTree(edges, 'leader')
    expect(result.reachableNodeIds.size).toBe(4) // leader + a + b + c
    expect(result.primaryEdgeIds.size).toBe(3)
    expect(result.parentMap.get('a')).toBe('leader')
    expect(result.parentMap.get('b')).toBe('leader')
    expect(result.parentMap.get('c')).toBe('a')
  })

  it('treats a chain B→A→leader as leader → A → B (undirected)', () => {
    // The actual edge directions point UP toward the leader. Undirected
    // BFS still places the leader at the root, then discovers A as a
    // direct neighbour, then B via A.
    const edges = [
      edge('e1', 'a', 'leader'), // a delegates to leader
      edge('e2', 'b', 'a'), // b delegates to a
    ]
    const result = computeSpanningTree(edges, 'leader')
    expect(result.parentMap.get('a')).toBe('leader')
    expect(result.parentMap.get('b')).toBe('a')
  })

  it('every reachable non-root node has exactly one parent', () => {
    // Stress: a graph with many cross-edges. Every reachable node should
    // have exactly one parent, regardless of how many incoming edges it
    // has in the source data.
    const edges = [
      edge('e1', 'leader', 'a'),
      edge('e2', 'leader', 'b'),
      edge('e3', 'a', 'c'),
      edge('e4', 'b', 'c'), // cross-edge to c
      edge('e5', 'a', 'd'),
      edge('e6', 'leader', 'd'), // cross-edge to d
      edge('e7', 'd', 'a'), // back-edge
    ]
    const result = computeSpanningTree(edges, 'leader')
    for (const node of result.reachableNodeIds) {
      if (node === 'leader') continue
      expect(result.parentMap.has(node)).toBe(true)
    }
    // Each reachable node has exactly one primary incoming edge
    const primaryEdgeTargets = edges
      .filter((e) => result.primaryEdgeIds.has(e.id))
      .map((e) => e.target)
    const uniqueTargets = new Set(primaryEdgeTargets)
    expect(primaryEdgeTargets.length).toBe(uniqueTargets.size)
  })

  it('uses an adjacency map for O(1) lookup (smoke test on a 100-node graph)', () => {
    // Sanity check: doesn't blow up on a moderate graph.
    const edges: SpanningEdge[] = []
    for (let i = 0; i < 100; i++) {
      edges.push(edge(`e${i}`, i === 0 ? 'leader' : `n${i - 1}`, `n${i}`))
    }
    const result = computeSpanningTree(edges, 'leader')
    expect(result.reachableNodeIds.size).toBe(101) // leader + n0..n99
    expect(result.primaryEdgeIds.size).toBe(100)
  })
})
