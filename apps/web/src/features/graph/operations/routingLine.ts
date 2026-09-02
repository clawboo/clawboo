// The one sentence that IS a routing edge.
//
// A route between two Boos is not a row in a table. It is a markdown bullet in
// the source agent's AGENTS.md, and the graph reconstructs the edge by matching
// the target's DISPLAY NAME inside it. That makes the exact wording load
// bearing in two directions at once: `appendRouting` writes it and
// `removeRouting` matches it, and if the two ever drift the canvas draws an
// edge nothing can delete, or deletes one that is still in the file.
//
// Extracted so there is one spelling rather than one per call site.

/** The bullet appended to AGENTS.md for a route to `targetName`. */
export function routingLineFor(targetName: string): string {
  return `- Route to @${targetName} for delegated tasks.`
}

/**
 * Is a route to `targetName` already declared in this file?
 *
 * Matches the MENTION rather than the whole line, and tolerates quoting, so a
 * hand-written `@"Doc Writer"` counts as the same route the canvas would draw.
 * Deliberately looser than the writer: the cost of missing an existing route is
 * a duplicate bullet, and the cost of a false negative on removal is an edge
 * that will not go away.
 */
export function hasRoutingTo(agentsMd: string, targetName: string): boolean {
  const escaped = targetName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`@["']?${escaped}["']?`, 'i').test(agentsMd)
}

/** The file contents with a route to `targetName` appended, or `null` if it is already there. */
export function withRoutingAppended(agentsMd: string, targetName: string): string | null {
  if (hasRoutingTo(agentsMd, targetName)) return null
  return `${agentsMd.trimEnd()}\n${routingLineFor(targetName)}\n`
}
