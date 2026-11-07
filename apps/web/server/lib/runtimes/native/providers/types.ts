// Provider-neutral shapes for the native harness. The Conversation maintains
// NeutralMessages; each provider client converts them to its own dialect
// inline (~50 LoC each — deliberately a pair of small functions per provider,
// not a translation layer). Stream events are emitted COMPLETE for tool calls
// (each client assembles its SDK's incremental fragments internally).

/**
 * Provider-opaque fields a provider attached to a tool call and needs back
 * verbatim on the next request, tagged with the provider that produced them.
 * Gemini 3 on the OpenAI-compatible endpoint puts its thought signature at
 * `tool_calls[].extra_content.google.thought_signature` and rejects a later
 * request that drops it. Only the producing provider ever sees them again.
 */
export interface ProviderToolCallData {
  provider: string
  fields: Record<string, unknown>
}

export type NeutralContentPart =
  | { type: 'text'; text: string }
  | {
      type: 'tool-call'
      id: string
      name: string
      input: unknown
      providerData?: ProviderToolCallData
    }
  | { type: 'tool-result'; id: string; output: string; isError: boolean }

export interface NeutralMessage {
  role: 'user' | 'assistant'
  content: NeutralContentPart[]
}

/** Provider-neutral tool definition — JSON Schema args (as served by MCP
 *  tools/list and the built-in file tools). */
export interface NeutralToolDef {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

export type ProviderStreamEvent =
  | { type: 'text'; delta: string }
  | { type: 'reasoning'; delta: string }
  | {
      type: 'tool-call'
      id: string
      name: string
      input: unknown
      providerData?: ProviderToolCallData
    }
  | {
      type: 'usage'
      /** Every prompt token of the turn, cached or not. */
      inputTokens: number
      outputTokens: number
      /** The share of `inputTokens` read from the provider's prompt cache. */
      cachedInputTokens?: number
      /** The share of `inputTokens` written to the provider's prompt cache. */
      cacheWriteInputTokens?: number
    }

export interface ProviderTurnParams {
  model: string
  system: string
  messages: NeutralMessage[]
  tools: NeutralToolDef[]
  maxOutputTokens: number
  signal: AbortSignal
}

export interface ProviderClient {
  readonly provider: string
  /** One streamed model response. Throws ProviderError on request failure. */
  streamTurn(p: ProviderTurnParams): AsyncIterable<ProviderStreamEvent>
}

export type ProviderErrorCode =
  'auth' | 'rate_limit' | 'overloaded' | 'network' | 'bad_request' | 'unknown'

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly code: ProviderErrorCode,
    readonly status?: number,
  ) {
    super(message)
    this.name = 'ProviderError'
  }
}

/** Codes that justify trying the next routing candidate (vs surfacing). */
export function isFallbackWorthy(code: ProviderErrorCode): boolean {
  return code === 'auth' || code === 'rate_limit' || code === 'overloaded' || code === 'network'
}

// A provider rejects an oversized prompt with an HTTP 400 (`bad_request`) whose
// message says the context/prompt is too large — phrased differently per provider
// (Anthropic "prompt is too long: N tokens > M maximum"; OpenAI "maximum context
// length is N tokens…"; the reported "Context overflow: prompt too large…"). Detected
// so the native harness can surface a CLEAN, clawboo-authored terminal instead of the
// raw provider text (which often suggests CLI-only remediation — "Try /reset (or /new)"
// — that does not apply to a server-orchestrated team run).
const CONTEXT_OVERFLOW_RE =
  /context[\s_-]?(?:overflow|length|window|limit)|(?:prompt|input) (?:is )?too (?:large|long)|maximum context|exceeds? (?:the )?(?:maximum )?context|too many tokens|reduce the length of the (?:messages|prompt)/i

// Wordings the pattern above misses: Gemini's "The input token count (N) exceeds the
// maximum number of tokens allowed (M).", Moonshot's "Your request exceeded model token
// limit: N (requested: M)", and xAI's "maximum prompt length". Kept apart from it for
// the same reason as below: it has a character-for-character copy in the browser.
const MORE_CONTEXT_OVERFLOW_RE =
  /exceed(?:s|ed)? (?:the )?(?:maximum number of tokens|model token limit)|maximum prompt length/i

