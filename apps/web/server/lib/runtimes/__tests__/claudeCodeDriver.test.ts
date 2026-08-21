// The Claude Agent SDK is a DOCUMENTED OPTIONAL dependency: the published
// `clawboo` tarball does not ship it (its per-platform optional dependency is a
// ~210 MB `claude` binary), so a packaged install hits the resolver error first.
// `isAgentSdkMissing` decides whether that error becomes the "install it
// alongside clawboo" remediation — it must fire for our specifier and stay
// quiet for everything else, so an unrelated failure is never mislabeled.

import { describe, expect, it, vi } from 'vitest'

import type { ClaudeNativeEvent } from '@clawboo/adapter-claude-code'

import { createClaudeCodeDriver, isAgentSdkMissing } from '../claudeCodeDriver'
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
