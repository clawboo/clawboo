// The per-provider dialect mapping + stream-event assembly, exercised against
// SCRIPTED SDK-shaped frames (no network, no SDK import — the pure pieces are
// exported precisely for this).

import { describe, expect, it } from 'vitest'

import {
  createAnthropicEventMapper,
  toAnthropicMessages,
  toAnthropicTools,
} from '../providers/anthropic'
import {
  createOpenAiChunkMapper,
  ollamaBaseUrl,
  toOpenAiMessages,
  toOpenAiTools,
} from '../providers/openai'
import {
  isFallbackWorthy,
  normalizeProviderError,
  type NeutralMessage,
  type NeutralToolDef,
} from '../providers/types'

const TOOLS: NeutralToolDef[] = [
  {
    name: 'write_file',
    description: 'write',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
  },
]

const MESSAGES: NeutralMessage[] = [
  { role: 'user', content: [{ type: 'text', text: 'do it' }] },
  {
    role: 'assistant',
    content: [
      { type: 'text', text: '' }, // empty — must be omitted for Anthropic
      { type: 'tool-call', id: 'tc1', name: 'write_file', input: { path: 'a.md' } },
    ],
  },
  {
    role: 'user',
    content: [{ type: 'tool-result', id: 'tc1', output: 'wrote a.md', isError: false }],
  },
]

describe('anthropic dialect', () => {
  it('maps neutral tools to {name, description, input_schema}', () => {
    expect(toAnthropicTools(TOOLS)[0]).toEqual({
      name: 'write_file',
      description: 'write',
      input_schema: TOOLS[0]?.inputSchema,
    })
  })

  it('omits empty assistant text blocks and shapes tool_use / tool_result', () => {
    const out = toAnthropicMessages(MESSAGES)
    expect(out[1]).toEqual({
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'tc1', name: 'write_file', input: { path: 'a.md' } }],
    })
    expect(out[2]).toEqual({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'tc1', content: 'wrote a.md' }],
    })
  })

  it('flags an erroring tool result with is_error', () => {
    const out = toAnthropicMessages([
      {
        role: 'user',
        content: [{ type: 'tool-result', id: 'tc2', output: 'boom', isError: true }],
      },
    ])
    expect(out[0]).toEqual({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'tc2', content: 'boom', is_error: true }],
    })
  })

  it('assembles a streamed tool call from input_json_delta fragments + reports usage', () => {
    const mapper = createAnthropicEventMapper()
    const out = [
      ...mapper.handle({
        type: 'message_start',
        message: { usage: { input_tokens: 200, cache_read_input_tokens: 50 } },
      }),
      ...mapper.handle({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'Working' },
      }),
      ...mapper.handle({
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'tool_use', id: 'tc9', name: 'write_file' },
      }),
      ...mapper.handle({
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'input_json_delta', partial_json: '{"pa' },
      }),
      ...mapper.handle({
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'input_json_delta', partial_json: 'th":"x.md"}' },
      }),
      ...mapper.handle({ type: 'content_block_stop', index: 1 }),
      ...mapper.handle({ type: 'message_delta', usage: { output_tokens: 33 } }),
      ...mapper.finish(),
    ]
    expect(out).toEqual([
      { type: 'text', delta: 'Working' },
      { type: 'tool-call', id: 'tc9', name: 'write_file', input: { path: 'x.md' } },
      { type: 'usage', inputTokens: 200, outputTokens: 33, cachedInputTokens: 50 },
    ])
  })

  it('routes thinking deltas to the reasoning channel', () => {
    const mapper = createAnthropicEventMapper()
    expect(
      mapper.handle({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'thinking_delta', thinking: 'hm' },
      }),
    ).toEqual([{ type: 'reasoning', delta: 'hm' }])
  })
})

