// Provider-neutral shapes for the native harness. The Conversation maintains
// NeutralMessages; each provider client converts them to its own dialect
// inline (~50 LoC each — deliberately a pair of small functions per provider,
// not a translation layer). Stream events are emitted COMPLETE for tool calls
// (each client assembles its SDK's incremental fragments internally).

export type NeutralContentPart =
  | { type: 'text'; text: string }
  | { type: 'tool-call'; id: string; name: string; input: unknown }
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
  | { type: 'tool-call'; id: string; name: string; input: unknown }
  | { type: 'usage'; inputTokens: number; outputTokens: number; cachedInputTokens?: number }

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
  | 'auth'
  | 'rate_limit'
  | 'overloaded'
  | 'network'
  | 'bad_request'
  | 'unknown'

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

/** True when a provider error message indicates the prompt exceeded the model's
 *  context window (an oversized-input 400), as opposed to another bad_request. */
export function isContextOverflowMessage(message: string): boolean {
  return CONTEXT_OVERFLOW_RE.test(message)
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
  if (status === 429) return new ProviderError(message, 'rate_limit', status)
  if (status === 529 || (status != null && status >= 500))
    return new ProviderError(message, 'overloaded', status)
  if (status === 400 || status === 404 || status === 422)
    return new ProviderError(message, 'bad_request', status)
  if (/fetch failed|econnrefused|enotfound|etimedout|network|socket/i.test(message)) {
    return new ProviderError(message, 'network')
  }
  return new ProviderError(message, 'unknown', status)
}
