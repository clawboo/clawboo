// ─── Message block constants ──────────────────────────────────────────────────

const TOOL_CALL_PREFIX = '[[tool]]'
const TOOL_RESULT_PREFIX = '[[tool-result]]'
const META_PREFIX = '[[meta]]'
const TRACE_MARKDOWN_PREFIX = '[[trace]]'

// Model output is the input to all of these, and a model can emit an arbitrary
// run of `<think>` openers that never close. The slash in a closing tag carries
// its own following whitespace (`(?:\/\s*)?`) so two `\s*` runs never sit side
// by side competing for the same spaces.
const THINKING_STREAM_TAG_RE =
  /<\s*(?:(\/)\s*)?(?:think(?:ing)?|analysis|thought|antthinking)\s*>/gi
const THINKING_OPEN_RE = /<\s*(think(?:ing)?|analysis)\s*>/i
const THINKING_CLOSE_RE = /<\s*\/\s*(think(?:ing)?|analysis)\s*>/i
const THINKING_TAG_RE = /<\s*(?:\/\s*)?(think(?:ing)?|analysis)\s*>/gi

const ASSISTANT_PREFIX_RE = /^(?:\[\[reply_to_current\]\]|\[reply_to_current\])\s*(?:\|\s*)?/i

const HEARTBEAT_PROMPT_RE = /^Read HEARTBEAT\.md if it exists\b/i
const HEARTBEAT_PATH_RE = /Heartbeat file path:/i

// The surrounding whitespace runs and the id itself are length-capped so an
// unterminated `[message_id:` in model output cannot make each candidate start
// re-measure the rest of the text. Ids are short (uuid-shaped) and the marker
// sits on its own line, so the caps never bite in practice.
const MESSAGE_ID_RE = /\s{0,32}\[message_id:[^\]]{1,128}\]\s{0,32}/gi
const PROJECT_PROMPT_BLOCK_RE = /^(?:Project|Workspace) path:[\s\S]*?\n\s*\n/i
const PROJECT_PROMPT_INLINE_RE = /^(?:Project|Workspace) path:[\s\S]*?memory_search\.\s*/i
const RESET_PROMPT_RE = /^A new session was started via \/new or \/reset[\s\S]*?reasoning\.\s*/i
const SYSTEM_EVENT_BLOCK_RE = /^System:\s*\[[^\]]+\][\s\S]*?\n\s*\n/

// ─── WeakMap caches (module-level, not exported) ──────────────────────────────

export interface ToolCall {
  id?: string
  name: string
  arguments: Record<string, unknown>
}

export interface ToolResult {
  toolCallId?: string
  name: string
  output: string
  isError?: boolean
  details?: Record<string, unknown> | null
}

export interface MessageMeta {
  role?: 'user' | 'assistant'
  timestamp?: number
  thinkingDurationMs?: number
}

export interface ParsedMessage {
  text: string
  thinking: string | null
  toolCalls: ToolCall[]
  toolResults: ToolResult[]
  metadata: MessageMeta
}

export type ParsedToolMarkdown = {
  kind: 'call' | 'result'
  label: string
  body: string
}

// ─── Transcript types (v2) ────────────────────────────────────────────────────

export type TranscriptEntryKind = 'meta' | 'user' | 'assistant' | 'thinking' | 'tool'

export type TranscriptEntryRole = 'user' | 'assistant' | 'tool' | 'system' | 'other'

export type TranscriptEntrySource =
  'local-send' | 'runtime-chat' | 'runtime-agent' | 'history' | 'legacy'

export type TranscriptEntry = {
  entryId: string
  role: TranscriptEntryRole
  kind: TranscriptEntryKind
  text: string
  sessionKey: string
  runId: string | null
  source: TranscriptEntrySource
  timestampMs: number | null
  sequenceKey: number
  confirmed: boolean
  /**
   * Opaque per-entry id. NOT a content hash and not comparable across entries —
   * every producer mints a fresh UUID (or reuses the `entryId`). Dedup keys off
   * `entryId` and, in the web store, off an explicit content signature; nothing
   * derives meaning from this field. Treat it as a spare slot, not an identity.
   */
  fingerprint: string
}

