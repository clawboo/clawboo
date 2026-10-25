// Steering a Claude Code run: the driver runs the SDK in streaming-input mode,
// pushes a steer in as a `next`-priority user message, and closes input only once
// every message it pushed shows up in a turn's `user_message_uuids`. These tests
// script the SDK through the driver's `loadSdk` seam, so they pin the driver's
// side of that contract: one terminal per run, whether the CLI folds the steer
// into the running turn or gives it a turn of its own.

import type { ClaudeNativeEvent } from '@clawboo/adapter-claude-code'
import type { StartOpts } from '@clawboo/executor'
import { describe, expect, it } from 'vitest'

import { createClaudeCodeDriver, type SdkModule, type SdkUserMessage } from '../claudeCodeDriver'
import type { RuntimeRunContext } from '../types'

const OPTS: StartOpts = { agentId: 'a1', sessionKey: 'agent:a1:team:t1', message: 'write the post' }
const CTX = { cwd: null, model: null, apiKeyEnv: {} } as unknown as RuntimeRunContext

function deferred<T = void>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

type Msg = Record<string, unknown>

/** An SDK whose `query` runs `script` with the prompt stream and a yield hook. */
function scriptedSdk(script: (input: AsyncIterator<SdkUserMessage>) => AsyncGenerator<Msg>): {
  sdk: SdkModule
  options: Promise<Record<string, unknown>>
} {
  const options = deferred<Record<string, unknown>>()
  return {
    sdk: {
      query({ prompt, options: o }) {
        options.resolve(o ?? {})
        return script(prompt[Symbol.asyncIterator]()) as AsyncIterable<never>
      },
    },
    options: options.promise,
  }
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !cond(); i++) await tick()
  expect(cond()).toBe(true)
}

