import { describe, expect, it } from 'vitest'

import { resolveRuntimeIntegration } from '@clawboo/executor'
import { runAdapterContract, type AdapterTestHarness } from '@clawboo/executor/contract'

import { NativeAdapter } from '../adapter'
import { FakeNativeDriver } from '../testing/fakeNativeDriver'
import type { NativeEvent } from '../types'

const SK = 'agent:native-1:main'

// ─── Shared contract suite ───────────────────────────────────────────────────

function makeNativeHarness(): AdapterTestHarness {
  let driver = new FakeNativeDriver()
  return {
    label: 'clawboo-native',
    makeAdapter() {
      driver = new FakeNativeDriver()
      return new NativeAdapter(() => driver)
    },
    start(adapter) {
      return adapter.start({}, { agentId: 'native-1', sessionKey: SK, message: 'hi' })
    },
    emit(frame) {
      driver.emit(frame as NativeEvent)
    },
    frames: {
      delta: (text) => ({ type: 'text', text }),
      toolCall: (name, input) => ({ type: 'tool-call', id: 'tc-1', name, input }),
      final: (summary) => ({ type: 'result', ok: true, summary }),
      aborted: () => ({ type: 'result', ok: false, aborted: true, summary: '' }),
      error: (message) => ({ type: 'result', ok: false, errorMessage: message, summary: '' }),
    },
    recordedCalls() {
      return driver.calls
    },
  }
}

runAdapterContract(makeNativeHarness())

// ─── Native-specific behavior ────────────────────────────────────────────────

describe('NativeAdapter specifics', () => {
  it('capabilities() declares the native runtime class with a persistent per-identity home', () => {
    const caps = new NativeAdapter(() => new FakeNativeDriver()).capabilities()
    expect(caps).toMatchObject({
      runtimeClass: 'native',
      nativeHome: { scope: 'per-identity', persist: true },
      nativeSkills: 'none',
      nativeMemory: 'preserve',
      nativeChannels: 'none',
      nativeScheduler: false,
    })
  })

  it('integration plan resolves to a persistent per-identity home (the host materializes it)', () => {
    const caps = new NativeAdapter(() => new FakeNativeDriver()).capabilities()
    const plan = resolveRuntimeIntegration(caps)
    expect(plan.home).toEqual({ kind: 'persistent', scope: 'per-identity' })
    expect(plan.preserveMemory).toBe(true)
    expect(plan.coRunScheduler).toBe(false)
  })

  it('capabilities() advertises the full conversational surface + a context window', () => {
    const caps = new NativeAdapter(() => new FakeNativeDriver()).capabilities()
    expect(caps).toMatchObject({
      streaming: true,
      mcp: true,
      worktrees: true,
      resume: true,
      toolApproval: true,
    })
    expect(caps.contextWindowTokens).toBeGreaterThan(0)
  })

  it('events() late-binds runId from the init session id', async () => {
    const driver = new FakeNativeDriver()
    const adapter = new NativeAdapter(() => driver)
    const run = await adapter.start({}, { agentId: 'native-1', sessionKey: SK, message: 'go' })
    const iterator = adapter.events(run)[Symbol.asyncIterator]()
    driver.emit({ type: 'init', sessionId: 'native-abc', model: 'claude-haiku-4-5' })
    const first = await iterator.next()
    expect(run.runId).toBe('native-abc')
    expect(first.value).toMatchObject({ kind: 'status', phase: 'init', model: 'claude-haiku-4-5' })
    await iterator.return?.()
  })

  it('sessionCodec round-trips the captured native session id', async () => {
    const driver = new FakeNativeDriver()
    const adapter = new NativeAdapter(() => driver)
    const run = await adapter.start({}, { agentId: 'native-1', sessionKey: SK, message: 'go' })
    const iterator = adapter.events(run)[Symbol.asyncIterator]()
    driver.emit({ type: 'init', sessionId: 'native-codec' })
    await iterator.next()
    await iterator.return?.()

    const blob = await adapter.sessionCodec.serialize(run)
    expect(JSON.parse(blob)).toMatchObject({ sessionKey: SK, sessionId: 'native-codec' })
    const restored = await adapter.sessionCodec.restore(blob)
    expect(restored).toMatchObject({
      adapterId: 'clawboo-native',
      sessionKey: SK,
      runId: 'native-codec',
    })
  })

  it('abort() / setModel() / writeContext() delegate to the run driver', async () => {
    const driver = new FakeNativeDriver()
    const adapter = new NativeAdapter(() => driver)
    const run = await adapter.start({}, { agentId: 'native-1', sessionKey: SK, message: 'go' })
    await adapter.setModel(run, 'gpt-4o-mini')
    await adapter.writeContext(run, 'NOTES.md', 'remember')
    await adapter.abort(run)
    expect(driver.calls.find((c) => c.method === 'setModel')?.params).toMatchObject({
      model: 'gpt-4o-mini',
    })
    expect(driver.calls.find((c) => c.method === 'writeContext')?.params).toMatchObject({
      key: 'NOTES.md',
      value: 'remember',
    })
    expect(driver.calls.some((c) => c.method === 'abort')).toBe(true)
  })
})