export const AGENT_FILE_NAMES = [
  'AGENTS.md',
  'SOUL.md',
  'IDENTITY.md',
  'USER.md',
  'TOOLS.md',
  'HEARTBEAT.md',
  'MEMORY.md',
] as const

export type AgentFileName = (typeof AGENT_FILE_NAMES)[number]

export interface AgentFileMeta {
  title: string
  hint: string
}

export const AGENT_FILE_META: Record<AgentFileName, AgentFileMeta> = {
  'AGENTS.md': { title: 'AGENTS.md', hint: 'Operating instructions, priorities, and rules.' },
  'SOUL.md': { title: 'SOUL.md', hint: 'Persona, tone, and boundaries.' },
  'IDENTITY.md': { title: 'IDENTITY.md', hint: 'Name, vibe, and emoji.' },
  'USER.md': { title: 'USER.md', hint: 'User profile and preferences.' },
  'TOOLS.md': { title: 'TOOLS.md', hint: 'Local tool notes and conventions.' },
  'HEARTBEAT.md': { title: 'HEARTBEAT.md', hint: 'Small checklist for heartbeat runs.' },
  'MEMORY.md': { title: 'MEMORY.md', hint: 'Durable memory for this agent.' },
}

export const AGENT_FILE_PLACEHOLDERS: Record<AgentFileName, string> = {
  'AGENTS.md': 'How should this agent work? Priorities, rules, and habits.',
  'SOUL.md': 'Tone, personality, boundaries, and how it should sound.',
  'IDENTITY.md': 'Name, vibe, emoji, and a one-line identity.',
  'USER.md': 'How should it address you? Preferences and context.',
  'TOOLS.md': 'Local tool notes, conventions, and shortcuts.',
  'HEARTBEAT.md': 'A tiny checklist for periodic runs.',
  'MEMORY.md': 'Durable facts, decisions, and preferences to remember.',
}

export const isAgentFileName = (value: string): value is AgentFileName =>
  AGENT_FILE_NAMES.includes(value as AgentFileName)

type MessageRecord = Record<string, unknown>

const extractRawText = (message: unknown): string | null => {
  if (!message || typeof message !== 'object') return null
  const m = message as MessageRecord
  const content = m['content']
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const parts = content
      .filter((p): p is MessageRecord => Boolean(p && typeof p === 'object'))
      .filter((p) => p['type'] === 'text' && typeof p['text'] === 'string')
      .map((p) => p['text'] as string)
    if (parts.length > 0) return parts.join('\n')
  }
  if (typeof m['text'] === 'string') return m['text']
  return null
}

const stripAssistantPrefix = (text: string): string => {
  if (!text) return text
  return ASSISTANT_PREFIX_RE.test(text) ? text.replace(ASSISTANT_PREFIX_RE, '').trimStart() : text
}

/**
 * The body of every `<think>…</think>` block, in order.
 *
 * One pass over the tag positions, pairing each opener with the next closer,
 * rather than a search for a partner tag per opener. A model that emits a burst
 * of openers and never closes them would otherwise have every one of them scan
 * the rest of the text looking for a close tag that is not there. A second
 * opener inside an open block is part of that block's body, which is what the
 * `openEnd < 0` guard preserves.
 */
function thinkingBlockBodies(text: string): string[] {
  const bodies: string[] = []
  let openEnd = -1
  for (const match of text.matchAll(THINKING_TAG_RE)) {
    const idx = match.index ?? 0
    if (match[0].includes('/')) {
      if (openEnd >= 0) bodies.push(text.slice(openEnd, idx))
      openEnd = -1
    } else if (openEnd < 0) {
      openEnd = idx + match[0].length
    }
  }
  return bodies
}

