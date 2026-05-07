export interface DelegationIntent {
  targetAgentName: string
  targetAgentId: string
  taskDescription: string
  sourceAgentId: string
  mentionOffset: number
}

// ─── Structured delegation protocol ──────────────────────────────────────
// Agents are instructed (via AGENTS.md / buildTeamAgentsMd) to emit
// delegations as XML-style `<delegate to="@Name">task</delegate>` blocks.
// This is the PRIMARY parsing path. The legacy 9-pattern regex flow (below)
// is the FALLBACK for when an LLM drifts to natural-language forms.

/**
 * Raw `<delegate>` block with character offsets — used by both the
 * structured parser and the UI renderer to strip / replace in-place.
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

// Match `<delegate to="…">…</delegate>`, case-insensitive, multi-line body.
// `[^"]+` for the `to` attribute keeps it simple — agent names don't contain
// double-quotes. The non-greedy `[\s\S]*?` body handles multi-line tasks.
const DELEGATE_TAG_RE = /<delegate\s+to="([^"]+)">([\s\S]*?)<\/delegate>/gi

/**
 * Find every `<delegate to="@Name">…</delegate>` block in the text. Returns
 * blocks in order of appearance. Agent-name resolution against the team
 * roster is the caller's responsibility — this function is purely a regex
 * extractor.
 */
export function findDelegationBlocks(text: string): DelegationBlock[] {
  const blocks: DelegationBlock[] = []
  // Cloning the regex per call keeps `lastIndex` clean across invocations.
  const re = new RegExp(DELEGATE_TAG_RE.source, DELEGATE_TAG_RE.flags)
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const targetName = (m[1] ?? '').trim()
    const task = (m[2] ?? '').trim()
    blocks.push({
      targetName,
      task,
      blockStart: m.index,
      blockEnd: m.index + m[0].length,
    })
  }
  return blocks
}

/**
 * Resolve a `to="..."` attribute value against the team roster.
 * Tolerates an optional leading `@` and is case-insensitive. Uses
 * longest-prefix match so partial names ("Bug Fixer") still resolve to
 * their full counterpart ("Bug Fixer Boo") when both exist.
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
 * Extract delegation intents from `<delegate>` blocks. Filters: unknown
 * target (not in `teamAgents`), self-delegation, empty task body. Returns
 * intents in source order; if the same agent is targeted twice, both
 * delegations are kept (unlike the regex path's first-only dedupe — when
 * the agent explicitly emits two structured directives we take them at
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
 * Strip every `<delegate>…</delegate>` block from the text. Used by the
 * UI renderer to produce the prose-only segment that gets fed through
 * the markdown pipeline (the blocks themselves render as styled
 * "Delegated to @Name" cards instead).
 */
export function stripDelegationBlocks(text: string): string {
  const re = new RegExp(DELEGATE_TAG_RE.source, DELEGATE_TAG_RE.flags)
  return text.replace(re, '').trim()
}

/**
 * Returns true if the text is a relay/context message that should not be
 * scanned for delegation patterns.
 */
export function isRelayMessage(text: string): boolean {
  return text.startsWith('[Team Update]') || text.startsWith('[Team Context')
}

/**
 * Returns true if the text looks like a PURE introduction response (e.g.,
 * "Hi, I'm Bug Fixer Boo and I specialize in...") with no delegation intent.
 * Introduction responses often contain @mentions of teammates as casual
 * acknowledgments ("looking forward to working with @A and @B") that should
 * NOT be parsed as delegations.
 *
 * This is a belt-and-suspenders guard against the message-flooding cascade
 * that occurred when wake messages triggered introduction responses with
 * teammate @mentions.
 *
 * Heuristic — ALL must match:
 * 1. Short text (<400 chars)
 * 2. Greeting / identity opener at the start
 * 3. Specialization keyword early in the text
 * 4. NO explicit delegation patterns anywhere — this is the critical
 *    addition. A response that opens with "Hi! I'm here to help.
 *    @Bug Fixer Boo, please handle X..." is a real delegation, not a pure
 *    intro, even though it pattern-matches the first three conditions.
 */
export function isIntroductionResponse(text: string): boolean {
  if (text.length > 400) return false
  const intro = text.trimStart().slice(0, 200).toLowerCase()
  const hasOpener = /^(hi[!,. ]|hello[!,. ]|hey[!,. ]|greetings[!,. ]|i'm |i am |my name is )/.test(
    intro,
  )
  if (!hasOpener) return false
  const hasSpecKeyword = /speciali[zs]e|specialty|focus|expert|responsible for|here to help/.test(
    intro,
  )
  if (!hasSpecKeyword) return false
  // Critical: if any delegation pattern is present, the response is NOT a
  // pure intro — let `detectDelegations` process it normally.
  if (hasDelegationPattern(text)) return false
  return true
}

