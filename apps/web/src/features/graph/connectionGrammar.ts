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

/** Why this pair cannot connect, or `null` when it can. */
export function connectionRefusal(
  sourceType: string | undefined,
  targetType: string | undefined,
  same: boolean,
): string | null {
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
): boolean {
  return connectionRefusal(sourceType, targetType, same) === null
}
