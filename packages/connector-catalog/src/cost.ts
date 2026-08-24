// How far this connector is from working, as one word.
//
// THE QUESTION A BROWSING USER IS ACTUALLY ASKING is "how much work is this",
// and every surface should answer it the same way. This is the second predicate
// in this package, and it stands next to `connectRefusal` rather than inside it
// on purpose: that one answers "may the server accept a Connect", which is a
// permission, while this one answers "what will it cost me", which is a price.
// A tile needs both, and collapsing them produced the chip this replaces.
//
// WHAT THIS IS NOT. The old card chip read `3/3 risk`, a number with no unit
// that looks like a trustworthiness score and is not one: it counts trifecta
// legs, which are a property of what the connector CAN reach, not of whether it
// is safe or how hard it is to set up. Risk belongs on the detail surface where
// there is room to say what the three legs actually are. The card gets the price.
//
// Pure and dependency-free, computable from the definition plus two booleans, so
// the browser calls it once per card with no round-trip.

import type { ConnectorDefinition } from './types'
import { isReachable, needsArgumentOnly, needsCredentialOnly, needsSignInOnly } from './connectable'

/**
 * The states, ordered by distance from working.
 *
 * `ready` is the one worth naming. Five catalog entries need nothing at all, and
 * they used to render "Not connected" beside a Connect button, which reads as a
 * chore for something that is one gesture away. Saying so is the cheapest
 * honesty in the whole surface.
 */
export type ConnectorCost =
  'on' | 'ready' | 'one-click' | 'needs-key' | 'needs-folder' | 'not-reviewed' | 'blocked'

export interface CostInput {
  /** Live right now, from the server's connected list. */
  connected?: boolean
  /**
   * Whether whatever this connector asks for is already stored.
   *
   * Undefined means "not known yet", which is deliberately NOT the same as
   * false: a caller that has not fetched configuration must show the cost CLASS
   * rather than assert the connector is unconfigured. Asserting it would put
   * "Needs a key" on an entry whose key the operator entered last week.
   */
  configured?: boolean
}

/** What it will cost to get this connector working, right now. */
export function connectorCost(def: ConnectorDefinition, input: CostInput = {}): ConnectorCost {
  if (input.connected) return 'on'
  // Community entries are the only ones clawboo has not read. That is a
  // statement about review, not about setup, so it outranks the cost classes.
  if (def.provenance === 'community') return 'not-reviewed'
  // NOTHING THE OPERATOR CAN SUPPLY WOULD MAKE THIS CONNECT. Checked before any
  // cost class, because a price implies the thing is purchasable. GitHub is the
  // live case: it needs a pre-registered OAuth app, so it falls through every
  // solvable predicate below and would otherwise be priced `ready`, which is a
  // Turn on button the server refuses. This is the same affordance-shaped lie
  // `connectRefusal` exists to prevent, and the price tag has to respect it too.
  if (!isReachable(def)) return 'blocked'
  // Already satisfied, so the remaining cost is the same as an entry that never
  // asked for anything.
  if (input.configured) return 'ready'
  if (needsSignInOnly(def)) return 'one-click'
  if (needsArgumentOnly(def)) return 'needs-folder'
  if (needsCredentialOnly(def)) return 'needs-key'
  // Nothing left to ask for. Either it never needed anything, or it needs
  // something this predicate cannot describe, in which case `connectRefusal` is
  // the surface that says so and the card should not invent a price.
  return 'ready'
}

export interface CostCopy {
  /** The pill. Names the price, never a status code. */
  label: string
  /** The button next to it. An imperative the user can act on. */
  action: string
  /** Whether the action is the primary one on the card. */
  primary: boolean
}

/**
 * The words, in one place.
 *
 * Two rules held throughout: the pill is a NOUN PHRASE about cost, and the
 * button is a VERB the user can do here. "Not connected" broke both, because it
 * is a status, and it left the reader to work out what to do about it.
 */
export const COST_COPY: Readonly<Record<ConnectorCost, CostCopy>> = Object.freeze({
  on: { label: 'On', action: 'Turn off', primary: false },
  ready: { label: 'Ready', action: 'Turn on', primary: true },
  'one-click': { label: 'One click', action: 'Connect', primary: true },
  'needs-key': { label: 'Needs a key', action: 'Add key', primary: false },
  'needs-folder': { label: 'Needs a folder', action: 'Choose folder', primary: false },
  'not-reviewed': { label: 'Not reviewed', action: 'Add it', primary: false },
  // No verb, because there is no action that would work. "Why not" is the only
  // honest offer, and it opens the pane that explains and gives the config to
  // paste somewhere that can run it.
  blocked: { label: 'Not here', action: 'Why not', primary: false },
})

/**
 * Sort position. Lower is closer to working.
 *
 * The default order of the shelf is distance from working rather than the
 * alphabet, because that is what makes "the option to have options" true on
 * screen: the top is what you can have in one gesture, and the length is the
 * part that says the product is not small.
 */
const RANK: Readonly<Record<ConnectorCost, number>> = Object.freeze({
  on: 0,
  ready: 1,
  'one-click': 2,
  'needs-key': 3,
  'needs-folder': 3,
  'not-reviewed': 4,
  // Last. The shelf is ordered by distance from working, and this is the only
  // entry at infinity.
  blocked: 5,
})

export function costRank(cost: ConnectorCost): number {
  return RANK[cost]
}

/**
 * Order a list for display: by distance from working, then alphabetically.
 *
 * Stable within a rank so the shelf does not reshuffle under the reader when a
 * connector's state changes somewhere else in the list.
 */
export function byCost(
  defs: readonly ConnectorDefinition[],
  costOf: (def: ConnectorDefinition) => ConnectorCost,
): ConnectorDefinition[] {
  return [...defs].sort((a, b) => {
    const d = costRank(costOf(a)) - costRank(costOf(b))
    if (d !== 0) return d
    // Curated before community inside every band: provenance is a second
    // ordering axis, not a third band, so a reviewed entry that needs a key
    // still outranks an unreviewed one that needs nothing.
    if (a.provenance !== b.provenance) return a.provenance === 'curated' ? -1 : 1
    return a.displayName.localeCompare(b.displayName)
  })
}
