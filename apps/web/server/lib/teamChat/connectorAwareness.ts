// Telling an agent what it could have, and forbidding it to work around not having it.
//
// THE FAILURE THIS EXISTS FOR is specific and it is what every comparable product
// gets wrong. An agent asked to read a Notion page, with no Notion connector,
// does not say "I cannot reach Notion". It opens a browser, navigates to
// notion.so, hits a login wall, and asks the human to sign in. The human is
// already signed in; what is missing is a connector, and nothing in the agent's
// context ever told it that such a thing exists or that the person reading can
// add one in two clicks.
//
// So this block does two jobs, and the second is the one that changes behaviour:
// it NAMES what is available, and it forbids the workarounds.
//
// GRADED BY COST, which is the part clawboo can do and the reference
// implementations cannot: their catalogues carry no price, so the best they can
// say is "you do not have X". clawboo knows whether X is one click or needs a key
// the human has to fetch, and an agent that knows the difference asks differently.

import {
  connectorCost,
  CURATED_CONNECTORS,
  type ConnectorDefinition,
} from '@clawboo/connector-catalog'

/**
 * How many to name PER COST TIER.
 *
 * A ceiling, not a target. This rides EVERY turn's context, so it is charged
 * against the KV cache on every request, and a list long enough to be a catalogue
 * would cost more than the behaviour it buys. The ones already connected are
 * listed in full because they are what the agent can actually use.
 */
const PER_TIER = 2

export interface ConnectorAwarenessInput {
  /** Slugs live right now. These are usable, and their tools are already listed. */
  connected: readonly string[]
  /** Whether this turn's reply reaches a human who could act on a suggestion. */
  isUserFacing: boolean
}

/**
 * The connectors clause, or null when there is nothing worth saying.
 *
 * Null on a turn the user will not read: telling a background worker to suggest a
 * connector produces a suggestion nobody sees, in a transcript nobody opens, and
 * spends context on every one of them.
 */
export function buildConnectorAwareness(input: ConnectorAwarenessInput): string | null {
  if (!input.isUserFacing) return null

  const live = new Set(input.connected)
  const candidates = CURATED_CONNECTORS.filter((d) => !live.has(d.slug))
    .map((d) => ({ def: d, cost: connectorCost(d) }))
    .filter((e) => e.cost === 'ready' || e.cost === 'one-click' || e.cost === 'needs-key')

  // A FEW FROM EACH TIER, not the cheapest N. Straight cheapest-first filled the
  // whole budget with zero-input developer tools and never mentioned Notion or
  // Figma at all, so an agent asked about a Notion page would still conclude no
  // such thing was possible. Naming one of each teaches the shape of the offer.
  const offered = (['ready', 'one-click', 'needs-key'] as const).flatMap((cost) =>
    candidates.filter((e) => e.cost === cost).slice(0, PER_TIER),
  )

  if (input.connected.length === 0 && offered.length === 0) return null

  const lines: string[] = []

  // NAMED FROM THE LIVE SET, not from the catalog. Filtering the catalog by the
  // live slugs silently dropped every custom connector, so an operator whose only
  // connection was one they added themselves got the sentence "Connected and
  // usable right now: ." with an empty list.
  const liveNames = input.connected.map(
    (slug) => CURATED_CONNECTORS.find((d) => d.slug === slug)?.displayName ?? slug,
  )
  if (liveNames.length > 0) {
    lines.push(
      `Connected and usable right now: ${liveNames.join(', ')}. Their tools are in your tool list, prefixed mcp__.`,
    )
  }

  if (offered.length > 0) {
    lines.push(
      `Not connected, but the user can add these: ${offered.map(describe).join('; ')}.`,
      'If one of them is what you need, say so plainly and stop. Name it and say what you would do with it.',
      // The marker is what turns that sentence into a button. It is stripped
      // before the reader sees the reply, and the user gets a card with Connect
      // on it instead of a name they have to go and look up.
      'Then add [[connect:slug]] on its own line, using the slug in brackets above, one line per connector. Use it ONLY when you actually need that connector for this request.',
    )
  }

  // THE PROHIBITIONS. Without these the block is a menu the model reads and
  // ignores, because working around a missing tool looks like helpfulness.
  lines.push(
    'Never work around a missing connector. Do not browse to the vendor’s website to read data a connector would give you.',
    'Never ask the user to sign in to anything on your behalf, and never ask them to paste data you could read yourself once connected.',
  )

  return `[Connectors]\n${lines.join('\n')}\n[End Connectors]`
}

/**
 * One connector, priced in words the agent can repeat to the user.
 *
 * The price is the whole point. "Linear is one click" and "Notion needs a key
 * from your Notion settings" produce different sentences from the agent, and the
 * second one sets an expectation the first does not.
 */
function describe(entry: { def: ConnectorDefinition; cost: string }): string {
  const { def, cost } = entry
  // The SLUG travels with the name, because the marker is keyed on it and an
  // agent cannot emit an identifier it was never shown.
  const id = `[${def.slug}]`
  if (cost === 'ready') return `${def.displayName} ${id} (one click, nothing to set up)`
  if (cost === 'one-click') return `${def.displayName} ${id} (one click, they sign in)`
  return `${def.displayName} ${id} (needs a key from ${def.auth.setupGuide?.console ?? def.displayName})`
}