const stripThinkingTags = (value: string): string => {
  if (!value) return value
  const hasOpen = THINKING_OPEN_RE.test(value)
  const hasClose = THINKING_CLOSE_RE.test(value)
  if (!hasOpen && !hasClose) return value
  if (hasOpen !== hasClose) {
    if (!hasOpen) return value.replace(THINKING_CLOSE_RE, '').trimStart()
    return value.replace(THINKING_OPEN_RE, '').trimStart()
  }
  if (!THINKING_TAG_RE.test(value)) return value
  THINKING_TAG_RE.lastIndex = 0

  let result = ''
  let lastIndex = 0
  let inThinking = false
  for (const match of value.matchAll(THINKING_TAG_RE)) {
    const idx = match.index ?? 0
    if (!inThinking) result += value.slice(lastIndex, idx)
    const tag = match[0].toLowerCase()
    inThinking = !tag.includes('/')
    lastIndex = idx + match[0].length
  }
  if (!inThinking) result += value.slice(lastIndex)
  return result.trimStart()
}

const EXEC_APPROVAL_WAIT_POLICY = [
  'Execution approval policy:',
  '- If any tool result says approval is required or pending, stop immediately.',
  '- Do not call additional tools and do not switch to alternate approaches.',
  'If approved command output is unavailable, reply exactly: "Waiting for approved command result."',
].join('\n')

const stripAppendedExecApprovalPolicy = (text: string): string => {
  const suffix = `\n\n${EXEC_APPROVAL_WAIT_POLICY}`
  return text.endsWith(suffix) ? text.slice(0, -suffix.length) : text
}

const ENVELOPE_PREFIX = /^\[([^\]]+)\]\s*/
const ENVELOPE_CHANNELS = [
  'WebChat',
  'WhatsApp',
  'Telegram',
  'Signal',
  'Slack',
  'Discord',
  'iMessage',
  'Teams',
  'Matrix',
]

const looksLikeEnvelopeHeader = (header: string): boolean => {
  if (/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z\b/.test(header)) return true
  if (/\d{4}-\d{2}-\d{2} \d{2}:\d{2}\b/.test(header)) return true
  return ENVELOPE_CHANNELS.some((label) => header.startsWith(`${label} `))
}

const stripEnvelope = (text: string): string => {
  const match = text.match(ENVELOPE_PREFIX)
  if (!match) return text
  const header = match[1] ?? ''
  if (!looksLikeEnvelopeHeader(header)) return text
  return text.slice(match[0].length)
}

export const extractText = (message: unknown): string | null => {
  if (!message || typeof message !== 'object') return null
  const m = message as MessageRecord
  const role = typeof m['role'] === 'string' ? m['role'] : ''
  const content = m['content']

  const postProcess = (value: string): string => {
    if (role === 'assistant') {
      return stripAssistantPrefix(stripThinkingTags(value))
    }
    return stripAppendedExecApprovalPolicy(stripEnvelope(value))
  }

  if (typeof content === 'string') return postProcess(content)

  if (Array.isArray(content)) {
    const parts = content
      .filter((p): p is MessageRecord => Boolean(p && typeof p === 'object'))
      .filter((p) => p['type'] === 'text' && typeof p['text'] === 'string')
      .map((p) => p['text'] as string)
    if (parts.length > 0) return postProcess(parts.join('\n'))
  }

  if (typeof m['text'] === 'string') return postProcess(m['text'])
  return null
}

export function extractThinkingFromTaggedText(text: string): string {
  if (!text) return ''
  let result = ''
  let lastIndex = 0
  let inThinking = false
  THINKING_STREAM_TAG_RE.lastIndex = 0
  for (const match of text.matchAll(THINKING_STREAM_TAG_RE)) {
    const idx = match.index ?? 0
    if (inThinking) result += text.slice(lastIndex, idx)
    const isClose = match[1] === '/'
    inThinking = !isClose
    lastIndex = idx + match[0].length
  }
  return result.trim()
}

