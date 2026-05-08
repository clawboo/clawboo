// Spanning-tree computation for the Ghost Graph's "org chart" presentation.
//
// Background: AGENTS.md routing rules can produce a dense graph — every
// teammate Boo can have multiple outgoing edges to other teammates. Drawing
// every edge yields a tangle that obscures the leader → teammate flow.
//
// The Paperclip / classical-org-chart pattern is: show only ONE primary
// reporting line per node (the BFS spanning tree from the leader), and
// treat everything else as secondary collaboration metadata.
//
// This module is the pure data-layer step. It returns:
//   - the set of edge IDs that form the spanning tree (primary edges)
//   - a map from each reachable node to its primary parent
//
// `useGraphData.ts` calls this and tags each edge with `isPrimary`. The
// rendering layer then visually distinguishes the two classes (primary
// always-visible, secondary hover-revealed). ELK only sees primary edges,
// which is what gives the layered DOWN layout its clean rank structure.
//
// Caveats:
//   - If the root has no outgoing edges, the result is a single-node tree
//     (just root). Every other node is an "orphan" — not in the spanning
//     tree, no primary parent. Orphans still get placed by ELK (they're
//     nodes), just without a primary incoming edge.
//   - If the root itself doesn't exist in the edge set's nodes, the
//     result is an empty spanning tree. Caller should handle this (e.g.
//     by falling back to "show all edges").

export interface SpanningEdge {
  id: string
  source: string
  target: string
}

export interface SpanningTreeResult {
  /** Edge IDs that participate in the BFS spanning tree from `rootNodeId`. */
  primaryEdgeIds: Set<string>
  /** Map from a reachable node ID → the node ID of its primary parent. */
  parentMap: Map<string, string>
  /** Set of all node IDs reached by the BFS (including the root). */
  reachableNodeIds: Set<string>
}

/**
 * **Undirected** BFS spanning tree from `rootNodeId` over `edges`. Each
 * reachable node gets exactly one primary edge (the one that first
 * discovered it via BFS), regardless of the edge's actual direction in
 * the source data.
 *
 * Why undirected? The team `leaderAgentId` is what the user designated
 * as the org-chart root. But AGENTS.md routing rules can flow either
 * way — sometimes the leader has outgoing routes to teammates, sometimes
 * teammates have outgoing routes to the leader (e.g. "delegate to
 * @Product Sprint Boo for product questions"). A directed BFS from a
 * leader that has only INCOMING edges would return an empty spanning
 * tree, leaving ELK with nothing to lay out and producing the random
 * placement the user reported.
 *
 * Undirected BFS treats the dependency graph as a graph-of-relationships
 * rather than a graph-of-delegations. The visual hierarchy is determined
 * by hop-distance from the leader; the actual edge direction is preserved
 * separately for rendering (so arrowheads still point the way the data
 * says they do).
 *
 * Pure function. No store reads, no side effects.
 */
export function computeSpanningTree(edges: SpanningEdge[], rootNodeId: string): SpanningTreeResult {
  const primaryEdgeIds = new Set<string>()
  const parentMap = new Map<string, string>()
  const reachableNodeIds = new Set<string>([rootNodeId])

  // Build an undirected adjacency map: each node → list of (edge, neighbor).
  // For each edge A→B, both A and B get an entry. BFS treats these as
  // undirected traversals.
  const adjacency = new Map<string, Array<{ edge: SpanningEdge; neighbor: string }>>()
  const addAdjacency = (node: string, edge: SpanningEdge, neighbor: string) => {
    const list = adjacency.get(node) ?? []
    list.push({ edge, neighbor })
    adjacency.set(node, list)
  }
  for (const e of edges) {
    addAdjacency(e.source, e, e.target)
    addAdjacency(e.target, e, e.source)
  }

  const queue: string[] = [rootNodeId]
  while (queue.length > 0) {
    const current = queue.shift()!
    const neighbors = adjacency.get(current)
    if (!neighbors) continue
    for (const { edge, neighbor } of neighbors) {
      if (reachableNodeIds.has(neighbor)) continue
      reachableNodeIds.add(neighbor)
      primaryEdgeIds.add(edge.id)
      parentMap.set(neighbor, current)
      queue.push(neighbor)
    }
  }

  return { primaryEdgeIds, parentMap, reachableNodeIds }
}
