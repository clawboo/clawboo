// Structured-tag utilities for the lifecycle-event orchestration path.
//
// Agents are instructed (via AGENTS.md / buildTeamAgentsMd) to emit structured
// directives — `<delegate to="@Name">task</delegate>` for one-shot delegations
// and `<plan><step to="@Name">task</step>…</plan>` for multi-step plans. These
// are parsed ONCE from a terminal turn summary and turned into durable board
// tasks (see boardOrchestration.ts). `sessions_send` tool-calls are the other
// structured signal; resolveSessionsSendTarget maps one to a team member.
//
// This module is pure parsing/stripping of the structured contract — it does
// NOT scan prose for natural-language intent.

// ─── Delegation tags ─────────────────────────────────────────────────────────

export interface DelegationIntent {
  targetAgentName: string
  targetAgentId: string
  taskDescription: string
  sourceAgentId: string
  mentionOffset: number
}

/**
 * Raw `<delegate>` block with character offsets — used by both the structured
 * parser and the UI renderer to strip / replace in-place.
 */
export interface DelegationBlock {
  /** The name as written inside `to="..."` (the leading `@` is optional). */
  targetName: string
  /** Body text between the open and close tags, trimmed. */
  task: string
  /** Index of the opening `<` of `<delegate ...>`. */
  blockStart: number
  /** Index immediately AFTER the closing `>` of `</delegate>`. */
  blockEnd: number
}

/** One `<open …>body</close>` pair located in a text. */
interface TagBlock {
  /** The opening tag's match, for its capture groups. */
  open: RegExpMatchArray
  /** Offset of the first character of the opening tag. */
  start: number
  /** Offset immediately AFTER the closing tag. */
  end: number
  /** Text between the opening and closing tags. */
  body: string
  /** Offset of the first character of `body`. */
  bodyStart: number
}

/**
 * Pair every opening tag with the next unused closing tag, in one forward pass.
 *
 * The alternative, one regex holding opener, `[\s\S]*?` body and closer, makes
 * every opener that has no closer behind it re-scan the whole remaining text,
 * and a mangled tag stream from a weak model is exactly the input that produces
 * a pile of unclosed openers. Collecting the closers once and walking a pointer
 * through them costs a single pass however lopsided the tags are.
 */
function findTagBlocks(text: string, openRe: RegExp, closeRe: RegExp): TagBlock[] {
  const closes = [...text.matchAll(closeRe)]
  if (closes.length === 0) return []
  const blocks: TagBlock[] = []
  let cursor = 0
  let next = 0
  for (const open of text.matchAll(openRe)) {
    const at = open.index ?? 0
    if (at < cursor) continue
    const bodyStart = at + open[0].length
    while (next < closes.length && (closes[next]?.index ?? 0) < bodyStart) next++
    const close = closes[next]
    if (!close) break
    const end = (close.index ?? 0) + close[0].length
    blocks.push({ open, start: at, end, body: text.slice(bodyStart, close.index ?? 0), bodyStart })
    cursor = end
  }
  return blocks
}

/** Remove `blocks` from `text`, keeping the prose around them. */
function stripTagBlocks(text: string, blocks: TagBlock[]): string {
  if (blocks.length === 0) return text.trim()
  let out = ''
  let cursor = 0
  for (const block of blocks) {
    out += text.slice(cursor, block.start)
    cursor = block.end
  }
  return (out + text.slice(cursor)).trim()
}

