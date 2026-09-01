// A tool call that failed while reporting HTTP success.
//
// WHY THIS EXISTS. clawboo marks a tool call failed when its executor throws.
// A remote MCP server that answers 200 with a failure DESCRIBED IN THE BODY
// therefore lands in the audit as a success, and on a real install ten
// consecutive failed Gmail fetches were all recorded `is_error = 0`.
//
// The cost is not cosmetic. The operator watched an agent ask for the same
// permission five times and give up with, in their words, "an error with no
// feedback": nothing in the activity log said anything had failed, because as
// far as clawboo knew nothing had. The actual message was sitting in the
// payload the whole time, and it named the fix.
//
// DELIBERATELY NARROW. Only an explicit self-report counts: a boolean that says
// `successful: false`, or a non-empty top-level `error`. Anything that does not
// parse as JSON, and any payload that merely CONTAINS the word error somewhere,
// is left alone. A false positive here turns a working tool into a broken one,
// which is worse than the silence it replaces.

/** The failure a brokered result reported about itself, or null. */
export function brokeredFailureMessage(text: string): string | null {
  const trimmed = text.trimStart()
  // Cheap gate: only a JSON document can self-report, and most results are not
  // one. This runs on every brokered call.
  if (!trimmed.startsWith('{')) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const body = parsed as Record<string, unknown>

  const declaredFailure = body['successful'] === false || body['success'] === false
  const error = body['error']
  const errorText = typeof error === 'string' && error.trim() ? error.trim() : null

  if (!declaredFailure && !errorText) return null

  // Prefer the SPECIFIC message over the summary. Composio reports
  // `error: "1 out of 1 tools failed"` at the top while the per-result entry
  // carries the sentence that names the remedy, and handing the model the
  // summary alone is what left it guessing at arguments for five attempts.
  const detail = firstResultError(body)
  return detail ?? errorText ?? 'the tool reported that it did not succeed'
}

/** The first per-result error inside a batch envelope, when there is one. */
function firstResultError(body: Record<string, unknown>): string | null {
  const data = body['data']
  const container = data && typeof data === 'object' ? (data as Record<string, unknown>) : body
  const results = container['results']
  if (!Array.isArray(results)) return null
  for (const entry of results) {
    if (!entry || typeof entry !== 'object') continue
    const err = (entry as Record<string, unknown>)['error']
    if (typeof err === 'string' && err.trim()) return err.trim()
  }
  return null
}