// Stream variant: also handles unclosed open tag (streaming in progress)
export const extractThinkingFromTaggedStream = (text: string): string => {
  if (!text) return ''
  const closed = extractThinkingFromTaggedText(text)
  if (closed) return closed

  // Check for unclosed open tag (streaming in progress)
  const openRe = /<\s*(?:think(?:ing)?|analysis|thought|antthinking)\s*>/gi
  const openMatches = [...text.matchAll(openRe)]
  if (openMatches.length === 0) return ''
  const closeRe = /<\s*\/\s*(?:think(?:ing)?|analysis|thought|antthinking)\s*>/gi
  const closeMatches = [...text.matchAll(closeRe)]
  const lastOpen = openMatches[openMatches.length - 1]!
  const lastClose = closeMatches[closeMatches.length - 1]
  if (lastClose && (lastClose.index ?? -1) > (lastOpen.index ?? -1)) return closed
  const start = (lastOpen.index ?? 0) + lastOpen[0].length
  return text.slice(start).trim()
}

export const extractThinking = (message: unknown): string | null => {
  if (!message || typeof message !== 'object') return null
  const m = message as MessageRecord
  const content = m['content']
  const parts: string[] = []

  const extractFromRecord = (record: MessageRecord): string | null => {
    const directKeys = [
      'thinking',
      'analysis',
      'reasoning',
      'thinkingText',
      'thinkingDelta',
      'analysisText',
      'analysisDelta',
      'reasoningText',
      'reasoningDelta',
    ] as const

    for (const key of directKeys) {
      const value = record[key]
      if (typeof value === 'string') {
        const cleaned = value.trim()
        if (cleaned) return cleaned
      }
    }
    return null
  }

  if (Array.isArray(content)) {
    for (const p of content) {
      if (!p || typeof p !== 'object') continue
      const item = p as MessageRecord
      const type = typeof item['type'] === 'string' ? item['type'] : ''
      if (type === 'thinking' || type === 'analysis' || type === 'reasoning') {
        const extracted = extractFromRecord(item)
        if (extracted) {
          parts.push(extracted)
        } else if (typeof item['text'] === 'string') {
          const cleaned = item['text'].trim()
          if (cleaned) parts.push(cleaned)
        }
      } else if (typeof item['thinking'] === 'string') {
        const cleaned = item['thinking'].trim()
        if (cleaned) parts.push(cleaned)
      }
    }
  }
  if (parts.length > 0) return parts.join('\n')

  const direct = extractFromRecord(m)
  if (direct) return direct

  const rawText = extractRawText(message)
  if (!rawText) return null

  const extracted = thinkingBlockBodies(rawText)
    .map((body) => body.trim())
    .filter(Boolean)
  if (extracted.length > 0) return extracted.join('\n')

  const tagged = extractThinkingFromTaggedStream(rawText)
  return tagged || null
}

type ToolCallRecord = { id?: string; name?: string; arguments?: unknown }

export type ToolResultRecord = {
  toolCallId?: string
  toolName?: string
  details?: Record<string, unknown> | null
  isError?: boolean
  text?: string | null
}

