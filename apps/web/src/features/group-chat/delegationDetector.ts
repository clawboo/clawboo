export interface DelegationIntent {
  targetAgentName: string
  targetAgentId: string
  taskDescription: string
  sourceAgentId: string
  mentionOffset: number
}

/**
 * Returns true if the text is a relay/context message that should not be
 * scanned for delegation patterns.
 */
export function isRelayMessage(text: string): boolean {
  return text.startsWith('[Team Update]') || text.startsWith('[Team Context')
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

/** Patterns that look at text AFTER the agent name */
function afterNamePatterns(text: string, nameEnd: number): PatternResult | null {
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
  if (!responseText.includes('@')) return []
  if (isRelayMessage(responseText)) return []

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

    // Then try after-name patterns
    if (!result) result = afterNamePatterns(responseText, matched.end)

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
