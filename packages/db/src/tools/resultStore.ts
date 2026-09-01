// Keep the whole tool result; hand the model a bounded view of it.
//
// WHY THIS EXISTS. A tool result is the one part of a prompt whose size nobody
// controls. The tool list is bounded by what an operator granted, the system
// prompt is authored, the conversation grows a turn at a time. A remote server
// answers with whatever it answers, and on a real install a single inbox fetch
// came back 16,822 bytes, which was 19% of that request's entire prompt.
//
// WHY NOT JUST TRUNCATE. Because truncation is a silent lie. The model has no way
// to know a result was cut, so it reads the surviving prefix as the complete
// answer and reports it as such. That failure mode is documented across the
// field, and it is worse than the overflow it prevents: an overflow is loud.
//
// WHY NOT SUMMARIZE. Because a summary of a tool result destroys exactly what the
// result exists to carry. Message ids, amounts, timestamps and row keys are the
// payload, and they are the first thing a summarizer drops. It also costs an
// inference to produce something strictly worse than the bytes it replaces. The
// field's own guidance ranks clearing above summarizing for re-fetchable output,
// and the one summarizer that ran on this install returned "conversation is
// empty" four times before the run died.
//
// SO: STORE, THEN TRIM. The full bytes go to `tool_result_blobs` under an
// unguessable handle, and only then is a view built. The view carries the handle
// and the literal next call that retrieves the rest, which is what turns a
// truncation into a cursor rather than a dead end. Nothing is lost, and the model
// is told plainly that it is holding a part.

import { randomBytes } from 'node:crypto'

import { eq, lt } from 'drizzle-orm'

import { toolResultBlobs } from '../schema'
import type { ClawbooDb } from '../db'

const eqHandle = (h: string) => eq(toolResultBlobs.handle, h)
const ltCreatedAt = (t: number) => lt(toolResultBlobs.createdAt, t)

/**
 * The most one stored result may occupy.
 *
 * A ceiling on the STORE, distinct from the ceiling on the view. Past this the
 * row records `storedBytes < totalBytes` so retrieval can say honestly that even
 * the kept copy is partial, rather than presenting a truncated store as whole.
 */
const STORE_MAX_BYTES = 8 * 1024 * 1024

/** Handle prefix, so a handle is recognisable in a transcript and in an audit row. */
const HANDLE_PREFIX = 'tr_'

export interface StoredToolResult {
  handle: string
  totalBytes: number
  storedBytes: number
}

/** UTF-8 byte length. */
function byteLen(text: string): number {
  return new TextEncoder().encode(text).length
}

/**
 * Cut a string to a byte budget without splitting a UTF-8 character.
 *
 * `slice` counts UTF-16 code units, so a naive cut at a byte offset can land
 * inside a multi-byte character. The paging path hits this constantly: page two
 * begins wherever page one ended, which is an arbitrary byte offset.
 */
function sliceBytes(text: string, start: number, length: number): string {
  const buf = new TextEncoder().encode(text)
  const isContinuation = (i: number): boolean => (buf[i]! & 0b1100_0000) === 0b1000_0000
  let from = Math.max(0, Math.min(start, buf.length))
  // A UTF-8 continuation byte is 10xxxxxx. Decoding a slice that starts or ends
  // mid-sequence yields U+FFFD, which reaches the model as corruption it will
  // report as data, so both ends move to a character boundary before decoding.
  while (from < buf.length && isContinuation(from)) from++
  let to = Math.min(buf.length, from + length)
  while (to > from && to < buf.length && isContinuation(to)) to--
  return new TextDecoder().decode(buf.subarray(from, to))
}

/** Store a tool result whole and return the handle that reads it back. */
export function putToolResult(
  db: ClawbooDb,
  input: { toolName: string; agentId?: string | null; tenantId?: string | null; text: string },
  now = Date.now(),
): StoredToolResult {
  const totalBytes = byteLen(input.text)
  const body =
    totalBytes > STORE_MAX_BYTES ? sliceBytes(input.text, 0, STORE_MAX_BYTES) : input.text
  const storedBytes = byteLen(body)
  // Unguessable rather than sequential: a handle is a read capability for a
  // third-party payload, and an OpenClaw session is unbound by construction, so
  // the only thing standing between one session and another session's result is
  // that the handle cannot be guessed.
  const handle = `${HANDLE_PREFIX}${randomBytes(8).toString('hex')}`

  db.insert(toolResultBlobs)
    .values({
      handle,
      toolName: input.toolName,
      agentId: input.agentId ?? null,
      tenantId: input.tenantId ?? null,
      body,
      totalBytes,
      storedBytes,
      createdAt: now,
    })
    .run()

  return { handle, totalBytes, storedBytes }
}

export interface ToolResultPage {
  /** The requested slice, or the matching lines when a search was given. */
  text: string
  totalBytes: number
  storedBytes: number
  /** Byte offset one past the end of what was returned, for the next page. */
  nextOffset: number
  /** True when bytes remain after `nextOffset`. */
  more: boolean
}

/** Read part of a stored result back. Returns null when the handle is unknown. */
export function readToolResult(
  db: ClawbooDb,
  handle: string,
  opts: { offset?: number; limit: number; search?: string } = { limit: 8192 },
): ToolResultPage | null {
  const row = db.select().from(toolResultBlobs).where(eqHandle(handle)).get()
  if (!row) return null

  if (opts.search) {
    // Matching lines WITH their byte offsets, so a hit becomes a seek target
    // rather than forcing the model to page the whole payload to reach it.
    const out: string[] = []
    const needle = opts.search.toLowerCase()
    let offset = 0
    for (const line of row.body.split('\n')) {
      if (line.toLowerCase().includes(needle)) out.push(`[byte ${offset}] ${line}`)
      offset += byteLen(line) + 1
      if (byteLen(out.join('\n')) >= opts.limit) break
    }
    const text = out.length > 0 ? out.join('\n') : `No line matches ${JSON.stringify(opts.search)}.`
    return {
      text,
      totalBytes: row.totalBytes,
      storedBytes: row.storedBytes,
      nextOffset: row.storedBytes,
      more: false,
    }
  }

  const start = Math.max(0, opts.offset ?? 0)
  const text = sliceBytes(row.body, start, opts.limit)
  const nextOffset = start + byteLen(text)
  return {
    text,
    totalBytes: row.totalBytes,
    storedBytes: row.storedBytes,
    nextOffset,
    more: nextOffset < row.storedBytes,
  }
}

/** Delete stored results older than `olderThanMs`. Returns how many went. */
export function reapToolResults(db: ClawbooDb, olderThanMs: number, now = Date.now()): number {
  const cutoff = now - olderThanMs
  const doomed = db
    .select({ handle: toolResultBlobs.handle })
    .from(toolResultBlobs)
    .where(ltCreatedAt(cutoff))
    .all()
  if (doomed.length === 0) return 0
  db.delete(toolResultBlobs).where(ltCreatedAt(cutoff)).run()
  return doomed.length
}
