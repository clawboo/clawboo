// OpenAI provider client — also the carrier for every OpenAI-COMPATIBLE
// endpoint: OpenRouter and Ollama ride this exact client with a base-URL
// override (no extra dependency). Lazy SDK import; Chat Completions streaming
// with `stream_options.include_usage` (the final chunk carries usage);
// incremental `delta.tool_calls` fragments are assembled by index and emitted
// as COMPLETE tool calls. The neutral→OpenAI message/tool conversion is this
// provider's whole dialect mapping — small pure functions, exported for tests.

import {
  normalizeProviderError,
  type NeutralMessage,
  type NeutralToolDef,
  type ProviderClient,
  type ProviderStreamEvent,
  type ProviderTurnParams,
} from './types'

// ── Structural slices of the SDK surface we touch ───────────────────────────

export interface OpenAiChunkSlice {
  choices?: Array<{
    delta?: {
      content?: string | null
      tool_calls?: Array<{
        index: number
        id?: string
        function?: { name?: string; arguments?: string }
      }>
    }
    finish_reason?: string | null
  }>
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    prompt_tokens_details?: { cached_tokens?: number }
  } | null
}
interface OpenAiSdkModule {
  default: new (opts: { apiKey: string; baseURL?: string }) => {
    chat: {
      completions: {
        create(
          params: Record<string, unknown>,
          reqOpts?: { signal?: AbortSignal },
        ): Promise<AsyncIterable<OpenAiChunkSlice>>
      }
    }
  }
}

export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1'

export function ollamaBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const base = env['OLLAMA_BASE_URL']
  return base && base.trim() ? base.trim() : 'http://localhost:11434/v1'
}

// ── Pure dialect mapping (neutral → OpenAI Chat Completions) ────────────────

export function toOpenAiTools(tools: NeutralToolDef[]): Array<Record<string, unknown>> {
  return tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.inputSchema },
  }))
}

export function toOpenAiMessages(
  system: string,
  messages: NeutralMessage[],
): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [{ role: 'system', content: system }]
  for (const m of messages) {
    if (m.role === 'assistant') {
      const text = m.content
        .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
        .map((p) => p.text)
        .join('')
      const calls = m.content.filter((p) => p.type === 'tool-call')
      out.push({
        role: 'assistant',
        content: text || null,
        ...(calls.length > 0
          ? {
              tool_calls: calls.map((c) => ({
                id: c.id,
                type: 'function',
                function: { name: c.name, arguments: JSON.stringify(c.input ?? {}) },
              })),
            }
          : {}),
      })
      continue
    }
    // User-role: plain text becomes a user message; each tool result becomes
    // its own role:'tool' message (the OpenAI shape for feeding results back).
    const texts = m.content.filter((p): p is { type: 'text'; text: string } => p.type === 'text')
    if (texts.length > 0) out.push({ role: 'user', content: texts.map((p) => p.text).join('\n\n') })
    for (const part of m.content) {
      if (part.type === 'tool-result') {
        out.push({ role: 'tool', tool_call_id: part.id, content: part.output })
      }
    }
  }
  return out
}

// ── Stateful chunk mapper (exported for scripted-fake tests) ────────────────

export interface OpenAiChunkMapper {
  handle(chunk: OpenAiChunkSlice): ProviderStreamEvent[]
  /** Flush assembled tool calls + the usage event at stream end. */
  finish(): ProviderStreamEvent[]
}

export function createOpenAiChunkMapper(): OpenAiChunkMapper {
  const toolAcc = new Map<number, { id: string; name: string; args: string }>()
  let flushedTools = false
  let usage: ProviderStreamEvent | null = null

  const flushTools = (): ProviderStreamEvent[] => {
    if (flushedTools) return []
    flushedTools = true
    const out: ProviderStreamEvent[] = []
    for (const [, acc] of [...toolAcc.entries()].sort((a, b) => a[0] - b[0])) {
      let input: unknown = {}
      try {
        input = JSON.parse(acc.args || '{}')
      } catch {
        input = { _raw: acc.args }
      }
      out.push({ type: 'tool-call', id: acc.id, name: acc.name, input })
    }
    toolAcc.clear()
    return out
  }

  return {
    handle(chunk: OpenAiChunkSlice): ProviderStreamEvent[] {
      const out: ProviderStreamEvent[] = []
      const choice = chunk.choices?.[0]
      if (choice?.delta?.content) out.push({ type: 'text', delta: choice.delta.content })
      for (const frag of choice?.delta?.tool_calls ?? []) {
        const acc = toolAcc.get(frag.index) ?? { id: '', name: '', args: '' }
        if (frag.id) acc.id = frag.id
        if (frag.function?.name) acc.name = frag.function.name
        if (frag.function?.arguments) acc.args += frag.function.arguments
        toolAcc.set(frag.index, acc)
      }
      if (choice?.finish_reason === 'tool_calls') out.push(...flushTools())
      if (chunk.usage) {
        usage = {
          type: 'usage',
          inputTokens: chunk.usage.prompt_tokens ?? 0,
          outputTokens: chunk.usage.completion_tokens ?? 0,
          ...(chunk.usage.prompt_tokens_details?.cached_tokens != null
            ? { cachedInputTokens: chunk.usage.prompt_tokens_details.cached_tokens }
            : {}),
        }
      }
      return out
    },
    finish(): ProviderStreamEvent[] {
      const out = flushTools()
      out.push(usage ?? { type: 'usage', inputTokens: 0, outputTokens: 0 })
      return out
    },
  }
}

// ── The client ───────────────────────────────────────────────────────────────

export function createOpenAiProvider(opts: {
  provider: string
  apiKey: string
  baseURL?: string
}): ProviderClient {
  let clientPromise: Promise<InstanceType<OpenAiSdkModule['default']>> | null = null
  const getClient = (): Promise<InstanceType<OpenAiSdkModule['default']>> => {
    clientPromise ??= (async () => {
      const mod = (await import('openai')) as unknown as OpenAiSdkModule
      return new mod.default({
        apiKey: opts.apiKey,
        ...(opts.baseURL ? { baseURL: opts.baseURL } : {}),
      })
    })()
    return clientPromise
  }

  return {
    provider: opts.provider,
    async *streamTurn(p: ProviderTurnParams): AsyncIterable<ProviderStreamEvent> {
      const mapper = createOpenAiChunkMapper()
      let stream: AsyncIterable<OpenAiChunkSlice>
      try {
        const client = await getClient()
        stream = await client.chat.completions.create(
          {
            model: p.model,
            messages: toOpenAiMessages(p.system, p.messages),
            ...(p.tools.length > 0 ? { tools: toOpenAiTools(p.tools) } : {}),
            // api.openai.com wants the modern param; compat endpoints
            // (OpenRouter/Ollama, reached via baseURL) take the classic one.
            ...(opts.baseURL
              ? { max_tokens: p.maxOutputTokens }
              : { max_completion_tokens: p.maxOutputTokens }),
            stream: true,
            stream_options: { include_usage: true },
          },
          { signal: p.signal },
        )
      } catch (err) {
        throw normalizeProviderError(err)
      }
      try {
        for await (const chunk of stream) {
          for (const out of mapper.handle(chunk)) yield out
        }
      } catch (err) {
        throw normalizeProviderError(err)
      }
      for (const out of mapper.finish()) yield out
    },
  }
}
