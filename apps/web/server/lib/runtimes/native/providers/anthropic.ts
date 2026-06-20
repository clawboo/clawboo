// Anthropic provider client. The SDK is imported LAZILY inside the first turn
// so the server never pays for it at boot. Raw streaming events are mapped
// structurally (local type slices, never the SDK's deep generated types) —
// the SDK emits typed stream frames, so this is a faithful re-shape with no
// output scraping. The neutral→Anthropic message/tool conversion is the whole
// "dialect mapping" for this provider: two small pure functions, exported for
// tests.

import {
  normalizeProviderError,
  type NeutralMessage,
  type NeutralToolDef,
  type ProviderClient,
  type ProviderStreamEvent,
  type ProviderTurnParams,
} from './types'

// ── Structural slices of the SDK surface we touch ───────────────────────────

interface AnthropicUsageSlice {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
}
export interface AnthropicStreamEventSlice {
  type: string
  index?: number
  message?: { usage?: AnthropicUsageSlice }
  content_block?: { type: string; id?: string; name?: string }
  delta?: { type?: string; text?: string; thinking?: string; partial_json?: string }
  usage?: AnthropicUsageSlice
}
interface AnthropicSdkModule {
  default: new (opts: { apiKey: string; baseURL?: string }) => {
    messages: {
      create(
        params: Record<string, unknown>,
        reqOpts?: { signal?: AbortSignal },
      ): Promise<AsyncIterable<AnthropicStreamEventSlice>>
    }
  }
}

// ── Pure dialect mapping (neutral → Anthropic) ───────────────────────────────

export function toAnthropicTools(tools: NeutralToolDef[]): Array<Record<string, unknown>> {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema,
  }))
}

export function toAnthropicMessages(messages: NeutralMessage[]): Array<Record<string, unknown>> {
  return messages.map((m) => {
    const content: Array<Record<string, unknown>> = []
    for (const part of m.content) {
      if (part.type === 'text') {
        // Anthropic rejects empty text blocks — omit them (an assistant turn
        // that was pure tool calls has no text part).
        if (part.text) content.push({ type: 'text', text: part.text })
      } else if (part.type === 'tool-call') {
        content.push({ type: 'tool_use', id: part.id, name: part.name, input: part.input ?? {} })
      } else {
        content.push({
          type: 'tool_result',
          tool_use_id: part.id,
          content: part.output,
          ...(part.isError ? { is_error: true } : {}),
        })
      }
    }
    return { role: m.role, content }
  })
}

// ── Stateful stream-event mapper (exported for scripted-fake tests) ─────────

export interface AnthropicEventMapper {
  handle(ev: AnthropicStreamEventSlice): ProviderStreamEvent[]
  /** Emit the single usage event once the stream ends. */
  finish(): ProviderStreamEvent[]
}

export function createAnthropicEventMapper(): AnthropicEventMapper {
  const toolAcc = new Map<number, { id: string; name: string; json: string }>()
  let inputTokens = 0
  let outputTokens = 0
  let cachedInputTokens: number | undefined

  return {
    handle(ev: AnthropicStreamEventSlice): ProviderStreamEvent[] {
      switch (ev.type) {
        case 'message_start': {
          const u = ev.message?.usage
          if (u) {
            inputTokens = u.input_tokens ?? 0
            if (u.cache_read_input_tokens != null) cachedInputTokens = u.cache_read_input_tokens
          }
          return []
        }
        case 'content_block_start': {
          const b = ev.content_block
          if (b?.type === 'tool_use' && b.id && b.name && ev.index != null) {
            toolAcc.set(ev.index, { id: b.id, name: b.name, json: '' })
          }
          return []
        }
        case 'content_block_delta': {
          const d = ev.delta
          if (!d) return []
          if (d.type === 'text_delta' && d.text) return [{ type: 'text', delta: d.text }]
          if (d.type === 'thinking_delta' && d.thinking)
            return [{ type: 'reasoning', delta: d.thinking }]
          if (d.type === 'input_json_delta' && ev.index != null) {
            const acc = toolAcc.get(ev.index)
            if (acc) acc.json += d.partial_json ?? ''
          }
          return []
        }
        case 'content_block_stop': {
          if (ev.index == null) return []
          const acc = toolAcc.get(ev.index)
          if (!acc) return []
          toolAcc.delete(ev.index)
          let input: unknown = {}
          try {
            input = JSON.parse(acc.json || '{}')
          } catch {
            input = { _raw: acc.json }
          }
          return [{ type: 'tool-call', id: acc.id, name: acc.name, input }]
        }
        case 'message_delta': {
          if (ev.usage?.output_tokens != null) outputTokens = ev.usage.output_tokens
          return []
        }
        default:
          return []
      }
    },
    finish(): ProviderStreamEvent[] {
      return [
        {
          type: 'usage',
          inputTokens,
          outputTokens,
          ...(cachedInputTokens != null ? { cachedInputTokens } : {}),
        },
      ]
    },
  }
}

// ── The client ───────────────────────────────────────────────────────────────

export function createAnthropicProvider(opts: {
  apiKey: string
  baseURL?: string
}): ProviderClient {
  let clientPromise: Promise<InstanceType<AnthropicSdkModule['default']>> | null = null
  const getClient = (): Promise<InstanceType<AnthropicSdkModule['default']>> => {
    clientPromise ??= (async () => {
      const mod = (await import('@anthropic-ai/sdk')) as unknown as AnthropicSdkModule
      return new mod.default({
        apiKey: opts.apiKey,
        ...(opts.baseURL ? { baseURL: opts.baseURL } : {}),
      })
    })()
    return clientPromise
  }

  return {
    provider: 'anthropic',
    async *streamTurn(p: ProviderTurnParams): AsyncIterable<ProviderStreamEvent> {
      const mapper = createAnthropicEventMapper()
      let stream: AsyncIterable<AnthropicStreamEventSlice>
      try {
        const client = await getClient()
        stream = await client.messages.create(
          {
            model: p.model,
            system: p.system,
            max_tokens: p.maxOutputTokens,
            messages: toAnthropicMessages(p.messages),
            ...(p.tools.length > 0 ? { tools: toAnthropicTools(p.tools) } : {}),
            stream: true,
          },
          { signal: p.signal },
        )
      } catch (err) {
        throw normalizeProviderError(err)
      }
      try {
        for await (const ev of stream) {
          for (const out of mapper.handle(ev)) yield out
        }
      } catch (err) {
        throw normalizeProviderError(err)
      }
      for (const out of mapper.finish()) yield out
    },
  }
}