// Match `<delegate to="…">…</delegate>`, case-insensitive, multi-line body.
// `[^"]+` for the `to` attribute keeps it simple — agent names don't contain
// double-quotes. The body may span lines and is bounded by the closing tag.
//
// The ENTIRE opening `<delegate ` is optional (`(?:<?\s*delegate\s+)?`). The
// reliable anchor is the closing `</delegate>` plus the `to="…">` attribute
// shape — weaker models always emit those but mangle the opening tag in varied
// ways (observed live with minimax across two runs: `delegate to="@X">…</delegate>`
// with the `<` dropped, AND `to="@X">…</delegate>` with the whole `<delegate`
// dropped). Prose effectively never contains `to="…">…</delegate>`, so anchoring
// on it recovers these drifts without risking false positives. This is the
// shared regex behind BOTH the structured board derivation
// (`parseStructuredDelegations`) and the DelegationCard rendering
// (`splitAssistantText`); keeping the optional `<delegate ` inside the match (not
// just looking past it) means `stripDelegationBlocks` removes the whole tag, so
// no opening-tag fragment leaks into the rendered prose.
// Tolerate straight, single, and curly/smart quotes around the `to=` value —
// weaker models (and copy-paste from rich editors) emit `to='@X'` / `to=“@X”`.
// The whitespace runs inside the opener are length-capped: a real tag carries a
// space or two, and leaving them open-ended lets a long run of blanks be
// re-measured from every offset inside it.
// A name may hold an apostrophe ("Founder's Office"), straight or curly, so the value
// ends at a quote directly before `>`. It cannot hold a double quote, `=` or a line
// break, so one value never runs on into the next attribute.
const DELEGATE_OPEN_RE = /(?:<?\s{0,8}delegate\s{1,8})?to=["'“”‘’]([^"“”>\n=]+?)["'“”‘’]>/gi
const DELEGATE_CLOSE_RE = /<\/delegate>/gi

/**
 * Loose detector for a delegation/plan ATTEMPT — a `<delegate>`/`<plan>`/`<step>`
 * tag shape or a `delegate to=` opener. Used by the orchestrator to tell when a
 * turn TRIED to delegate but the strict parser yielded nothing (mangled/unclosed
 * tag, unknown name), so the delegator can be nudged to re-issue instead of
 * waiting forever. Prose without a tag shape (e.g. "I'll delegate this later")
 * does NOT match — it requires the `<` tag context or the `to=` attribute.
 */
const DELEGATION_INTENT_RE = /<\/?\s*(?:delegate|plan|step)\b|\bdelegate\s+to\s*=/i

export function detectDelegationIntent(text: string): boolean {
  return DELEGATION_INTENT_RE.test(text)
}

/**
 * Find every `<delegate to="@Name">…</delegate>` block in the text. Returns
 * blocks in order of appearance. Agent-name resolution against the team roster
 * is the caller's responsibility — this function is purely a structured-tag
 * extractor.
 */
export function findDelegationBlocks(text: string): DelegationBlock[] {
  // matchAll operates on a clone, so the shared module-level regexes' lastIndex
  // is never mutated across calls.
  return findTagBlocks(text, DELEGATE_OPEN_RE, DELEGATE_CLOSE_RE).map((block) => ({
    targetName: (block.open[1] ?? '').trim(),
    task: block.body.trim(),
    blockStart: block.start,
    blockEnd: block.end,
  }))
}

/**
 * Resolve a `to="..."` attribute value against the team roster. Tolerates an
 * optional leading `@` and is case-insensitive. Uses longest-prefix match so
 * partial names ("Bug Fixer") still resolve to their full counterpart
 * ("Bug Fixer Boo") when both exist.
 */
function resolveTargetName(
  raw: string,
  teamAgents: Array<{ id: string; name: string }>,
): { id: string; name: string } | null {
  const stripped = raw.replace(/^@/, '').trim().toLowerCase()
  if (!stripped) return null
  const sorted = [...teamAgents].sort((a, b) => b.name.length - a.name.length)
  for (const agent of sorted) {
    const lower = agent.name.toLowerCase()
    if (stripped === lower) return agent
  }
  // Fall back to longest-prefix match (handles "Bug Fixer" → "Bug Fixer Boo")
  for (const agent of sorted) {
    const lower = agent.name.toLowerCase()
    if (stripped.startsWith(lower) || lower.startsWith(stripped)) return agent
  }
  return null
}

/**
 * Extract delegation intents from `<delegate>` blocks. Filters: unknown target
 * (not in `teamAgents`), self-delegation, empty task body. Returns intents in
 * source order; if the same agent is targeted twice, both delegations are kept
 * (when the agent explicitly emits two structured directives we take them at
 * face value).
 */
export function parseStructuredDelegations(
  responseText: string,
  sourceAgentId: string,
  teamAgents: Array<{ id: string; name: string }>,
): DelegationIntent[] {
  const blocks = findDelegationBlocks(responseText)
  if (blocks.length === 0) return []

  const intents: DelegationIntent[] = []
  for (const block of blocks) {
    if (!block.task) continue
    const target = resolveTargetName(block.targetName, teamAgents)
    if (!target) continue
    if (target.id === sourceAgentId) continue
    intents.push({
      targetAgentName: target.name,
      targetAgentId: target.id,
      taskDescription: block.task,
      sourceAgentId,
      mentionOffset: block.blockStart,
    })
  }
  return intents
}

/**
 * Strip every `<delegate>…</delegate>` block from the text. Used by the UI
 * renderer to produce the prose-only segment that gets fed through the markdown
 * pipeline (the blocks themselves render as styled "Delegated to @Name" cards /
 * durable board tasks instead).
 */
export function stripDelegationBlocks(text: string): string {
  return stripTagBlocks(text, findTagBlocks(text, DELEGATE_OPEN_RE, DELEGATE_CLOSE_RE))
}

// ─── Plan tags ───────────────────────────────────────────────────────────────
//
// A `<plan>` block contains one or more `<step to="@Name">task</step>` children.
// Plans become durable board task dependency chains; a ready-pump fires the next
// step when its blocker completes.

export interface PlanStep {
  /** The name as written inside `to="…"` (optional leading `@`). */
  targetName: string
  /** Body text between the open and close tags, trimmed. */
  task: string
  /** Character offset of the `<step` opener, relative to the source text. */
  stepStart: number
  /** Index immediately AFTER the closing `>` of `</step>`. */
  stepEnd: number
}

export interface PlanBlock {
  /** Character offset of the `<plan>` opener in the source text. */
  blockStart: number
  /** Index immediately AFTER the closing `>` of `</plan>`. */
  blockEnd: number
  /** Steps in source order. May be empty when the LLM emitted an empty plan. */
  steps: PlanStep[]
}

// Match `<plan>…</plan>`, case-insensitive, multi-line body. The opening `<` is
// optional (`<?`): like `<delegate>`, weaker models reliably emit the closing
// `</plan>` but sometimes drop the leading `<` of the opener (e.g. `plan>…</plan>`).
// The `</plan>` close + the literal `plan` keyword anchor it, so prose never
// false-matches.
const PLAN_OPEN_RE = /<?\s{0,8}plan(?:\s[^>]*)?>/gi
const PLAN_CLOSE_RE = /<\/plan>/gi

// Match `<step to="…">…</step>` inside a plan body. Mirrors the `<delegate>`
// drift tolerance exactly (same `to="…">…<close>` shape): the ENTIRE opening
// `<step ` is optional, anchored on the closing `</step>` + the `to="…">`
// attribute shape — recovers both `step to="@X">…</step>` (dropped `<`) and
// `to="@X">…</step>` (dropped the whole `<step`).
const STEP_OPEN_RE = /(?:<?\s{0,8}step\s{1,8})?to=["'“”‘’]([^"“”>\n=]+?)["'“”‘’]>/gi
const STEP_CLOSE_RE = /<\/step>/gi

/**
 * Find every `<plan>` block in the text and parse its `<step>` children.
 * Returns blocks in source order. Empty plans (`<plan></plan>`) come back with
 * `steps: []` so the caller can decide whether to ignore them.
 */
export function findPlanBlocks(text: string): PlanBlock[] {
  const blocks: PlanBlock[] = []
  for (const plan of findTagBlocks(text, PLAN_OPEN_RE, PLAN_CLOSE_RE)) {
    const steps: PlanStep[] = []
    for (const step of findTagBlocks(plan.body, STEP_OPEN_RE, STEP_CLOSE_RE)) {
      const targetName = (step.open[1] ?? '').trim()
      const task = step.body.trim()
      if (!targetName || !task) continue
      // Translate the step's offset within the plan body back to an absolute
      // offset in the original text so downstream consumers can splice.
      steps.push({
        targetName,
        task,
        stepStart: plan.bodyStart + step.start,
        stepEnd: plan.bodyStart + step.end,
      })
    }
    blocks.push({ blockStart: plan.start, blockEnd: plan.end, steps })
  }
  return blocks
}

/**
 * Strip every `<plan>…</plan>` block from the text. Used by the renderer when
 * producing the plain-text segment between board cards (mirror of
 * `stripDelegationBlocks`).
 */
export function stripPlanBlocks(text: string): string {
  return stripTagBlocks(text, findTagBlocks(text, PLAN_OPEN_RE, PLAN_CLOSE_RE))
}

// ─── What a reply means, and what it only shows ──────────────────────────────
//
// A team's lead writes tags for the engine and nothing else, so the engine reads them
// wherever they stand. In a one-to-one chat Boo Zero also talks about hand-offs with
// the person, and shows drafts and quotes other people's text. A tag a reader sees as
// code or a quote is something being shown, so it must not start paid work.

type Span = readonly [start: number, end: number]

const FENCE_OPEN_RE = /^ {0,3}(`{3,}|~{3,})/
const FENCE_CLOSE_RE = /^ {0,3}(`{3,}|~{3,})\s*$/
const QUOTE_LINE_RE = /^ {0,3}>/
const INDENTED_RE = /^(?: {4}|\t)/
const BLANK_LINE_RE = /\n[ \t]*\r?\n/
/** A line that ends a quote's paragraph without a blank line: a heading, a list item or
 *  a rule. Any other line straight after a quote's words is still that quote. */
const ENDS_QUOTE_PARAGRAPH_RE =
  /^ {0,3}(?:#{1,6}(?:\s|$)|[-*+]\s|\d{1,9}[.)]\s|(?:[-*_][ \t]*){3,}$)/

/** Fenced blocks (a fence never closed runs to the end, as markdown renders it), quotes,
 *  which run on to the next line with no `>` until a blank line, and indented blocks,
 *  which begin only after a blank line. One pass by line. */
function blockSpans(text: string): Span[] {
  const spans: Span[] = []
  let at = 0
  let fence: { char: string; length: number; start: number } | null = null
  let blankBefore = true
  let inIndented = false
  let inQuoteParagraph = false
  for (const line of text.split(/(?<=\n)/)) {
    const end = at + line.length
    const body = line.replace(/\r?\n$/, '')
    const blank = body.trim() === ''
    if (fence) {
      const close = FENCE_CLOSE_RE.exec(body)?.[1]
      if (close && close[0] === fence.char && close.length >= fence.length) {
        spans.push([fence.start, end])
        fence = null
      }
    } else {
      const open = FENCE_OPEN_RE.exec(body)?.[1]
      if (open) {
        fence = { char: open[0]!, length: open.length, start: at }
        inQuoteParagraph = false
      } else if (QUOTE_LINE_RE.test(body)) {
        spans.push([at, end])
        inQuoteParagraph = body.replace(QUOTE_LINE_RE, '').trim() !== ''
      } else if (inQuoteParagraph && !blank && !ENDS_QUOTE_PARAGRAPH_RE.test(body)) {
        spans.push([at, end])
      } else {
        inQuoteParagraph = false
        if (!blank && INDENTED_RE.test(body) && (blankBefore || inIndented)) {
          spans.push([at, end])
          inIndented = true
        } else if (!blank) {
          inIndented = false
        }
      }
    }
    blankBefore = blank
    at = end
  }
  if (fence) spans.push([fence.start, text.length])
  return spans
}

const inSpans = (spans: readonly Span[], offset: number): boolean =>
  spans.some(([start, end]) => offset >= start && offset < end)

/** Inline code: a run of backticks up to the next run of the same length, within one
 *  paragraph. A run with no partner is plain text. Each run is looked at once. */
function inlineCodeSpans(text: string, blocks: readonly Span[]): Span[] {
  const runs = [...text.matchAll(/`+/g)]
    .map((m) => ({ at: m.index ?? 0, length: m[0].length }))
    .filter((r) => !inSpans(blocks, r.at))
  const lastOfLength = new Map<number, number>()
  runs.forEach((r, i) => lastOfLength.set(r.length, i))
  const spans: Span[] = []
  let i = 0
  while (i < runs.length) {
    const open = runs[i]!
    if ((lastOfLength.get(open.length) ?? -1) <= i) {
      i += 1
      continue
    }
    let j = i + 1
    while (runs[j]!.length !== open.length) j += 1
    const close = runs[j]!
    if (BLANK_LINE_RE.test(text.slice(open.at, close.at))) {
      i += 1
      continue
    }
    spans.push([open.at, close.at + close.length])
    i = j + 1
  }
  return spans
}

/** Everything in `text` a reader sees as code or as a quote. */
function shownSpans(text: string): Span[] {
  const blocks = blockSpans(text)
  return [...blocks, ...inlineCodeSpans(text, blocks)]
}

const OPENING_QUOTES = new Set(['"', "'", '“', '‘'])
const CLOSING_QUOTES = new Set(['"', "'", '”', '’'])

/** A tag standing directly between quotation marks is a tag being quoted. */
const inQuotationMarks = (text: string, start: number, end: number): boolean =>
  OPENING_QUOTES.has(text[start - 1] ?? '') && CLOSING_QUOTES.has(text[end] ?? '')

const WORD_CHAR_RE = /[\p{L}\p{N}]/u
const DIGIT_RE = /\p{N}/u

/** A mark with a letter or digit on both sides, like the apostrophe in `It’s`. */
const inWord = (text: string, at: number): boolean =>
  WORD_CHAR_RE.test(text[at - 1] ?? '') && WORD_CHAR_RE.test(text[at + 1] ?? '')

/**
 * Reads, for a tag at `[start, end)` in `scan`, where the quoted sentence holding it
 * closes on its line, or -1 when it stands in none: a quote opens before it on the line
 * where it starts and is still open, and closes after it on the line where it ends. A
 * straight double quote opens only where no word runs into it, and while one is open
 * the next one closes it. One right after a digit, as in `5"`, may be an inch mark or
 * the end of `"take 5"`, so both readings are kept, and a tag is shown when either puts
 * it in a quoted sentence: showing is the safe side. A curly apostrophe between two
 * letters, as in `It’s`, is not a closing quote. A straight apostrophe says nothing, so
 * `'` is left out.
 *
 * `scan` has tags and code blanked, so their quote marks count for nothing. Asked in
 * order along the text, it carries the state forward, so a reply is read once however
 * many tags it has.
 */
function quoteReader(scan: string): (start: number, end: number) => number {
  let pos = 0
  // The readings of the straight quotes so far: one may have a quote open, one closed.
  let mayBeOpen = false
  let mayBeClosed = true
  let doubleOpen = -1
  let doubleClose = -1
  let singleOpen = -1
  let singleClose = -1
  let lastEnd = 0
  const found = new Map<string, number>()
  // The first `ch` at or after `from`. `from` only grows, so a search is not repeated.
  // An apostrophe inside a word is skipped, so `’` finds only a closing quote.
  const nextIndex = (ch: string, from: number): number => {
    const at = found.get(ch)
    if (at !== undefined && (at === -1 || at >= from)) return at
    let fresh = scan.indexOf(ch, from)
    while (fresh !== -1 && ch === '’' && inWord(scan, fresh)) fresh = scan.indexOf(ch, fresh + 1)
    found.set(ch, fresh)
    return fresh
  }
  return (start, end) => {
    if (start < pos || end < lastEnd) {
      // Asked out of order: read this line again from its start.
      pos = scan.lastIndexOf('\n', start - 1) + 1
      mayBeOpen = false
      mayBeClosed = true
      doubleOpen = doubleClose = singleOpen = singleClose = -1
      found.clear()
    }
    lastEnd = end
    for (; pos < start; pos++) {
      const c = scan[pos]
      if (c === '\n') {
        mayBeOpen = false
        mayBeClosed = true
        doubleOpen = doubleClose = singleOpen = singleClose = -1
      } else if (c === '"') {
        const before = scan[pos - 1] ?? ''
        const afterWord = WORD_CHAR_RE.test(before)
        // An open quote closes, or after a digit may stay open; a closed one opens unless
        // a word runs into it.
        const open = (mayBeOpen && DIGIT_RE.test(before)) || (mayBeClosed && !afterWord)
        mayBeClosed = mayBeOpen || (mayBeClosed && afterWord)
        mayBeOpen = open
      } else if (c === '“') doubleOpen = pos
      else if (c === '”') doubleClose = pos
      else if (c === '‘') singleOpen = pos
      else if (c === '’' && !inWord(scan, pos)) singleClose = pos
    }
    const lineEnd = nextIndex('\n', end)
    let closesAt = -1
    const consider = (ch: string): void => {
      const at = nextIndex(ch, end)
      if (at !== -1 && (lineEnd === -1 || at < lineEnd) && (closesAt === -1 || at < closesAt))
        closesAt = at
    }
    if (mayBeOpen) consider('"')
    if (doubleOpen > doubleClose) consider('”')
    if (singleOpen > singleClose) consider('’')
    return closesAt === -1 ? -1 : closesAt + 1
  }
}

/** `text` with these ranges blanked, so every other offset stays where it was. Line
 *  breaks stay too, so a blanked range never joins two lines into one. */
function blanked(text: string, ranges: readonly Span[]): string {
  const parts: string[] = []
  let cursor = 0
  for (const [start, end] of [...ranges].sort((a, b) => a[0] - b[0])) {
    if (end <= cursor) continue
    const from = Math.max(start, cursor)
    parts.push(text.slice(cursor, from), text.slice(from, end).replace(/[^\n]/g, ' '))
    cursor = end
  }
  parts.push(text.slice(cursor))
  return parts.join('')
}

const matchSpans = (text: string, re: RegExp): Span[] =>
  [...text.matchAll(re)].map((m): Span => [m.index ?? 0, (m.index ?? 0) + m[0].length])

/** A reply's tags, split by whether a reader sees them as tags. A tag counts by where
 *  it opens, so a real one keeps a brief with code or a quote in it. */
export interface ActionableHandOffs {
  delegates: DelegationBlock[]
  plans: PlanBlock[]
  /** In code or a quote: shown, and acted on by nothing. */
  shownDelegates: DelegationBlock[]
  shownPlans: PlanBlock[]
}

/** Openers shown in code or a quote that do not close there. They only mention a tag,
 *  and left in they would pair with the closer of the real tag after them. One inside a
 *  real tag's brief is passed over, so the brief keeps it. */
function shownOpenersWithNoClose(text: string, spans: readonly Span[]): Span[] {
  const closes = [...text.matchAll(DELEGATE_CLOSE_RE)]
  // Quotes are counted with every tag's own marks blanked, and code's.
  const scan = blanked(text, [
    ...matchSpans(text, DELEGATE_OPEN_RE),
    ...matchSpans(text, DELEGATE_CLOSE_RE),
    ...spans,
  ])
  const quotedEnd = quoteReader(scan)
  const mentions: Span[] = []
  let cursor = 0
  // Openers come in order, so the first closer after each one, and the code or quote
  // span that could hold it, only move forward.
  let next = 0
  const sorted = [...spans].sort((a, b) => a[0] - b[0])
  let inSpan = 0
  for (const open of text.matchAll(DELEGATE_OPEN_RE)) {
    const at = open.index ?? 0
    if (at < cursor) continue
    const bodyStart = at + open[0].length
    while (next < closes.length && (closes[next]!.index ?? 0) < bodyStart) next += 1
    const close = closes[next]
    while (inSpan < sorted.length && sorted[inSpan]![1] <= at) inSpan += 1
    const span = sorted[inSpan]
    const shownUntil =
      (span && span[0] <= at ? span[1] : undefined) ??
      (inQuotationMarks(text, at, bodyStart) ? bodyStart + 1 : quotedEnd(at, bodyStart))
    // With no closer left it pairs with nothing, but one that is shown is still only a
    // mention, not a hand-off that could not be read.
    if (shownUntil !== -1 && (!close || (close.index ?? 0) >= shownUntil)) {
      mentions.push([at, bodyStart])
      continue
    }
    if (!close) continue
    cursor = (close.index ?? 0) + close[0].length
  }
  return mentions
}

/** The hand-offs, plus what only shows one: code and quotes, and the openers shown in
 *  them that `shownOpenersWithNoClose` set aside. */
function readHandOffs(text: string): ActionableHandOffs & { shown: Span[] } {
  const spans = shownSpans(text)
  const allPlans = findPlanBlocks(text)
  const planSpans = allPlans.map((p): Span => [p.blockStart, p.blockEnd])
  // A plan's steps have the same `to="…">` shape, so they are not read as delegates.
  const withoutPlans = blanked(text, planSpans)
  const mentions = shownOpenersWithNoClose(withoutPlans, spans)
  const tagText = blanked(withoutPlans, mentions)
  const allDelegates = findDelegationBlocks(tagText)
  // Quotes are counted with every tag and all code blanked: their quote marks are not
  // a sentence's.
  const scan = blanked(tagText, [
    ...allDelegates.map((d): Span => [d.blockStart, d.blockEnd]),
    ...matchSpans(tagText, DELEGATE_OPEN_RE),
    ...matchSpans(tagText, DELEGATE_CLOSE_RE),
    ...spans,
  ])
  // Each tag is asked once, in order along the text, so the quotes are read in one pass.
  const quotedEnd = quoteReader(scan)
  const shownAt = new Set<number>()
  for (const { blockStart: start, blockEnd: end } of [...allDelegates, ...allPlans].sort(
    (x, y) => x.blockStart - y.blockStart,
  )) {
    if (inSpans(spans, start) || inQuotationMarks(text, start, end) || quotedEnd(start, end) !== -1)
      shownAt.add(start)
  }
  const isShown = (start: number): boolean => shownAt.has(start)
  const shownDelegates = allDelegates.filter((d) => isShown(d.blockStart))
  const shownPlans = allPlans.filter((p) => isShown(p.blockStart))
  return {
    delegates: allDelegates.filter((d) => !isShown(d.blockStart)),
    plans: allPlans.filter((p) => !isShown(p.blockStart)),
    shownDelegates,
    shownPlans,
    shown: [
      ...spans,
      ...mentions,
      ...shownDelegates.map((d): Span => [d.blockStart, d.blockEnd]),
      ...shownPlans.map((p): Span => [p.blockStart, p.blockEnd]),
    ],
  }
}

export function findActionableHandOffs(text: string): ActionableHandOffs {
  const { delegates, plans, shownDelegates, shownPlans } = readHandOffs(text)
  return { delegates, plans, shownDelegates, shownPlans }
}

/** Take out the tags that count, and leave those only shown. Text with neither comes
 *  back untouched. */
export function stripActionableHandOffs(text: string): string {
  const { delegates, plans } = findActionableHandOffs(text)
  const ranges = [
    ...delegates.map((d): Span => [d.blockStart, d.blockEnd]),
    ...plans.map((p): Span => [p.blockStart, p.blockEnd]),
  ].sort((a, b) => a[0] - b[0])
  if (ranges.length === 0) return text
  let out = ''
  let cursor = 0
  for (const [start, end] of ranges) {
    if (start > cursor) out += text.slice(cursor, start)
    cursor = Math.max(cursor, end)
  }
  return (out + text.slice(cursor)).trim()
}

// Bounded before `to=`, so a long reply full of `<delegate ` stays linear.
const BROKEN_HAND_OFF_RE =
  /<\s*delegate\s[^>\n]{0,200}to\s*=|\bdelegate\s+to\s*=|<\/\s*delegate\s*>|<\s*step\s[^>\n]{0,200}to\s*=/i

/**
 * Does this reply try to hand off in a tag that could not be read? It takes a tag's
 * shape, not its name: "a <plan> needs that team's own chat" is only a mention. Code
 * and quotes do not count, and neither do tags that could be read.
 */
export function looksLikeBrokenHandOff(text: string): boolean {
  const { delegates, plans, shown } = readHandOffs(text)
  return BROKEN_HAND_OFF_RE.test(
    blanked(text, [
      ...shown,
      ...delegates.map((d): Span => [d.blockStart, d.blockEnd]),
      ...plans.map((p): Span => [p.blockStart, p.blockEnd]),
    ]),
  )
}

// ─── sessions_send target resolution ─────────────────────────────────────────

export interface SessionsSendParams {
  /** `agent:<id>:<sessionName>` format, when the caller used a direct key. */
  sessionKey?: string
  /** Human-readable label — typically the agent's `name`. */
  label?: string
  /** Direct agent id when present. */
  agentId?: string
  /** Required body. */
  message: string
}

/**
 * Resolve a `sessions_send` target against the team roster. Tries in priority
 * order:
 *   1. `sessionKey` — parse `agent:<id>:<sessionName>` and look up by id.
 *   2. `agentId` — direct id match.
 *   3. `label` — case-insensitive name match against participants.
 * Returns the resolved participant or null.
 */
export function resolveSessionsSendTarget(
  params: SessionsSendParams,
  participants: { id: string; name: string }[],
): { id: string; name: string } | null {
  if (params.sessionKey) {
    const match = params.sessionKey.match(/^agent:([^:]+):/)
    const id = match?.[1]
    if (id) {
      const hit = participants.find((p) => p.id === id)
      if (hit) return hit
    }
  }
  if (params.agentId) {
    const hit = participants.find((p) => p.id === params.agentId)
    if (hit) return hit
  }
  // A label with nothing in it but spaces or `@` names no one; as an empty
  // prefix it would match every teammate.
  if (params.label && params.label.replace(/^@/, '').trim()) {
    const lower = params.label.toLowerCase()
    const exact = participants.find((p) => p.name.toLowerCase() === lower)
    if (exact) return exact
    // Tolerate leading `@` and longest-prefix.
    const stripped = params.label.replace(/^@/, '').trim().toLowerCase()
    const sorted = [...participants].sort((a, b) => b.name.length - a.name.length)
    for (const p of sorted) {
      if (stripped === p.name.toLowerCase()) return p
    }
    for (const p of sorted) {
      const lp = p.name.toLowerCase()
      if (stripped.startsWith(lp) || lp.startsWith(stripped)) return p
    }
  }
  return null
}
