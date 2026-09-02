// Build the bounded view a model sees in place of an oversized tool result.
//
// Pure and database-free on purpose: the caller stores the bytes and passes in
// the handle, so what a model reads can be asserted without a database, and the
// store can be swapped without touching the wording the model depends on.
//
// THE NOTICE IS THE FEATURE. A cut that only says "truncated" leaves the model to
// invent a recovery, and the documented failure is that it invents none and
// answers from the prefix as though it were whole. So the notice states three
// things every time: that this is a part, how big the whole is, and the LITERAL
// next call that returns the rest. That last part is what makes a truncation a
// cursor. It is lifted from the one shipped agent that does it well, and it is
// the difference between a dead end and a paging loop the model can drive.

/** How the middle is dropped, and what the model is told to do about it. */
export interface CeilingView {
  /** The text to return in place of the full result. */
  text: string
  /** False when the result fitted and nothing was changed. */
  applied: boolean
  originalBytes: number
  shownBytes: number
}

/** UTF-8 byte length. */
function byteLen(text: string): number {
  return new TextEncoder().encode(text).length
}

/**
 * Cut to a byte budget without splitting a UTF-8 character.
 *
 * Decoding a slice that begins or ends mid-sequence yields U+FFFD, which lands in
 * the model's context as corruption it will happily report as data. A UTF-8
 * continuation byte is 10xxxxxx, so both ends are walked to the nearest boundary
 * before decoding rather than after.
 */
function sliceBytes(text: string, start: number, length: number): string {
  const buf = new TextEncoder().encode(text)
  const isContinuation = (i: number): boolean => (buf[i]! & 0b1100_0000) === 0b1000_0000
  let from = Math.max(0, Math.min(start, buf.length))
  // Forward off a continuation byte: the character it belongs to began earlier
  // and is not ours to emit.
  while (from < buf.length && isContinuation(from)) from++
  let to = Math.min(buf.length, from + length)
  // Back off a continuation byte: the character it belongs to is not complete.
  while (to > from && to < buf.length && isContinuation(to)) to--
  return new TextDecoder().decode(buf.subarray(from, to))
}

export interface CeilingOptions {
  /** Total bytes the view may occupy, notice included. */
  budgetBytes: number
  /** The handle the full result was stored under, or null when storing failed. */
  handle: string | null
  toolName: string
}

/**
 * Bound one tool result.
 *
 * HEAD AND TAIL, NOT HEAD ALONE. A JSON payload carries its shape at both ends,
 * and a list's last entries are as informative as its first. Keeping both and
 * naming the gap costs one extra line and leaves the model able to see what kind
 * of thing it is holding.
 *
 * THE NOTICE IS BUDGETED FIRST. Reserving room for it before the content is cut
 * is what stops the handle itself being truncated away, which would produce a
 * result that says bytes are retrievable and omits the means to retrieve them.
 */
export function buildCeilingView(text: string, opts: CeilingOptions): CeilingView {
  const originalBytes = byteLen(text)
  if (originalBytes <= opts.budgetBytes) {
    return { text, applied: false, originalBytes, shownBytes: originalBytes }
  }

  const notice =
    opts.handle === null
      ? // NO HANDLE MEANS NO RECOVERY, and saying so is the point. A notice that
        // promised retrieval it could not deliver would send the model into a
        // paging loop against a handle that does not exist.
        `[clawboo: this result was ${originalBytes} bytes, too large for the context, and it could not be stored, so the middle is gone and cannot be recovered. Re-run "${opts.toolName}" with narrower arguments: a smaller page size, a filter, or fewer fields.]`
      : `[clawboo: large result from "${opts.toolName}". ${originalBytes} bytes total, stored whole under handle ${opts.handle}. You are reading the beginning and the end only. Read any part with read_tool_result {"handle":"${opts.handle}","offset":0,"limit":${opts.budgetBytes}}, or find a section with {"handle":"${opts.handle}","search":"..."}. Answer only from what you have actually read, and tell the user if you have not read all of it.]`

  const gapLine = (omitted: number, from: number, to: number): string =>
    `\n\n... ${omitted} bytes omitted (byte offsets ${from} to ${to}) ...\n\n`

  // Reserve the notice and a generous gap line BEFORE cutting content, so the
  // view can never exceed the budget once they are added back.
  const reserve =
    byteLen(notice) + byteLen(gapLine(originalBytes, originalBytes, originalBytes)) + 4
  const contentBudget = Math.max(0, opts.budgetBytes - reserve)
  if (contentBudget === 0) {
    // The budget cannot hold content, the gap line and the full notice together.
    // Drop to a notice that carries only what cannot be reconstructed: the size
    // and the handle. A view with no way back is worth less than no view, so the
    // handle is the last thing to go.
    const terse =
      opts.handle === null
        ? `[clawboo: result too large (${originalBytes} bytes) and not stored. Re-run "${opts.toolName}" with narrower arguments.]`
        : `[clawboo: result too large (${originalBytes} bytes). Read it with read_tool_result {"handle":"${opts.handle}","offset":0,"limit":${opts.budgetBytes}}.]`
    const chosen = byteLen(terse) <= opts.budgetBytes ? terse : notice
    return { text: chosen, applied: true, originalBytes, shownBytes: byteLen(chosen) }
  }

  const headBytes = Math.ceil(contentBudget / 2)
  const tailBytes = contentBudget - headBytes
  const head = sliceBytes(text, 0, headBytes)
  const tail = tailBytes > 0 ? sliceBytes(text, originalBytes - tailBytes, tailBytes) : ''
  const from = byteLen(head)
  const to = originalBytes - byteLen(tail)
  const body = `${head}${gapLine(to - from, from, to)}${tail}`
  const out = `${notice}\n\n${body}`
  return { text: out, applied: true, originalBytes, shownBytes: byteLen(out) }
}
