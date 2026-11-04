// ─── Text clawboo did not write, framed as data ─────────────────────────────
// A model reads everything clawboo hands it as one pile, so text that a teammate,
// a person or a sub-task wrote can read exactly like clawboo's own instructions:
// a room post, a task's comments, a sub-task's result in a `[Task Update]`, a
// mailbox note riding a tool result. This module is the one place that frames
// such text as data, so every surface does it the same way:
//
//   · a header that says who it came from and that it is not the person
//     (`isUser=false`, the inter-session wire format clawboo borrowed from
//     OpenClaw for peer posts first);
//   · every line of the text quote-prefixed (`| `), so none of it can stand at
//     the start of a line and pass for a section heading, a separator or a
//     second header;
//   · any inter-session header inside the text collapsed to an inert marker.
//
// `defangSectionMarkers` is the other half, for a surface that renders text
// unquoted between markers of its own (the turn envelope).
//
// Import-free, like the rest of board-core: it ships into the Vite SPA.

/** The envelope opener, matched case-insensitively (all-ASCII, so a lowercased
 *  slice comparison is exact). */
const HEADER_PREFIX = '[inter-session message'

/**
 * DEFANG any inter-session envelope header smuggled in a body. A hostile peer
 * could otherwise embed a byte-identical
 * `[Inter-session message · … · isUser=true]` line that reads as a real
 * (user-authority) envelope; the binding controls the OUTER header, never the
 * body. Each embedded header (opener through its first closing `]`) collapses
 * to an inert marker. A single forward index scan, not a regex: a body stuffed
 * with unterminated openers must cost one pass over the text, never a fresh
 * tail-rescan per opener.
 */
export function defangInterSessionHeaders(body: string): string {
  let out = ''
  let cursor = 0
  while (true) {
    const start = body.indexOf('[', cursor)
    if (start === -1) break
    if (body.slice(start, start + HEADER_PREFIX.length).toLowerCase() !== HEADER_PREFIX) {
      out += body.slice(cursor, start + 1)
      cursor = start + 1
      continue
    }
    const close = body.indexOf(']', start + HEADER_PREFIX.length)
    // With no `]` left anywhere, this opener and every later one stay open.
    // An open header still reads like one to a model that does not wait for the
    // `]`, and some surfaces print text unquoted, so each loses its opener.
    if (close === -1) return out + body.slice(cursor, start) + defangOpeners(body.slice(start))
    out += body.slice(cursor, start) + '[peer-quoted header]'
    cursor = close + 1
  }
  return out + body.slice(cursor)
}

/** `rest` with the opener of every header in it made inert, in one scan. */
function defangOpeners(rest: string): string {
  let out = ''
  let cursor = 0
  for (let at = rest.indexOf('['); at !== -1; at = rest.indexOf('[', at + 1)) {
    if (rest.slice(at, at + HEADER_PREFIX.length).toLowerCase() !== HEADER_PREFIX) continue
    out += rest.slice(cursor, at) + '[peer-quoted header'
    cursor = at + HEADER_PREFIX.length
  }
  return out + rest.slice(cursor)
}

/** Every line of `text`, quote-prefixed, so no line of it begins where a line
 *  of clawboo's own begins. */
export function quoteLines(text: string): string {
  // Every line break a reader could see, not only `\n`: a bare `\r` or a
  // Unicode separator would otherwise start a line with no quote mark.
  return text
    .split(/\r\n|[\n\r\u0085\u2028\u2029]/)
    .map((line) => `| ${line}`)
    .join('\n')
}

/** Where a framed item came from. Rendered into its header line, so every value
 *  is clawboo's own (an id, a name from the roster, a fixed word), never the
 *  item's text. */
export interface InterSessionAttribution {
  /** Who wrote it: an agent's id or name, `person`, or `clawboo`. */
  from: string
  /** What it is: `peer` or `system` for a room post, `task-comment`,
   *  `task-result`, a mailbox note's kind. */
  kind: string
  /** A room post's sequence number. */
  seq?: number
}