describe('openai dialect', () => {
  it('maps neutral tools to {type:function, function:{name, description, parameters}}', () => {
    expect(toOpenAiTools(TOOLS)[0]).toEqual({
      type: 'function',
      function: { name: 'write_file', description: 'write', parameters: TOOLS[0]?.inputSchema },
    })
  })

  it('places the system prompt first and shapes tool_calls / role:tool messages', () => {
    const out = toOpenAiMessages('you are helpful', MESSAGES)
    expect(out[0]).toEqual({ role: 'system', content: 'you are helpful' })
    expect(out[1]).toEqual({ role: 'user', content: 'do it' })
    expect(out[2]).toEqual({
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: 'tc1',
          type: 'function',
          function: { name: 'write_file', arguments: '{"path":"a.md"}' },
        },
      ],
    })
    expect(out[3]).toEqual({ role: 'tool', tool_call_id: 'tc1', content: 'wrote a.md' })
  })

  it('assembles incremental tool_calls fragments and the include_usage final chunk', () => {
    const mapper = createOpenAiChunkMapper()
    const out = [
      ...mapper.handle({ choices: [{ delta: { content: 'On it. ' } }] }),
      ...mapper.handle({
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: 'call_1', function: { name: 'write_file', arguments: '{"pa' } },
              ],
            },
          },
        ],
      }),
      ...mapper.handle({
        choices: [
          { delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"y.md"}' } }] } },
        ],
      }),
      ...mapper.handle({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
      ...mapper.handle({
        choices: [],
        usage: {
          prompt_tokens: 80,
          completion_tokens: 21,
          prompt_tokens_details: { cached_tokens: 10 },
        },
      }),
      ...mapper.finish(),
    ]
    expect(out).toEqual([
      { type: 'text', delta: 'On it. ' },
      { type: 'tool-call', id: 'call_1', name: 'write_file', input: { path: 'y.md' } },
      { type: 'usage', inputTokens: 80, outputTokens: 21, cachedInputTokens: 10 },
    ])
  })

  it('flushes assembled tool calls at stream end even without finish_reason', () => {
    const mapper = createOpenAiChunkMapper()
    mapper.handle({
      choices: [
        {
          delta: {
            tool_calls: [
              { index: 0, id: 'call_2', function: { name: 'list_files', arguments: '{}' } },
            ],
          },
        },
      ],
    })
    const out = mapper.finish()
    expect(out[0]).toEqual({ type: 'tool-call', id: 'call_2', name: 'list_files', input: {} })
    expect(out[1]).toMatchObject({ type: 'usage' })
  })

  it('ollamaBaseUrl honors the env override', () => {
    expect(ollamaBaseUrl({})).toBe('http://localhost:11434/v1')
    expect(ollamaBaseUrl({ OLLAMA_BASE_URL: 'http://box:9999/v1' })).toBe('http://box:9999/v1')
  })
})

describe('provider error normalization', () => {
  it('maps statuses to typed codes', () => {
    expect(normalizeProviderError({ status: 401, message: 'no' } as unknown as Error).code).toBe(
      'auth',
    )
    expect(normalizeProviderError({ status: 429 } as unknown as Error).code).toBe('rate_limit')
    expect(normalizeProviderError({ status: 529 } as unknown as Error).code).toBe('overloaded')
    expect(normalizeProviderError({ status: 503 } as unknown as Error).code).toBe('overloaded')
    expect(normalizeProviderError({ status: 400 } as unknown as Error).code).toBe('bad_request')
    expect(normalizeProviderError(new Error('fetch failed')).code).toBe('network')
    expect(normalizeProviderError(new Error('???')).code).toBe('unknown')
  })

  it('only auth / rate_limit / overloaded / network justify fallback', () => {
    expect(isFallbackWorthy('auth')).toBe(true)
    expect(isFallbackWorthy('rate_limit')).toBe(true)
    expect(isFallbackWorthy('overloaded')).toBe(true)
    expect(isFallbackWorthy('network')).toBe(true)
    expect(isFallbackWorthy('bad_request')).toBe(false)
    expect(isFallbackWorthy('unknown')).toBe(false)
  })
})