// A rate limit can use the same words: a tokens-per-minute 429 reads "Tokens per
// minute limit exceeded - too many tokens processed." Waiting fixes that one, and the
// session behind it is sound, so its words rule an overflow out. The SDKs start an
// HTTP error's message with its status. CONTEXT_OVERFLOW_RE stays as it is: the browser
// keeps a copy of it, character for character.
const RATE_LIMIT_MESSAGE_RE =
  /^\s*429\b|\b(?:http|status|error code):?\s*429\b|rate[\s_-]?limit|too many requests|resource[\s_-]?exhausted|\bquota\b|usage[\s_-]?limit|\bper[\s_-]?(?:min(?:ute)?|hour|day)\b|\bthis (?:minute|hour|day)\b|\btp[mhd]\b|wait before/i

/** True when a provider error message indicates the prompt exceeded the model's
 *  context window (an oversized-input 400), as opposed to a rate limit or another
 *  bad_request. */
export function isContextOverflowMessage(message: string): boolean {
  return (
    (CONTEXT_OVERFLOW_RE.test(message) || MORE_CONTEXT_OVERFLOW_RE.test(message)) &&
    !RATE_LIMIT_MESSAGE_RE.test(message)
  )
}

// "too many tokens" beside what it counts or the status that refused it, which is how
// `classifyError` tells an overflow from a limit nothing names.
const NAMED_TOKEN_LIMIT_RE =
  /\b(?:400|413|422|prompt|input|request|messages?|context)\b[^\n]*too many tokens|too many tokens\b[^\n]*\b(?:prompt|input|request|messages?|context|model)\b/i

/**
 * Whether a failure notice should call this message the context window. A caller holding
 * a provider's 400 can read a bare "too many tokens" as an overflow, but a notice has only
 * the words, and the ledger files those words as a rate limit (`classifyError`). So the
 * phrase counts only beside what it counts, and otherwise the message needs other words
 * that say so. The browser's `gatewayRunFailureText` reads a message the same way.
 */
export function readsAsContextOverflow(message: string): boolean {
  return (
    isContextOverflowMessage(message) &&
    (NAMED_TOKEN_LIMIT_RE.test(message) ||
      isContextOverflowMessage(message.replace(/too many tokens/gi, '')))
  )
}

/** A provider's own name for a rate limit, in an error field. */
const RATE_LIMIT_NAME_RE = /rate[_-]?limit|too[_-]?many[_-]?requests|resource[_-]?exhausted/i

/** Whether an SDK error names a rate limit. An error frame inside a stream carries
 *  no HTTP status: the OpenAI SDK sets `code` and `type` from its body, and the
 *  Anthropic SDK sets `type` and keeps the whole body as `error`. Some providers send
 *  the status as a number in `code`. */
function namesRateLimit(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const e = err as {
    code?: unknown
    type?: unknown
    error?: { code?: unknown; type?: unknown; error?: { code?: unknown; type?: unknown } }
  }
  return [
    e.code,
    e.type,
    e.error?.code,
    e.error?.type,
    e.error?.error?.code,
    e.error?.error?.type,
  ].some((name) =>
    typeof name === 'string' ? RATE_LIMIT_NAME_RE.test(name) || name === '429' : name === 429,
  )
}

/** A rate limit's message as a failure notice should read it. The notice reads the
 *  message alone, so one that does not say it is a rate limit has to be told to. */
export function rateLimitMessage(message: string): string {
  return RATE_LIMIT_MESSAGE_RE.test(message) ? message : `Rate limit: ${message}`
}

/** Normalize an SDK/network error into a typed ProviderError. Reads `.status`
 *  structurally so we stay decoupled from SDK error-class majors. */
export function normalizeProviderError(err: unknown): ProviderError {
  if (err instanceof ProviderError) return err
  const message = err instanceof Error ? err.message : String(err)
  const status =
    err &&
    typeof err === 'object' &&
    'status' in err &&
    typeof (err as { status: unknown }).status === 'number'
      ? (err as { status: number }).status
      : undefined
  if (status === 401 || status === 403) return new ProviderError(message, 'auth', status)
  if (status === 429 || namesRateLimit(err)) {
    return new ProviderError(rateLimitMessage(message), 'rate_limit', status)
  }
  if (status === 529 || (status != null && status >= 500))
    return new ProviderError(message, 'overloaded', status)
  if (status === 400 || status === 404 || status === 422)
    return new ProviderError(message, 'bad_request', status)
  // Node's fetch reports a connection that dropped mid-reply as a bare `TypeError:
  // terminated`, which the SDKs rethrow as it is.
  if (message.trim() === 'terminated') {
    return new ProviderError('The connection to the provider dropped during the reply.', 'network')
  }
  if (/fetch failed|econnrefused|enotfound|etimedout|network|socket/i.test(message)) {
    return new ProviderError(message, 'network')
  }
  return new ProviderError(message, 'unknown', status)
}