/**
 * Returns true if the text contains any of the recognized delegation
 * patterns ("@Name, please ...", "@Name — task", "delegate to @Name: ...",
 * structured "Label: @Name verb …", etc.). Used to disqualify intro-shaped
 * responses that are actually carrying delegations.
 */
function hasDelegationPattern(text: string): boolean {
  // Pattern 1/2: @Name, please/can you/could you … (with or without comma)
  if (/@[A-Za-z][\w .'-]{0,60}?,\s*(?:please|can you|could you)\b/i.test(text)) return true
  if (/@[A-Za-z][\w .'-]{0,60}?\s+(?:please|can you|could you)\b/i.test(text)) return true
  // Pattern 3-6: route to / coordinate with / delegate to / hand off to @Name
  if (/(?:^|\s)(?:delegate to|hand off to|route to|coordinate with)\s+@[A-Za-z]/i.test(text))
    return true
  // Pattern 5: I'd like / I would like / I need @Name to …
  if (/(?:^|\s)I(?:'d| would)?\s*(?:like|need)\s+@[A-Za-z]/i.test(text)) return true
  // Pattern 7: @Name — / @Name – / @Name - {task} (em, en, or regular dash)
  if (/@[A-Za-z][\w .'-]{0,60}?\s*[—–]\s+\S/i.test(text)) return true
  if (/@[A-Za-z][\w .'-]{0,60}?\s+-\s+\S/i.test(text)) return true
  // Pattern 8: @Name: {task}
  if (/@[A-Za-z][\w .'-]{0,60}?\s*:\s+\S/i.test(text)) return true
  // Pattern 9: structured list "Label: @Name verb ..." — colon BEFORE @
  // is a strong delegation signal in any case.
  if (/[:.!?]\s*@[A-Za-z]/i.test(text)) return true
  return false
}

// ---------- code-exclusion helpers ----------

type Range = [start: number, end: number]

/** Collect character ranges covered by fenced code blocks (``` ... ```) */
function fencedCodeRanges(text: string): Range[] {
  const ranges: Range[] = []
  const re = /^```[^\n]*$/gm
  const fences: number[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) fences.push(m.index)
  for (let i = 0; i + 1 < fences.length; i += 2) {
    ranges.push([fences[i]!, fences[i + 1]! + 3]) // include closing ```
  }
  return ranges
}

/** Collect character ranges covered by inline code spans (`...`) */
function inlineCodeRanges(text: string): Range[] {
  const ranges: Range[] = []
  const re = /`([^`\n]+)`/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    ranges.push([m.index, m.index + m[0].length])
  }
  return ranges
}

/** Collect character ranges on blockquote lines (lines starting with >) */
function blockquoteRanges(text: string): Range[] {
  const ranges: Range[] = []
  const re = /^[ \t]*>.*/gm
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    ranges.push([m.index, m.index + m[0].length])
  }
  return ranges
}

function insideAny(offset: number, ranges: Range[]): boolean {
  return ranges.some(([s, e]) => offset >= s && offset < e)
}

// ---------- agent matching ----------

function matchAgentAt(
  text: string,
  atIndex: number,
  sorted: { id: string; name: string }[],
): { id: string; name: string; end: number } | null {
  const afterAt = text.slice(atIndex + 1)
  for (const agent of sorted) {
    if (afterAt.toLowerCase().startsWith(agent.name.toLowerCase())) {
      const rest = afterAt.slice(agent.name.length)
      // Must be followed by a non-alpha boundary (whitespace, punctuation, end)
      if (rest.length === 0 || /^[\s,.:;!?]/.test(rest)) {
        return { id: agent.id, name: agent.name, end: atIndex + 1 + agent.name.length }
      }
    }
  }
  return null
}

// ---------- task extraction ----------

/** Extract task text starting at `start`, stopping at sentence-end, newline, next @mention, or end. */
function extractTask(text: string, start: number, sorted: { id: string; name: string }[]): string {
  let end = text.length
  // Stop at newline
  const nl = text.indexOf('\n', start)
  if (nl !== -1 && nl < end) end = nl
  // Stop at next @mention (a different one)
  for (let i = start; i < end; i++) {
    if (text[i] === '@' && i !== start) {
      const m = matchAgentAt(text, i, sorted)
      if (m) {
        end = i
        break
      }
    }
  }
  // Stop at sentence-ending punctuation followed by space or end
  const slice = text.slice(start, end)
  const sentEnd = /[.!?](?:\s|$)/.exec(slice)
  if (sentEnd) {
    end = start + sentEnd.index
  }
  return text.slice(start, end).trim()
}

// ---------- prefix pattern matchers ----------

type PatternResult = { taskStart: number }

/**
 * Returns true if the @-mention at `atIndex` sits at the start of a clause —
 * either at the very beginning of the text, after a newline, after a
 * sentence-ending punctuator, or after a colon (structured "Label: @Name X"
 * lists). This lets us treat declarative bare-verb forms like
 * "@Name builds the MVP" as delegations only in clause-start position,
 * which is where leaders naturally put them when assigning work.
 */
function isAtClauseStart(text: string, atIndex: number): boolean {
  if (atIndex === 0) return true
  // Look back at most 8 chars — clause-start indicators are local.
  const lookback = Math.min(8, atIndex)
  const tail = text.slice(atIndex - lookback, atIndex)
  // Tail must end with a clause-start signal followed only by whitespace.
  // Signals: newline, sentence-ender (.!?), colon, em/en/regular dash with
  // whitespace before, or be the start of text.
  if (/(?:[\n.!?:])\s*$/.test(tail)) return true
  if (/\s[—–-]\s*$/.test(tail)) return true
  return false
}

/**
 * Bare follow-words that on their own DON'T indicate delegation — fillers,
 * conjunctions, and stative verbs that often appear in casual @-mentions
 * ("@Name and @Other are working on X", "@Name was here").
 */
const NON_DELEGATION_FOLLOW_WORDS = new Set([
  'and',
  'or',
  'but',
  'is',
  'are',
  'was',
  'were',
  'be',
  'been',
  'being',
  'has',
  'have',
  'had',
  'a',
  'an',
  'the',
  'this',
  'that',
  'these',
  'those',
  'as',
  'with',
])

/** Patterns that look at text AFTER the agent name */
function afterNamePatterns(text: string, nameEnd: number, atIndex: number): PatternResult | null {
  const after = text.slice(nameEnd)

  // Pattern 1: @Name, {task}
  const commaMatch = /^,\s*/.exec(after)
  if (commaMatch) {
    const taskStart = nameEnd + commaMatch[0].length
    // Check for "please"/"can you"/"could you" after comma
    const afterComma = text.slice(taskStart)
    const politeMatch = /^(?:please\s+|can you\s+|could you\s+)/i.exec(afterComma)
    if (politeMatch) return { taskStart: taskStart + politeMatch[0].length }
    return { taskStart }
  }

  // Pattern 2: @Name please/can you/could you {task}
  const politeMatch = /^\s+(?:please\s+|can you\s+|could you\s+)/i.exec(after)
  if (politeMatch) return { taskStart: nameEnd + politeMatch[0].length }

  // Pattern 7: @Name — {task} | @Name – {task} | @Name - {task}
  // Em dash (U+2014), en dash (U+2013), or hyphen surrounded by whitespace.
  // Real LLMs frequently use this as a delegation separator (production
  // example: "Let's go. @Engineering Boo — take the lead on the MVP.").
  const dashMatch = /^\s*[—–]\s+|^\s+-\s+/.exec(after)
  if (dashMatch) {
    return { taskStart: nameEnd + dashMatch[0].length }
  }

  // Pattern 8: @Name: {task} — bare colon separator (distinct from Pattern 6
  // which requires "delegate to" before the @-mention). Matches "@Name: build
  // the MVP".
  const colonMatch = /^\s*:\s+/.exec(after)
  if (colonMatch) {
    return { taskStart: nameEnd + colonMatch[0].length }
  }

  // Pattern 9: declarative @Name {verb} {task} — clause-start only.
  // Catches structured lists like "This week: @Engineering Boo builds the
  // MVP" and bare-verb statements at line start. Restricted to clause-start
  // position to avoid false positives on casual mid-sentence references
  // ("I worked with @Name yesterday"). Additionally rejects stative /
  // conjunction follow-words ("@Name is", "@Name and …") to keep the
  // heuristic delegation-shaped.
  if (isAtClauseStart(text, atIndex)) {
    const verbMatch = /^\s+([a-z]\w{1,})/i.exec(after)
    if (verbMatch) {
      const word = verbMatch[1]?.toLowerCase() ?? ''
      if (word && !NON_DELEGATION_FOLLOW_WORDS.has(word)) {
        // taskStart points at the start of the verb (skipping the single
        // space after @Name).
        return { taskStart: nameEnd + (verbMatch[0].length - word.length) }
      }
    }
  }

  return null
}

/** Patterns that look at text BEFORE the @ */
function beforeAtPatterns(text: string, atIndex: number, nameEnd: number): PatternResult | null {
  const before = text.slice(0, atIndex)
  const after = text.slice(nameEnd)

  // Pattern 3: route to @Name for/: {task}
  if (/(?:^|\s)route\s+to\s+$/i.test(before)) {
    const connMatch = /^\s*(?:for\s+|:\s*)/i.exec(after)
    if (connMatch) return { taskStart: nameEnd + connMatch[0].length }
  }

  // Pattern 4: coordinate with @Name on/to {task}
  if (/(?:^|\s)coordinate\s+with\s+$/i.test(before)) {
    const connMatch = /^\s+(?:on\s+|to\s+)/i.exec(after)
    if (connMatch) return { taskStart: nameEnd + connMatch[0].length }
  }

  // Pattern 5: I'd like / I need @Name to {task}
  if (/(?:^|\s)(?:I'd\s+like|I\s+need)\s+$/i.test(before)) {
    const connMatch = /^\s+to\s+/i.exec(after)
    if (connMatch) return { taskStart: nameEnd + connMatch[0].length }
  }

  // Pattern 6: delegate to / hand off to @Name: {task}
  if (/(?:^|\s)(?:delegate\s+to|hand\s+off\s+to)\s+$/i.test(before)) {
    const connMatch = /^\s*:\s*/.exec(after)
    if (connMatch) return { taskStart: nameEnd + connMatch[0].length }
    // Also accept without colon — task starts after whitespace
    const wsMatch = /^\s+/.exec(after)
    if (wsMatch) return { taskStart: nameEnd + wsMatch[0].length }
  }

  return null
}

// ---------- main ----------

export function detectDelegations(
  responseText: string,
  sourceAgentId: string,
  teamAgents: Array<{ id: string; name: string }>,
): DelegationIntent[] {
  // Cheap reject — neither structured tag nor any @-mention present.
  if (!responseText.includes('@') && !responseText.includes('<delegate')) return []
  if (isRelayMessage(responseText)) return []

  // ── PRIMARY: structured `<delegate to="@Name">…</delegate>` blocks ──
  // When an agent emits structured directives we trust those exclusively;
  // any incidental @-mentions in surrounding prose are treated as casual
  // references and are NOT routed (avoids double-firing on the same intent).
  const structured = parseStructuredDelegations(responseText, sourceAgentId, teamAgents)
  if (structured.length > 0) return structured

  // ── FALLBACK: 9-pattern regex flow for natural-language delegations ──
  // Kept as a safety net for LLMs that drift away from the structured
  // protocol. The intro guard runs only on this path because structured
  // delegations are always trusted on the primary path.
  if (isIntroductionResponse(responseText)) return []

  const excluded = [
    ...fencedCodeRanges(responseText),
    ...inlineCodeRanges(responseText),
    ...blockquoteRanges(responseText),
  ]

  const sorted = [...teamAgents].sort((a, b) => b.name.length - a.name.length)
  const results: DelegationIntent[] = []
  const seenAgentIds = new Set<string>()

  for (let i = 0; i < responseText.length; i++) {
    if (responseText[i] !== '@') continue
    if (insideAny(i, excluded)) continue

    const matched = matchAgentAt(responseText, i, sorted)
    if (!matched) continue
    if (matched.id === sourceAgentId) continue
    if (seenAgentIds.has(matched.id)) continue

    // Try before-@ patterns first (they are more specific)
    let result = beforeAtPatterns(responseText, i, matched.end)

    // Then try after-name patterns (pass `i` so Pattern 9 can check
    // whether the @-mention sits at a clause start)
    if (!result) result = afterNamePatterns(responseText, matched.end, i)

    // If no pattern matched, skip (bare @mention without delegation syntax)
    if (!result) continue

    const task = extractTask(responseText, result.taskStart, sorted)
    if (!task) continue

    seenAgentIds.add(matched.id)
    results.push({
      targetAgentName: matched.name,
      targetAgentId: matched.id,
      taskDescription: task,
      sourceAgentId,
      mentionOffset: i,
    })
  }

  return results
}
