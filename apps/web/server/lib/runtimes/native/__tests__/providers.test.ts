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
  isContextOverflowMessage,
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
      // inputTokens is the whole prompt: 200 uncached + 50 read from the cache.
      { type: 'usage', inputTokens: 250, outputTokens: 33, cachedInputTokens: 50 },
    ])
  })

  it('counts cache writes into the prompt and reports them apart', () => {
    const mapper = createAnthropicEventMapper()
    mapper.handle({
      type: 'message_start',
      message: {
        usage: { input_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 4000 },
      },
    })
    expect(mapper.finish()).toEqual([
      {
        type: 'usage',
        inputTokens: 4010,
        outputTokens: 0,
        cachedInputTokens: 0,
        cacheWriteInputTokens: 4000,
      },
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

  // Gemini 3 on the OpenAI-compatible endpoint: the first tool call of a step
  // carries `extra_content.google.thought_signature`, and the next request must
  // send it back on that call or Gemini rejects the multi-step tool turn.
  it('captures a Gemini thought signature and replays it only to Google', () => {
    const mapper = createOpenAiChunkMapper('google')
    const sig = { google: { thought_signature: 'CiQB0e2Kb9sig' } }
    const events = [
      ...mapper.handle({
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'function-call-1',
                  function: { name: 'list_files', arguments: '{"path":"."}' },
                  extra_content: sig,
                },
                {
                  index: 1,
                  id: 'function-call-2',
                  function: { name: 'read_file', arguments: '{"path":"a.md"}' },
                },
              ],
            },
          },
        ],
      }),
      ...mapper.handle({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
    ]
    const calls = events.filter((e) => e.type === 'tool-call')
    expect(calls).toEqual([
      {
        type: 'tool-call',
        id: 'function-call-1',
        name: 'list_files',
        input: { path: '.' },
        providerData: { provider: 'google', fields: { extra_content: sig } },
      },
      { type: 'tool-call', id: 'function-call-2', name: 'read_file', input: { path: 'a.md' } },
    ])

    const transcript: NeutralMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'look around' }] },
      { role: 'assistant', content: calls.flatMap((c) => (c.type === 'tool-call' ? [c] : [])) },
      {
        role: 'user',
        content: [
          { type: 'tool-result', id: 'function-call-1', output: 'a.md', isError: false },
          { type: 'tool-result', id: 'function-call-2', output: 'hi', isError: false },
        ],
      },
    ]
    const toGoogle = toOpenAiMessages('sys', transcript, 'google')[2] as {
      tool_calls: Array<Record<string, unknown>>
    }
    expect(toGoogle.tool_calls[0]).toMatchObject({ id: 'function-call-1', extra_content: sig })
    expect(toGoogle.tool_calls[1]).not.toHaveProperty('extra_content')
    // A fallback to another provider never sees Google's field.
    const toOpenAi = toOpenAiMessages('sys', transcript, 'openai')[2] as {
      tool_calls: Array<Record<string, unknown>>
    }
    expect(toOpenAi.tool_calls[0]).not.toHaveProperty('extra_content')
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
    // A connection that dropped mid-reply: what Node's fetch throws, as the SDKs rethrow it.
    const dropped = normalizeProviderError(new TypeError('terminated'))
    expect(dropped.code).toBe('network')
    expect(dropped.message).toMatch(/connection to the provider dropped/)
    expect(
      normalizeProviderError(
        new Error(
          'Client network socket disconnected before secure TLS connection was established',
        ),
      ).code,
    ).toBe('network')
    expect(normalizeProviderError({ status: 529 } as unknown as Error).code).toBe('overloaded')
    expect(normalizeProviderError({ status: 503 } as unknown as Error).code).toBe('overloaded')
    expect(normalizeProviderError({ status: 400 } as unknown as Error).code).toBe('bad_request')
    expect(normalizeProviderError(new Error('fetch failed')).code).toBe('network')
    expect(normalizeProviderError(new Error('???')).code).toBe('unknown')
  })

  it('reads a typed rate limit from an error frame in the stream, which has no HTTP status', () => {
    // The OpenAI SDK sets `code` and `type` from the frame's error.
    const openai = normalizeProviderError(
      Object.assign(new Error('too many tokens'), { code: 'rate_limit_exceeded', type: 'tokens' }),
    )
    expect(openai.code).toBe('rate_limit')
    // The run's failure notice reads the message alone, so it says so too.
    expect(openai.message).toBe('Rate limit: too many tokens')
    // The Anthropic SDK sets `type`, keeps the body as `error`, and makes it the message.
    const body = { type: 'error', error: { type: 'rate_limit_error', message: 'too many tokens' } }
    const anthropic = normalizeProviderError(
      Object.assign(new Error(JSON.stringify(body)), { type: 'rate_limit_error', error: body }),
    )
    expect(anthropic.code).toBe('rate_limit')
    expect(isContextOverflowMessage(anthropic.message)).toBe(false)
    // One that says so already is left as it is.
    const said = normalizeProviderError(
      Object.assign(new Error('429 Rate limit reached'), { status: 429 }),
    )
    expect(said.message).toBe('429 Rate limit reached')
  })

  it('reads a 429 sent as a number in the code', () => {
    const body = { code: 429, message: 'too many tokens' }
    const frame = normalizeProviderError(
      Object.assign(new Error('too many tokens'), { code: 429, error: body }),
    )
    expect(frame.code).toBe('rate_limit')
    expect(isContextOverflowMessage(frame.message)).toBe(false)
    // Another number is no rate limit.
    const refused = normalizeProviderError(
      Object.assign(new Error('too many tokens'), { code: 400, error: { code: 400 } }),
    )
    expect(refused.code).toBe('unknown')
  })

  it('does not read any other typed error as a rate limit', () => {
    const overflow = normalizeProviderError(
      Object.assign(new Error('too many tokens in the request'), {
        status: 400,
        code: 'context_length_exceeded',
        type: 'invalid_request_error',
      }),
    )
    expect(overflow.code).toBe('bad_request')
    expect(isContextOverflowMessage(overflow.message)).toBe(true)
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
