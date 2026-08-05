// Accessible names for graph nodes.
//
// React Flow makes every node a Tab stop (`nodesFocusable` defaults to true) and
// reads `node.ariaLabel` as its accessible name. Nothing in this app set one, so
// a screen reader announced a bare "group, node" for every Boo, capability and
// connector on the canvas.
//
// Pure derivations of node data, kept out of the components so they can be
// asserted in the node vitest project — no DOM, no ReactFlowProvider (which is
// why no graph component test exists today).

import type { GraphNode } from './types'

const STATUS_PHRASE: Record<string, string> = {
  idle: 'idle',
  running: 'running',
  error: 'error',
  sleeping: 'sleeping',
}

function availabilitySuffix(available?: boolean, enabled?: boolean): string {
  if (enabled === false) return ', disabled'
  if (available === false) return ', unavailable'
  return ''
}

/**
 * The accessible name for a graph node, or `undefined` for nodes that are never
 * focusable (the invisible Atlas team-root junctions).
 */
export function graphNodeAriaLabel(node: GraphNode): string | undefined {
  switch (node.type) {
    case 'boo': {
      const { name, status, teamName, isUniversalLeader } = node.data
      const affiliation = isUniversalLeader
        ? 'universal leader'
        : teamName
          ? `team ${teamName}`
          : 'no team'
      return `Agent ${name}, ${STATUS_PHRASE[status] ?? status}, ${affiliation}`
    }
    case 'skill': {
      const d = node.data
      // The two synthesized graph-layer orbitals aren't capabilities.
      if (d.isLeadership) return 'Leadership, reserved capability of Boo Zero'
      if (d.isModel) return `Model, ${d.name}`
      return `Capability ${d.name}${availabilitySuffix(d.available, d.enabled)}`
    }
    case 'resource': {
      const d = node.data
      return `Connector ${d.name}${availabilitySuffix(d.available, d.enabled)}`
    }
    case 'team-root':
      // A 1px invisible routing junction — never focusable, so it needs no name.
      return undefined
  }
}