const formatJson = (value: unknown): string => {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

const formatToolResultMeta = (
  details?: Record<string, unknown> | null,
  isError?: boolean,
): string => {
  const parts: string[] = []
  if (details && typeof details === 'object') {
    const status = details['status']
    if (typeof status === 'string' && status.trim()) parts.push(status.trim())
    const exitCode = details['exitCode']
    if (typeof exitCode === 'number') parts.push(`exit ${exitCode}`)
    const durationMs = details['durationMs']
    if (typeof durationMs === 'number') parts.push(`${durationMs}ms`)
    const cwd = details['cwd']
    if (typeof cwd === 'string' && cwd.trim()) parts.push(cwd.trim())
  }
  if (isError) parts.push('error')
  return parts.length ? parts.join(' · ') : ''
}

export const extractToolCalls = (message: unknown): ToolCallRecord[] => {
  if (!message || typeof message !== 'object') return []
  const content = (message as MessageRecord)['content']
  if (!Array.isArray(content)) return []
  const calls: ToolCallRecord[] = []
  for (const item of content) {
    if (!item || typeof item !== 'object') continue
    const record = item as MessageRecord
    if (record['type'] !== 'toolCall') continue
    calls.push({
      id: typeof record['id'] === 'string' ? record['id'] : undefined,
      name: typeof record['name'] === 'string' ? record['name'] : undefined,
      arguments: record['arguments'],
    })
  }
  return calls
}

export const extractToolResult = (message: unknown): ToolResultRecord | null => {
  if (!message || typeof message !== 'object') return null
  const record = message as MessageRecord
  const role = typeof record['role'] === 'string' ? record['role'] : ''
  if (role !== 'toolResult' && role !== 'tool') return null
  const details =
    record['details'] && typeof record['details'] === 'object'
      ? (record['details'] as Record<string, unknown>)
      : null
  return {
    toolCallId: typeof record['toolCallId'] === 'string' ? record['toolCallId'] : undefined,
    toolName: typeof record['toolName'] === 'string' ? record['toolName'] : undefined,
    details,
    isError: typeof record['isError'] === 'boolean' ? record['isError'] : undefined,
    text: extractText(record),
  }
}

export const formatToolCallMarkdown = (call: ToolCallRecord): string => {
  const name = call.name?.trim() || 'tool'
  const suffix = call.id ? ` (${call.id})` : ''
  const args = formatJson(call.arguments).trim()
  if (!args) return `${TOOL_CALL_PREFIX} ${name}${suffix}`
  return `${TOOL_CALL_PREFIX} ${name}${suffix}\n\`\`\`json\n${args}\n\`\`\``
}

export const formatToolResultMarkdown = (result: ToolResultRecord): string => {
  const name = result.toolName?.trim() || 'tool'
  const suffix = result.toolCallId ? ` (${result.toolCallId})` : ''
  const meta = formatToolResultMeta(result.details, result.isError)
  const header = `${name}${suffix}`
  const bodyParts: string[] = []
  if (meta) bodyParts.push(meta)
  const output = result.text?.trim()
  if (output) bodyParts.push(`\`\`\`text\n${output}\n\`\`\``)
  return bodyParts.length === 0
    ? `${TOOL_RESULT_PREFIX} ${header}`
    : `${TOOL_RESULT_PREFIX} ${header}\n${bodyParts.join('\n')}`
}

export const extractToolLines = (message: unknown): string[] => {
  const lines: string[] = []
  for (const call of extractToolCalls(message)) {
    lines.push(formatToolCallMarkdown(call))
  }
  const result = extractToolResult(message)
  if (result) {
    lines.push(formatToolResultMarkdown(result))
  }
  return lines
}

// ─── Markdown type guards ─────────────────────────────────────────────────────

export const isTraceMarkdown = (line: string): boolean => line.startsWith(TRACE_MARKDOWN_PREFIX)
export const isToolMarkdown = (line: string): boolean =>
  line.startsWith(TOOL_CALL_PREFIX) || line.startsWith(TOOL_RESULT_PREFIX)
export const isMetaMarkdown = (line: string): boolean => line.startsWith(META_PREFIX)

export const parseToolMarkdown = (line: string): ParsedToolMarkdown => {
  const kind = line.startsWith(TOOL_RESULT_PREFIX) ? 'result' : 'call'
  const prefix = kind === 'result' ? TOOL_RESULT_PREFIX : TOOL_CALL_PREFIX
  const content = line.slice(prefix.length).trimStart()
  const [labelLine, ...rest] = content.split(/\r?\n/)
  return {
    kind,
    label: labelLine?.trim() || (kind === 'result' ? 'Tool result' : 'Tool call'),
    body: rest.join('\n').trim(),
  }
}

export const formatMetaMarkdown = (meta: {
  role: 'user' | 'assistant'
  timestamp: number
  thinkingDurationMs?: number | null
}): string => {
  return `${META_PREFIX}${JSON.stringify({
    role: meta.role,
    timestamp: meta.timestamp,
    ...(typeof meta.thinkingDurationMs === 'number'
      ? { thinkingDurationMs: meta.thinkingDurationMs }
      : {}),
  })}`
}

export const parseMetaMarkdown = (
  line: string,
): { role: 'user' | 'assistant'; timestamp: number; thinkingDurationMs?: number } | null => {
  if (!isMetaMarkdown(line)) return null
  const raw = line.slice(META_PREFIX.length).trim()
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const role = parsed['role'] === 'user' || parsed['role'] === 'assistant' ? parsed['role'] : null
    const timestamp = typeof parsed['timestamp'] === 'number' ? parsed['timestamp'] : null
    if (!role || !timestamp || !Number.isFinite(timestamp) || timestamp <= 0) return null
    const thinkingDurationMs =
      typeof parsed['thinkingDurationMs'] === 'number' &&
      Number.isFinite(parsed['thinkingDurationMs'])
        ? parsed['thinkingDurationMs']
        : undefined
    return thinkingDurationMs !== undefined
      ? { role, timestamp, thinkingDurationMs }
      : { role, timestamp }
  } catch {
    return null
  }
}

