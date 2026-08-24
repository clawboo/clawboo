// Turning "I would need Linear for that" into a button.
//
// THE AWARENESS BLOCK ALREADY MAKES AN AGENT SAY IT. What it cannot do is make
// the sentence actionable: the reader is told a connector would help and then
// left to go find it, which is the same dead end as a refusal that names the
// remedy and makes you retype it.
//
// IN THIS PACKAGE, not beside either consumer, because both need it: the server
// strips the marker before posting, and the browser reads the routing token to
// decide whether to render a card. Two copies of a wire format in two trees is
// how a routing token silently stops routing, and the repo's own boundary rule
// forbids the browser importing the server's copy for good reasons.
//
// A MARKER, NOT A HEURISTIC, and the difference matters. The obvious approach is
// to scan the reply for catalog names, and it is wrong: "check the Notion page"
// contains "Notion" and means nothing about connectors. Any scan sensitive
// enough to catch a real ask also fires on prose that merely mentions a product,
// and a false connect prompt in a conversation is worse than no prompt at all.
// An explicit marker the agent chooses to emit has no false positives, because
// emitting it IS the ask.
//
// The marker never reaches the reader: it is stripped from the body before the
// message is posted, and what the reader sees is a card.

import { connectorBySlug } from './catalog'

/**
 * `[[connect:slug]]`, anywhere in the reply.
 *
 * Bounded to the slug alphabet so a stray double bracket in prose or code cannot
 * be read as one, and case-insensitive because a model that has been told the
 * form will sometimes capitalise it.
 */
const MARKER = /\[\[connect:([a-z0-9][a-z0-9-]{0,47})\]\]/gi

export interface ConnectorAsk {
  /** The reply with every marker removed, ready to post. */
  body: string
  /** Catalog slugs the agent asked for, deduped, in the order it named them. */
  slugs: string[]
}

/**
 * Split an agent's reply into what the reader sees and what it asked for.
 *
 * UNKNOWN SLUGS ARE DROPPED, not passed through. A model will occasionally
 * invent a plausible name, and a card offering to connect something that is not
 * in the catalog is an affordance that cannot work, which is the exact class of
 * lie the rest of this feature exists to prevent.
 */
export function extractConnectorAsk(text: string): ConnectorAsk {
  const slugs: string[] = []
  const seen = new Set<string>()
  const body = text.replace(MARKER, (_match, raw: string) => {
    const slug = raw.toLowerCase()
    if (connectorBySlug(slug) && !seen.has(slug)) {
      seen.add(slug)
      slugs.push(slug)
    }
    return ''
  })
  // Collapse the hole the marker left. A marker on its own line leaves a blank
  // line; one mid-sentence leaves a double space.
  return {
    body: body
      .replace(/[ \t]{2,}/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim(),
    slugs,
  }
}

/** The prefix that tells the chat panel to render a card rather than a sentence. */
export const CONNECTOR_ASK_PREFIX = 'clawboo:connect-ask '

/** "A", "A and B", "A, B, and C". */
function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? ''
  if (names.length === 2) return `${names[0]} and ${names[1]}`
  return `${names.slice(0, -1).join(', ')}, and ${names[names.length - 1]}`
}

/**
 * The system line that carries the ask to the panel.
 *
 * A meta transcript entry rather than a new table, because the transcript is
 * already the delivery plane and a notice that outlives a refresh is exactly
 * what a durable message is. The prefix is a routing token the panel strips; a
 * client that does not know it still shows a readable sentence, which is the
 * failure mode to want.
 */
export function connectorAskBody(slugs: readonly string[]): string {
  const names = slugs.map((s) => connectorBySlug(s)?.displayName ?? s)
  const subject = joinNames(names)
  // Singular for one, because "Linear would let this agent do that" and "Linear,
  // Notion, and Figma would" are the same sentence with a different verb only if
  // you write it once and read it never.
  const verb = names.length === 1 ? 'would' : 'would each'
  return `${CONNECTOR_ASK_PREFIX}${slugs.join(',')} ${subject} ${verb} let this agent do that. Open the Connectors tab to turn it on.`
}

/**
 * Parse a system line back into its slugs AND the sentence that came with it.
 *
 * BOTH, because the card used to re-derive its own prose from the slugs, which
 * meant the sentence existed twice in two trees and immediately diverged: the
 * stored one said "Linear, Notion, and Figma" and the rendered one said
 * "Linear and Notion and Figma". The line already carries prose written once.
 */
export function readConnectorAsk(body: string): { slugs: string[]; prose: string } | null {
  if (!body.startsWith(CONNECTOR_ASK_PREFIX)) return null
  const rest = body.slice(CONNECTOR_ASK_PREFIX.length)
  const [head, ...tail] = rest.split(' ')
  const slugs = (head ?? '').split(',').filter((s) => s && connectorBySlug(s))
  if (slugs.length === 0) return null
  return { slugs, prose: tail.join(' ').trim() }
}
