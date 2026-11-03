// What the native provider clients actually send. Both SDKs are mocked so the
// request bodies can be read: Anthropic prompt caching is opt-in, and a Gemini 3
// tool turn fails unless the next request carries the thought signature back.

import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { NeutralMessage, ProviderStreamEvent } from '../providers/types'

const sent = vi.hoisted(() => ({
  anthropic: [] as Array<Record<string, unknown>>,
  openai: [] as Array<Record<string, unknown>>,
  openaiScript: [] as Array<Array<Record<string, unknown>>>,
}))

vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = {
      create: async (params: Record<string, unknown>) => {
        sent.anthropic.push(params)
        return (async function* () {
          yield {
            type: 'message_start',
            message: { usage: { input_tokens: 5, cache_read_input_tokens: 2000 } },
          }
          yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } }
        })()
      },
    }
  },
}))

vi.mock('openai', () => ({
  default: class {
    chat = {
      completions: {
        create: async (params: Record<string, unknown>) => {
          sent.openai.push(structuredClone(params))
          const chunks = sent.openaiScript.shift() ?? []
          return (async function* () {
            for (const c of chunks) yield c
          })()
        },
      },
    }
  },
}))

const { createAnthropicProvider } = await import('../providers/anthropic')
const { createOpenAiProvider, OPENROUTER_BASE_URL } = await import('../providers/openai')

const signal = new AbortController().signal
const turn = (messages: NeutralMessage[], model: string) => ({
  model,
  system: 'You are a teammate.',
  messages,
  tools: [{ name: 'list_files', description: 'list', inputSchema: { type: 'object' } }],
  maxOutputTokens: 1024,
  signal,
})
const collect = async (it: AsyncIterable<ProviderStreamEvent>): Promise<ProviderStreamEvent[]> => {
  const out: ProviderStreamEvent[] = []
  for await (const ev of it) out.push(ev)
  return out
}

beforeEach(() => {
  sent.anthropic.length = 0
  sent.openai.length = 0
  sent.openaiScript.length = 0
})

describe('native Anthropic requests', () => {
  it('ask for automatic prompt caching and report the cache read', async () => {
    const client = createAnthropicProvider({ apiKey: 'sk-ant-test' })
    const events = await collect(
      client.streamTurn(
        turn([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], 'claude-haiku-4-5'),
      ),
    )
    expect(sent.anthropic[0]).toMatchObject({ cache_control: { type: 'ephemeral' } })
    expect(events.find((e) => e.type === 'usage')).toEqual({
      type: 'usage',
      inputTokens: 2005,
      outputTokens: 0,
      cachedInputTokens: 2000,
    })
  })

  it('through OpenRouter, only Anthropic models get the cache_control field', async () => {
    const client = createOpenAiProvider({
      provider: 'openrouter',
      apiKey: 'sk-or-test',
      baseURL: OPENROUTER_BASE_URL,
    })
    const msgs: NeutralMessage[] = [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]
    await collect(client.streamTurn(turn(msgs, 'anthropic/claude-haiku-4.5')))
    await collect(client.streamTurn(turn(msgs, 'openai/gpt-4o-mini')))
    expect(sent.openai[0]).toMatchObject({ cache_control: { type: 'ephemeral' } })
    expect(sent.openai[1]).not.toHaveProperty('cache_control')
  })
})

describe('native Google requests (Gemini 3 thought signatures)', () => {
  it('send the signature back on the next request of a two-tool-call turn', async () => {
    const sig = { google: { thought_signature: 'CiQB0e2Kb9sig' } }
    sent.openaiScript.push([
      {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'fc-1',
                  function: { name: 'list_files', arguments: '{}' },
                  extra_content: sig,
                },
                { index: 1, id: 'fc-2', function: { name: 'list_files', arguments: '{"p":1}' } },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      },
    ])
    sent.openaiScript.push([{ choices: [{ delta: { content: 'done' } }] }])
    const client = createOpenAiProvider({
      provider: 'google',
      apiKey: 'AIza-test',
      baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai',
    })

    const messages: NeutralMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'look twice' }] },
    ]
    const first = await collect(client.streamTurn(turn(messages, 'gemini-3.6-flash')))
    const calls = first.flatMap((e) => (e.type === 'tool-call' ? [e] : []))
    expect(calls).toHaveLength(2)
    messages.push({ role: 'assistant', content: calls })
    messages.push({
      role: 'user',
      content: calls.map((c) => ({ type: 'tool-result', id: c.id, output: '[]', isError: false })),
    })
    await collect(client.streamTurn(turn(messages, 'gemini-3.6-flash')))

    const replay = (sent.openai[1]!['messages'] as Array<Record<string, unknown>>).find(
      (m) => m['role'] === 'assistant',
    ) as { tool_calls: Array<Record<string, unknown>> }
    expect(replay.tool_calls[0]).toMatchObject({ id: 'fc-1', extra_content: sig })
    expect(replay.tool_calls[1]).not.toHaveProperty('extra_content')
  })
})
