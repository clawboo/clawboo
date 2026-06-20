import { describe, expect, it } from 'vitest'

import { resolveRuntimeIntegration } from '@clawboo/executor'
import { runAdapterContract, type AdapterTestHarness } from '@clawboo/executor/contract'

import { HermesAdapter } from '../adapter'
import { mapHermesEvent } from '../mapHermesEvent'
import { FakeHermesDriver } from '../testing/fakeHermesDriver'
import type { HermesNativeEvent } from '../types'

const SK = 'agent:hermes-1:main'

// ─── Shared contract suite ───────────────────────────────────────────────────

function makeHermesHarness(): AdapterTestHarness {
  let driver = new FakeHermesDriver()
  return {
    label: 'hermes',
    makeAdapter() {
      driver = new FakeHermesDriver()
      return new HermesAdapter(() => driver)
    },
    start(adapter) {
      return adapter.start({}, { agentId: 'hermes-1', sessionKey: SK, message: 'hi' })
    },
    emit(frame) {
      driver.emit(frame as HermesNativeEvent)
    },
    frames: {
      delta: (text) => ({ type: 'message', text }),
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

runAdapterContract(makeHermesHarness())

// ─── Hermes-specific behavior ────────────────────────────────────────────────

describe('HermesAdapter specifics', () => {
  it('capabilities() reports streaming:false (non-streaming runtime) but mcp+worktrees+resume true', () => {
    const caps = new HermesAdapter(() => new FakeHermesDriver()).capabilities()
    expect(caps).toMatchObject({ streaming: false, mcp: true, worktrees: true, resume: true })
  })

  it('capabilities() declares the native-preservation seam: one-shot dispatch is NOT amnesiac', () => {
    const caps = new HermesAdapter(() => new FakeHermesDriver()).capabilities()
    expect(caps).toMatchObject({
      runtimeClass: 'wrapped-oneshot',
      nativeHome: { scope: 'per-identity', persist: true },
      nativeSkills: 'preserve',
      nativeMemory: 'preserve',
      nativeChannels: 'none',
      nativeScheduler: true,
    })
  })

  it('integration plan resolves to a persistent per-identity home with preservation', () => {
    const caps = new HermesAdapter(() => new FakeHermesDriver()).capabilities()
    expect(resolveRuntimeIntegration(caps)).toEqual({
      home: { kind: 'persistent', scope: 'per-identity' },
      preserveSkills: true,
      preserveMemory: true,
      useGatewayChannels: false,
      coRunScheduler: false,
    })
  })

  it('sessionCodec round-trips the captured native session id', async () => {
    const driver = new FakeHermesDriver()
    const adapter = new HermesAdapter(() => driver)
    const run = await adapter.start({}, { agentId: 'hermes-1', sessionKey: SK, message: 'go' })
    const iterator = adapter.events(run)[Symbol.asyncIterator]()
    driver.emit({ type: 'session', sessionId: 'hsess-codec' })
    await iterator.next()
    await iterator.return?.()

    const blob = await adapter.sessionCodec.serialize(run)
    expect(JSON.parse(blob)).toMatchObject({ sessionKey: SK, sessionId: 'hsess-codec' })
    const restored = await adapter.sessionCodec.restore(blob)
    expect(restored).toMatchObject({ adapterId: 'hermes', sessionKey: SK, runId: 'hsess-codec' })
  })

  it('sessionCodec also captures the id from a terminal result frame', async () => {
    const driver = new FakeHermesDriver()
    const adapter = new HermesAdapter(() => driver)
    const run = await adapter.start({}, { agentId: 'hermes-1', sessionKey: SK, message: 'go' })
    const iterator = adapter.events(run)[Symbol.asyncIterator]()
    driver.emit({ type: 'result', ok: true, summary: 'done', sessionId: 'hsess-late' })
    await iterator.next()
    await iterator.return?.()

    const blob = await adapter.sessionCodec.serialize(run)
    expect(JSON.parse(blob)).toMatchObject({ sessionId: 'hsess-late' })
  })

  it('events() late-binds runId from the Hermes session id', async () => {
    const driver = new FakeHermesDriver()
    const adapter = new HermesAdapter(() => driver)
    const run = await adapter.start({}, { agentId: 'hermes-1', sessionKey: SK, message: 'go' })
    const iterator = adapter.events(run)[Symbol.asyncIterator]()
    driver.emit({ type: 'session', sessionId: 'hsess-7' })
    const first = await iterator.next()
    expect(run.runId).toBe('hsess-7')
    expect(first.value).toMatchObject({ kind: 'status', phase: 'init' })
    await iterator.return?.()
  })
})

// ─── mapHermesEvent (pure) ───────────────────────────────────────────────────

describe('mapHermesEvent', () => {
  const ctx = { runId: 'hsess-1', sessionId: SK }
  const seqGen = () => {
    let s = 0
    return () => (s += 1)
  }

  it('emits cost as estimated (no reliable headless USD)', () => {
    const evs = mapHermesEvent(
      { type: 'result', ok: true, summary: 'done', usage: { inputTokens: 50, outputTokens: 20 } },
      ctx,
      seqGen(),
      () => 1,
    )
    const cost = evs.find((e) => e.kind === 'cost')
    expect(cost).toMatchObject({ kind: 'cost', costUsd: null, estimated: true })
    expect(evs[evs.length - 1]).toMatchObject({ kind: 'done', reason: 'success' })
  })

  it('maps a block message to a single text-delta', () => {
    const evs = mapHermesEvent({ type: 'message', text: 'a block' }, ctx, seqGen(), () => 1)
    expect(evs[0]).toMatchObject({ kind: 'text-delta', text: 'a block', channel: 'assistant' })
  })
})
