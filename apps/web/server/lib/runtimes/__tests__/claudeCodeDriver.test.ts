// The Claude Agent SDK is a DOCUMENTED OPTIONAL dependency: the published
// `clawboo` tarball does not ship it (its per-platform optional dependency is a
// ~210 MB `claude` binary), so a packaged install hits the resolver error first.
// `isAgentSdkMissing` decides whether that error becomes the "install it
// alongside clawboo" remediation — it must fire for our specifier and stay
// quiet for everything else, so an unrelated failure is never mislabeled.

import { describe, expect, it, vi } from 'vitest'

import { mapClaudeEvent, type ClaudeNativeEvent } from '@clawboo/adapter-claude-code'

import {
  createClaudeCodeDriver,
  isAgentSdkMissing,
  translateClaudeMessage,
} from '../claudeCodeDriver'
import type { RuntimeRunContext } from '../types'

function resolverError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code })
}

describe('isAgentSdkMissing', () => {
  it('recognizes the ESM resolver miss for the agent SDK', () => {
    expect(
      isAgentSdkMissing(
        resolverError(
          'ERR_MODULE_NOT_FOUND',
          "Cannot find package '@anthropic-ai/claude-agent-sdk' imported from /app/dist/server.js",
        ),
      ),
    ).toBe(true)
  })

  it('recognizes the CJS resolver miss for the agent SDK', () => {
    expect(
      isAgentSdkMissing(
        resolverError('MODULE_NOT_FOUND', "Cannot find module '@anthropic-ai/claude-agent-sdk'"),
      ),
    ).toBe(true)
  })

  it('does not claim a DIFFERENT missing module is the agent SDK', () => {
    expect(
      isAgentSdkMissing(
        resolverError('ERR_MODULE_NOT_FOUND', "Cannot find package 'some-transitive-dep'"),
      ),
    ).toBe(false)
  })

  // The realistic shape of that failure: the SDK resolved fine, but something IT
  // imports did not — so the SDK's own path appears as the IMPORTER. A substring
  // test would tell the user to install a package they already have.
  it('does not misread a transitive miss whose importer sits inside the SDK (ESM)', () => {
    expect(
      isAgentSdkMissing(
        resolverError(
          'ERR_MODULE_NOT_FOUND',
          "Cannot find package 'zod' imported from " +
            '/app/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs',
        ),
      ),
    ).toBe(false)
  })

  it('does not misread a transitive miss whose importer sits inside the SDK (CJS)', () => {
    expect(
      isAgentSdkMissing(
        resolverError(
          'MODULE_NOT_FOUND',
          "Cannot find module 'zod'\nRequire stack:\n- " +
            '/app/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs',
        ),
      ),
    ).toBe(false)
  })

  it('does not fire on a resolver error whose message it cannot parse', () => {
    expect(
      isAgentSdkMissing(resolverError('ERR_MODULE_NOT_FOUND', 'something unexpected went wrong')),
    ).toBe(false)
  })

  it('does not treat a non-resolver failure as a missing SDK', () => {
    expect(
      isAgentSdkMissing(resolverError('ERR_INVALID_ARG_TYPE', '@anthropic-ai/claude-agent-sdk')),
    ).toBe(false)
    expect(isAgentSdkMissing(new Error('@anthropic-ai/claude-agent-sdk blew up at runtime'))).toBe(
      false,
    )
    expect(isAgentSdkMissing(null)).toBe(false)
    expect(isAgentSdkMissing('@anthropic-ai/claude-agent-sdk')).toBe(false)
  })
})

// A deliberate abort is not a failure. The SDK rejects its iterator when the
// abort signal fires, and this driver used to report that rejection as
// `ok: false`, which the adapter maps to a FATAL error. Every consumer then read
// a user pressing Stop as a crash: the badge went to error, and the team chat
// posted a "The run failed" notice blaming the user for the thing they just did.
// The native, codex and hermes drivers all mark their own aborts; this test keeps
// this one in line with them.

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: ({ options }: { options: { abortController: AbortController } }) => ({
    async *[Symbol.asyncIterator]() {
      // Hang until aborted, exactly as a real in-flight query does, and reject
      // the same way the SDK does. The already-aborted check matters: the driver
      // awaits a dynamic import before it starts iterating, so a fast abort can
      // land before this body ever runs.
      const { signal } = options.abortController
      await new Promise<void>((_resolve, reject) => {
        const fail = (): void => reject(new Error('Claude Code process aborted by user'))
        if (signal.aborted) fail()
        else signal.addEventListener('abort', fail)
      })
      yield undefined as never
    },
  }),
}))