describe('createClaudeCodeDriver: steering through streaming input', () => {
  it('folds a mid-turn steer into the running turn and reports ONE terminal', async () => {
    const steerSent = deferred()
    let steerUuid = ''
    const { sdk } = scriptedSdk(async function* (input) {
      const first = (await input.next()).value as SdkUserMessage
      expect(first.message.content).toBe('write the post')
      yield { type: 'system', subtype: 'init', session_id: 'sess-1' }
      yield {
        type: 'assistant',
        user_message_uuids: [first.uuid],
        message: {
          content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }],
        },
      }
      await steerSent.promise
      const steer = (await input.next()).value as SdkUserMessage
      steerUuid = steer.uuid
      expect(steer.priority).toBe('next')
      yield {
        type: 'assistant',
        user_message_uuids: [first.uuid, steer.uuid],
        message: { content: [{ type: 'text', text: 'Short version.' }] },
      }
      yield {
        type: 'result',
        subtype: 'success',
        result: 'Short version.',
        session_id: 'sess-1',
        total_cost_usd: 0.02,
        usage: { input_tokens: 100, output_tokens: 20 },
        user_message_uuids: [first.uuid, steer.uuid],
      }
      // Input must close now: every pushed message was consumed.
      expect((await input.next()).done).toBe(true)
    })
    const driver = createClaudeCodeDriver(OPTS, CTX, { loadSdk: async () => sdk })
    const seen: ClaudeNativeEvent[] = []
    driver.onEvent((ev) => seen.push(ev))
    await driver.start()
    await until(() => seen.some((e) => e.type === 'tool-call'))

    const taken = driver.steer!('Keep it short.')
    steerSent.resolve()
    await expect(taken).resolves.toBe(true)
    await until(() => seen.some((e) => e.type === 'result'))

    const results = seen.filter((e) => e.type === 'result')
    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({ ok: true, summary: 'Short version.', costUsd: 0.02 })
    expect(steerUuid).not.toBe('')
  })

  it('a steer that misses the turn gets a turn of its own, still inside ONE run', async () => {
    const steerQueued = deferred()
    const { sdk } = scriptedSdk(async function* (input) {
      const first = (await input.next()).value as SdkUserMessage
      yield { type: 'system', subtype: 'init', session_id: 'sess-2' }
      yield {
        type: 'assistant',
        user_message_uuids: [first.uuid],
        message: { content: [{ type: 'text', text: 'Draft one.' }] },
      }
      await steerQueued.promise
      // The turn ends before the CLI drained the steer.
      yield {
        type: 'result',
        subtype: 'success',
        result: 'Draft one.',
        total_cost_usd: 0.01,
        usage: { input_tokens: 10, output_tokens: 5 },
        user_message_uuids: [first.uuid],
      }
      const steer = (await input.next()).value as SdkUserMessage
      yield {
        type: 'assistant',
        user_message_uuids: [steer.uuid],
        message: { content: [{ type: 'text', text: 'Draft two.' }] },
      }
      yield {
        type: 'result',
        subtype: 'success',
        result: 'Draft two.',
        // Cumulative across turns in streaming-input mode.
        total_cost_usd: 0.03,
        usage: { input_tokens: 20, output_tokens: 7 },
        user_message_uuids: [steer.uuid],
      }
      expect((await input.next()).done).toBe(true)
    })
    const driver = createClaudeCodeDriver(OPTS, CTX, { loadSdk: async () => sdk })
    const seen: ClaudeNativeEvent[] = []
    driver.onEvent((ev) => seen.push(ev))
    await driver.start()
    await until(() => seen.some((e) => e.type === 'text'))

    const taken = driver.steer!('Rewrite it shorter.')
    steerQueued.resolve()
    await expect(taken).resolves.toBe(true)
    await until(() => seen.some((e) => e.type === 'result'))
    await tick()

    const results = seen.filter((e) => e.type === 'result')
    expect(results).toHaveLength(1)
    // The run's cost is the latest running total; its usage, the turns summed.
    expect(results[0]).toMatchObject({
      ok: true,
      summary: 'Draft two.',
      costUsd: 0.03,
      usage: { inputTokens: 30, outputTokens: 12 },
    })
  })

  it('a steer the run never reads (the run fails first) is reported as not taken', async () => {
    const steerQueued = deferred()
    const { sdk } = scriptedSdk(async function* (input) {
      const first = (await input.next()).value as SdkUserMessage
      yield { type: 'system', subtype: 'init', session_id: 'sess-3' }
      await steerQueued.promise
      yield {
        type: 'result',
        subtype: 'error_during_execution',
        errors: ['provider overloaded'],
        user_message_uuids: [first.uuid],
      }
    })
    const driver = createClaudeCodeDriver(OPTS, CTX, { loadSdk: async () => sdk })
    const seen: ClaudeNativeEvent[] = []
    driver.onEvent((ev) => seen.push(ev))
    await driver.start()
    await until(() => seen.some((e) => e.type === 'init'))
    const taken = driver.steer!('x')
    steerQueued.resolve()
    await expect(taken).resolves.toBe(false)
    const results = seen.filter((e) => e.type === 'result')
    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({ ok: false, errorMessage: 'provider overloaded' })
  })

  it('a passive steer (an ambient FYI) never holds a finishing run open', async () => {
    const fyiSent = deferred()
    const { sdk } = scriptedSdk(async function* (input) {
      const first = (await input.next()).value as SdkUserMessage
      yield { type: 'system', subtype: 'init', session_id: 'sess-4' }
      await fyiSent.promise
      // The turn ends without folding the FYI in.
      yield {
        type: 'result',
        subtype: 'success',
        result: 'Done.',
        user_message_uuids: [first.uuid],
      }
    })
    const driver = createClaudeCodeDriver(OPTS, CTX, { loadSdk: async () => sdk })
    const seen: ClaudeNativeEvent[] = []
    driver.onEvent((ev) => seen.push(ev))
    await driver.start()
    await until(() => seen.some((e) => e.type === 'init'))
    const taken = driver.steer!('[team signal] a delegated task finished', { passive: true })
    fyiSent.resolve()
    await until(() => seen.some((e) => e.type === 'result'))
    // The run ended on its own turn; the FYI was not read and says so.
    expect(seen.filter((e) => e.type === 'result')).toHaveLength(1)
    await expect(taken).resolves.toBe(false)
  })

  it('refuses a steer once the run has finished', async () => {
    const { sdk } = scriptedSdk(async function* (input) {
      const first = (await input.next()).value as SdkUserMessage
      yield { type: 'result', subtype: 'success', result: 'ok', user_message_uuids: [first.uuid] }
    })
    const driver = createClaudeCodeDriver(OPTS, CTX, { loadSdk: async () => sdk })
    const seen: ClaudeNativeEvent[] = []
    driver.onEvent((ev) => seen.push(ev))
    await driver.start()
    await until(() => seen.some((e) => e.type === 'result'))
    await expect(driver.steer!('late')).resolves.toBe(false)
  })

  it('passes the prompt as a stream, never as a string', async () => {
    const { sdk, options } = scriptedSdk(async function* (input) {
      const first = (await input.next()).value as SdkUserMessage
      yield { type: 'result', subtype: 'success', result: 'ok', user_message_uuids: [first.uuid] }
    })
    const driver = createClaudeCodeDriver(OPTS, CTX, { loadSdk: async () => sdk })
    await driver.start()
    expect((await options)['permissionMode']).toBe('bypassPermissions')
  })
})
