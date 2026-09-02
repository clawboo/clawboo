// Which node pairs may be connected, and why not when they may not.
//
// ONE FUNCTION, TWO CANVASES. The Ghost Graph and the agent detail view's
// MiniGraph each had their own answer: the big canvas allowed skill→boo,
// resource→boo and boo→boo, while the MiniGraph allowed only skill→boo and
// returned a bare boolean. Two implementations of one rule drift by
// construction, and the failure is silent -- a gesture that works on one
// surface snaps back on the other with no explanation.
//
// A REASON, NOT A BOOLEAN. `isValidConnection` only needs true or false, but a
// drag that snaps back with no message is the least helpful thing a canvas can
// do. Returning the sentence lets the refusal be SAID.

/**
 * Which surface is asking.
 *
 * `single-agent` is the agent detail view's small graph: it draws ONE Boo and
 * that agent's own capabilities, so "give this agent something" is the only
 * meaningful direction. Routing needs a second Boo and there isn't one, and a
 * share needs a second grantee for the same reason.
 */
export type ConnectScope = 'canvas' | 'single-agent'

/** Why this pair cannot connect, or `null` when it can. */
export function connectionRefusal(
  sourceType: string | undefined,
  targetType: string | undefined,
  same: boolean,
  scope: ConnectScope = 'canvas',
): string | null {
  // SCOPED, NOT DUPLICATED. The detail view used to carry its own narrower copy
  // of this rule and returned a bare boolean, so the two surfaces drifted and
  // the drift was silent. Narrowing here keeps one implementation and one set
  // of reasons, and the reason is what a refused drag can actually say.
  if (scope === 'single-agent') {
    if (sourceType === 'boo') return 'There is only one agent here to route from.'
    if (sourceType === 'resource') return 'Share a connector from the full graph.'
  }
  if (sourceType === 'skill' && targetType === 'boo') return null
  if (sourceType === 'resource' && targetType === 'boo') return null
  if (sourceType === 'boo' && targetType === 'boo') {
    return same ? 'An agent cannot route to itself.' : null
  }
  if (targetType !== 'boo') return 'Drop this on an agent.'
  return 'That connection is not supported.'
}

/** The boolean React Flow wants, derived from the same rule. */
export function isConnectionAllowed(
  sourceType: string | undefined,
  targetType: string | undefined,
  same: boolean,
  scope: ConnectScope = 'canvas',
): boolean {
  return connectionRefusal(sourceType, targetType, same, scope) === null
}