// ─── UI metadata helpers ──────────────────────────────────────────────────────

export const stripUiMetadata = (text: string): string => {
  if (!text) return text
  let cleaned = text.replace(RESET_PROMPT_RE, '')
  cleaned = cleaned.replace(SYSTEM_EVENT_BLOCK_RE, '')
  const before = cleaned
  cleaned = cleaned.replace(PROJECT_PROMPT_INLINE_RE, '')
  if (cleaned === before) cleaned = cleaned.replace(PROJECT_PROMPT_BLOCK_RE, '')
  cleaned = cleaned.replace(MESSAGE_ID_RE, '').trim()
  return stripEnvelope(cleaned)
}

export const isHeartbeatPrompt = (text: string): boolean => {
  if (!text) return false
  const trimmed = text.trim()
  return HEARTBEAT_PROMPT_RE.test(trimmed) || HEARTBEAT_PATH_RE.test(trimmed)
}

// ─── Main parseMessage ────────────────────────────────────────────────────────

export function parseMessage(raw: unknown): ParsedMessage {
  const text = extractText(raw) ?? ''
  const thinking = extractThinking(raw)

  const toolCalls: ToolCall[] = extractToolCalls(raw).map((call) => ({
    id: call.id,
    name: call.name ?? 'tool',
    arguments:
      call.arguments && typeof call.arguments === 'object' && !Array.isArray(call.arguments)
        ? (call.arguments as Record<string, unknown>)
        : {},
  }))

  const toolResults: ToolResult[] = []
  if (raw && typeof raw === 'object') {
    const m = raw as MessageRecord
    const role = typeof m['role'] === 'string' ? m['role'] : ''
    if (role === 'toolResult' || role === 'tool') {
      const details =
        m['details'] && typeof m['details'] === 'object'
          ? (m['details'] as Record<string, unknown>)
          : null
      toolResults.push({
        toolCallId: typeof m['toolCallId'] === 'string' ? m['toolCallId'] : undefined,
        name: typeof m['toolName'] === 'string' ? m['toolName'] : 'tool',
        output: extractText(m) ?? '',
        isError: typeof m['isError'] === 'boolean' ? m['isError'] : undefined,
        details,
      })
    }
  }

  const metadata: MessageMeta = {}
  if (raw && typeof raw === 'object') {
    const m = raw as MessageRecord
    const role = typeof m['role'] === 'string' ? m['role'] : ''
    if (role === 'user' || role === 'assistant') {
      metadata.role = role as 'user' | 'assistant'
    }
    const ts =
      typeof m['timestamp'] === 'number'
        ? m['timestamp']
        : typeof m['createdAt'] === 'number'
          ? m['createdAt']
          : null
    if (ts !== null) metadata.timestamp = ts
  }

  return { text, thinking, toolCalls, toolResults, metadata }
}

// ─── Transcript v2 utilities ──────────────────────────────────────────────────