describe('createClaudeCodeDriver: abort is a clean terminal, not a failure', () => {
  it('reports an aborted run as ok + aborted rather than as an error', async () => {
    const driver = createClaudeCodeDriver(
      { agentId: 'a1', sessionKey: 'agent:a1:team:t', message: 'hi', model: null, context: null },
      { cwd: null, model: null, apiKeyEnv: {} } as unknown as RuntimeRunContext,
    )
    const seen: ClaudeNativeEvent[] = []
    driver.onEvent((ev) => seen.push(ev))
    await driver.start()
    await driver.abort()
    // Let the rejection propagate through the driver's catch.
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0))

    const terminal = seen.find((e) => e.type === 'result')
    expect(terminal, 'the run should reach a terminal').toBeDefined()
    // `aborted` is what the adapter maps to `done: 'aborted'`; an `ok: false`
    // here becomes `kind: 'error', fatal: true` instead.
    expect(terminal).toMatchObject({ ok: true, aborted: true })
    expect(terminal).not.toHaveProperty('errorMessage')
  })
})

// An API error (expired login, bad key, billing limit) reaches the SDK consumer
// as an assistant notice flagged with its cause, then a `result` with
// `subtype: 'success'` AND `is_error: true`. The frames below are the ones the
// CLI bundled with SDK 0.3.268 emits for an invalid ANTHROPIC_API_KEY. The run
// must end as a failure carrying the cause, so the task is not marked done
// with the error text as its result.
describe('createClaudeCodeDriver: an API error is a failed run', () => {
  const frames = [
    { type: 'system', subtype: 'init', session_id: 'sess-1', model: 'claude-sonnet-5' },
    {
      type: 'assistant',
      error: 'authentication_failed',
      message: { content: [{ type: 'text', text: 'Invalid API key · Fix external API key' }] },
    },
    {
      type: 'result',
      subtype: 'success',
      is_error: true,
      api_error_status: 401,
      result: 'Invalid API key · Fix external API key',
      session_id: 'sess-1',
      total_cost_usd: 0,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  ]

  it('reports ok:false with the error text, the HTTP status and the typed cause', async () => {
    const driver = createClaudeCodeDriver(
      { agentId: 'a1', sessionKey: 'agent:a1:team:t', message: 'hi', model: null, context: null },
      { cwd: null, model: null, apiKeyEnv: {} } as unknown as RuntimeRunContext,
      {
        loadSdk: async () => ({
          query: () =>
            (async function* () {
              for (const f of frames) yield f
            })(),
        }),
      },
    )
    const seen: ClaudeNativeEvent[] = []
    driver.onEvent((ev) => seen.push(ev))
    await driver.start()
    for (let i = 0; i < 10 && !seen.some((e) => e.type === 'result'); i++)
      await new Promise((r) => setTimeout(r, 0))

    // The CLI's error notice never streams as if the model wrote it.
    expect(seen.filter((e) => e.type === 'text')).toEqual([])
    expect(seen.find((e) => e.type === 'result')).toMatchObject({
      ok: false,
      errorMessage: 'Invalid API key · Fix external API key (HTTP 401)',
      errorCode: 'authentication_failed',
    })
  })

  it('keeps the text of a max_output_tokens message, which is real model output', () => {
    expect(
      translateClaudeMessage({
        type: 'assistant',
        error: 'max_output_tokens',
        message: { content: [{ type: 'text', text: 'partial answer' }] },
      }),
    ).toEqual([{ type: 'text', text: 'partial answer' }])
  })

  it('keeps the real cause of an error_during_execution result, which also sets is_error', () => {
    expect(
      translateClaudeMessage(
        {
          type: 'result',
          subtype: 'error_during_execution',
          is_error: true,
          errors: ['tool crashed'],
        },
        { apiError: 'authentication_failed' },
      ),
    ).toMatchObject([{ type: 'result', ok: false, errorMessage: 'tool crashed' }])
    expect(
      translateClaudeMessage({
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        errors: ['tool crashed'],
      })[0],
    ).not.toHaveProperty('errorCode')
  })

  it('leaves a clean success untouched', () => {
    expect(
      translateClaudeMessage({ type: 'result', subtype: 'success', is_error: false, result: 'ok' }),
    ).toMatchObject([{ type: 'result', ok: true, summary: 'ok' }])
  })

  it('reports a prompt that outgrew the context window as out of room, not as an API error', () => {
    const [ev] = translateClaudeMessage(
      {
        type: 'result',
        subtype: 'success',
        is_error: true,
        terminal_reason: 'prompt_too_long',
        result: 'Prompt is too long',
        session_id: 'sess-1',
      },
      { apiError: 'invalid_request' },
    )
    expect(ev).toMatchObject({
      type: 'result',
      ok: false,
      contextFull: true,
      // The CLI's text is the reason, never a reply: team chat commits a summary.
      summary: '',
      errorMessage: 'Prompt is too long',
    })
    expect(ev).not.toHaveProperty('errorCode')
  })

  it('reports the other two context-limit endings as out of room, as the CLI sends them', () => {
    // Captured from Claude Code 2.1.268 against a stand-in Messages API. The CLI pairs
    // each with an assistant message whose `error` is `invalid_request`.
    const endings = [
      { terminal_reason: 'blocking_limit', result: 'Prompt is too long' },
      {
        terminal_reason: 'rapid_refill_breaker',
        result:
          'Autocompact is thrashing: the context refilled to the limit within 3 turns of the previous compact, 3 times in a row. A file being read or a tool output is likely too large for the context window. Try reading in smaller chunks, or use /clear to start fresh.',
      },
    ]
    for (const ending of endings) {
      const [ev] = translateClaudeMessage(
        { type: 'result', subtype: 'success', is_error: true, session_id: 'sess-1', ...ending },
        { apiError: 'invalid_request' },
      )
      expect(ev).toMatchObject({
        type: 'result',
        ok: false,
        contextFull: true,
        summary: '',
        errorMessage: ending.result,
      })
      expect(ev).not.toHaveProperty('errorCode')
    }
  })

  it("never streams the CLI's text for these endings: its assistant frame carries the error", () => {
    // Captured from Claude Code 2.1.268 against a stand-in Messages API: the frame just
    // before each `result`. Without its `error` field this text would stream as a reply.
    for (const text of [
      'Prompt is too long',
      'Autocompact is thrashing: the context refilled to the limit within 3 turns of the previous compact, 3 times in a row. A file being read or a tool output is likely too large for the context window. Try reading in smaller chunks, or use /clear to start fresh.',
    ]) {
      expect(
        translateClaudeMessage({
          type: 'assistant',
          error: 'invalid_request',
          message: { content: [{ type: 'text', text }] },
        }),
      ).toEqual([])
    }
  })

  it('leaves every other failed ending as the API error it is', () => {
    for (const terminal_reason of ['api_error', 'model_error', 'image_error', 'budget_exhausted']) {
      const [ev] = translateClaudeMessage(
        {
          type: 'result',
          subtype: 'success',
          is_error: true,
          terminal_reason,
          result: 'refused',
        },
        { apiError: 'rate_limit' },
      )
      expect(ev).toMatchObject({ type: 'result', ok: false, errorCode: 'rate_limit' })
      expect(ev).not.toHaveProperty('contextFull')
    }
  })

  it('the adapter rotates a full context instead of failing the run', () => {
    let seq = 0
    const out = mapClaudeEvent(
      {
        type: 'result',
        ok: false,
        contextFull: true,
        summary: 'Prompt is too long',
        errorMessage: 'Prompt is too long',
      },
      { runId: 'r1', sessionId: null },
      () => ++seq,
      () => 0,
      'the work so far',
    )
    // The cause rides a NON-fatal typed error, so no host treats the run as failed
    // on it; the terminal is the same "out of room" a turn ceiling ends on.
    expect(out.find((e) => e.kind === 'error')).toMatchObject({
      code: 'context_overflow',
      fatal: false,
    })
    expect(out.find((e) => e.kind === 'done')).toMatchObject({
      reason: 'max_turns',
      summary: 'the work so far',
    })
  })

  it('the adapter carries the cause onto the fatal error event', () => {
    let seq = 0
    const out = mapClaudeEvent(
      {
        type: 'result',
        ok: false,
        summary: 'Invalid API key',
        errorMessage: 'Invalid API key',
        errorCode: 'authentication_failed',
      },
      { runId: 'r1', sessionId: null },
      () => ++seq,
    )
    expect(out.find((e) => e.kind === 'error')).toMatchObject({
      code: 'authentication_failed',
      fatal: true,
    })
    expect(out.find((e) => e.kind === 'done')).toMatchObject({ reason: 'error' })
  })
})