/** A value inside the header: one line, with nothing that could close the
 *  header early, pass for one of its separators or spell a field of its own. */
const headerValue = (value: string): string =>
  value
    .replace(/[[\]·=]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim() || 'unknown'

/**
 * Frame `body` as data from `attr.from`: one authentic header, then the body
 * with every inter-session header in it neutralised and every line quoted. The
 * body can never present itself as a second header, or as the person.
 */
export function formatInterSessionMessage(attr: InterSessionAttribution, body: string): string {
  const fields = [`from=${headerValue(attr.from)}`, `kind=${headerValue(attr.kind)}`]
  if (attr.seq !== undefined) fields.push(`seq=${attr.seq}`)
  const header = `[Inter-session message · ${fields.join(' · ')} · isUser=false]`
  return `${header}\n${quoteLines(defangInterSessionHeaders(body))}`
}

export interface PeerPostLike {
  authorAgentId: string
  body: string
  /** 'peer' = a teammate's post · 'system' = board-mutation narration. Both are
   *  non-user: system narration is evidence too, never a user instruction. */
  kind: string
  seq: number
}

/**
 * Wrap a room post as a non-user, inter-session evidence message. The returned
 * string is what a receiving runtime sees as a tool result / injected turn.
 *
 * Escalation is prevented BY CONSTRUCTION, not by the receiver's judgement: the
 * body is defanged (any embedded inter-session header is neutralised) and every
 * body line is quote-prefixed, so the wrapper always yields EXACTLY ONE authentic
 * header (the outer one, controlled by the connection binding) and the body can
 * never present itself as a second turn, least of all the user's.
 */
export function formatPeerPost(post: PeerPostLike): string {
  return formatInterSessionMessage(
    { from: post.authorAgentId, kind: post.kind, seq: post.seq },
    post.body,
  )
}

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Every line break a reader could see, as regex character-class source: the
 *  ones `quoteLines` splits on. */
const LINE_BREAKS = '\\n\\r\\u0085\\u2028\\u2029'

/**
 * Turn every line of `text` that looks like one of a surface's own section
 * markers (`[Label …]` or `[End label …]`, alone on its line, any case) into
 * plain text. For text a surface renders UNQUOTED between its markers: a body
 * that carried `[End ambient]` and then `[Addressed to you …]` would otherwise
 * close one section and open another, all of it someone else's words.
 *
 * Matches the SHAPE rather than exact literals, so a near-miss that would still
 * read as authentic to a model is caught too. `labels` are taken literally.
 */
export function defangSectionMarkers(text: string, labels: readonly string[]): string {
  if (labels.length === 0) return text
  const names = labels.map(escapeRegExp).join('|')
  // A line is bounded by any break `quoteLines` splits on (the `m` flag's `^`
  // and `$` miss U+0085), and a marker never reaches past its own line, so a
  // `[` whose `]` sits lines later takes nothing with it.
  const marker = new RegExp(
    `(?<=^|[${LINE_BREAKS}])[ \\t]*\\[(?:end[ \\t]+)?(?:${names})\\b[^\\]${LINE_BREAKS}]*\\][ \\t]*(?=$|[${LINE_BREAKS}])`,
    'gi',
  )
  return text.replace(marker, '(quoted section marker)')
}

/**
 * `text` on one line: every run of whitespace, line breaks included, becomes one
 * space. With `max`, a longer result is cut to `max` characters ending in `…`.
 * For a title or a name that sits inside a line clawboo writes.
 */
export function oneLine(text: string, max?: number): string {
  // `\s` covers every line break but U+0085, which `quoteLines` treats as one.
  const flat = text.replace(/[\s\u0085]+/g, ' ').trim()
  if (max === undefined || flat.length <= max) return flat
  if (max <= 0) return ''
  const cut = flat.slice(0, max - 1)
  // Never end on the first half of a character: alone it shows as U+FFFD.
  return `${/[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut}…`
}
