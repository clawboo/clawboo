import { describe, expect, it } from 'vitest'

import { resolveRuntimeIntegration } from '@clawboo/executor'
import { runAdapterContract, type AdapterTestHarness } from '@clawboo/executor/contract'

import { CodexAdapter } from '../adapter'
import { mapCodexEvent } from '../mapCodexEvent'
import { FakeCodexDriver } from '../testing/fakeCodexDriver'
import type { CodexNativeEvent } from '../types'

const SK = 'agent:codex-1:main'

// ─── Shared contract suite ───────────────────────────────────────────────────

function makeCodexHarness(): AdapterTestHarness {
  let driver = new FakeCodexDriver()
  return {
    label: 'codex',
    makeAdapter() {
      driver = new FakeCodexDriver()
      return new CodexAdapter(() => driver)
    },
    start(adapter) {
      return adapter.start({}, { agentId: 'codex-1', sessionKey: SK, message: 'hi' })
    },
    emit(frame) {
      driver.emit(frame as CodexNativeEvent)
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

runAdapterContract(makeCodexHarness())

// ─── Codex-specific behavior ─────────────────────────────────────────────────

describe('CodexAdapter specifics', () => {
  it("capabilities() declares a throwaway per-run home (today's reality; no native preservation)", () => {
    const caps = new CodexAdapter(() => new FakeCodexDriver()).capabilities()
    expect(caps).toMatchObject({
      runtimeClass: 'wrapped-oneshot',
      nativeHome: { scope: 'per-run', persist: false },
      nativeSkills: 'none',
      nativeMemory: 'none',
      nativeScheduler: false,
    })
    expect(resolveRuntimeIntegration(caps).home).toEqual({ kind: 'ephemeral' })
  })

  it('events() late-binds runId from the thread id', async () => {
    const driver = new FakeCodexDriver()
    const adapter = new CodexAdapter(() => driver)
    const run = await adapter.start({}, { agentId: 'codex-1', sessionKey: SK, message: 'go' })
    const iterator = adapter.events(run)[Symbol.asyncIterator]()
    driver.emit({ type: 'thread', threadId: 'thread-abc', model: 'gpt-5-codex' })
    const first = await iterator.next()
    expect(run.runId).toBe('thread-abc')
    expect(first.value).toMatchObject({ kind: 'status', phase: 'init' })
    await iterator.return?.()
  })

  it('whole-block text is mapped to a (synthesized) text-delta', async () => {
    const driver = new FakeCodexDriver()
    const adapter = new CodexAdapter(() => driver)
    const run = await adapter.start({}, { agentId: 'codex-1', sessionKey: SK, message: 'go' })
    const iterator = adapter.events(run)[Symbol.asyncIterator]()
    driver.emit({ type: 'text', text: 'a whole agent_message block' })
    const first = await iterator.next()
    expect(first.value).toMatchObject({ kind: 'text-delta', text: 'a whole agent_message block' })
    await iterator.return?.()
  })
})

// ─── mapCodexEvent (pure) — the cost asymmetry ───────────────────────────────

describe('mapCodexEvent', () => {
  const ctx = { runId: 'thread-1', sessionId: SK }
  const seqGen = () => {
    let s = 0
    return () => (s += 1)
  }

  it('emits cost with costUsd:null + estimated:true (Codex reports no USD)', () => {
    const evs = mapCodexEvent(
      {
        type: 'result',
        ok: true,
        summary: 'done',
        usage: { inputTokens: 200, outputTokens: 80 },
        model: 'gpt-5-codex',
      },
      ctx,
      seqGen(),
      () => 1,
    )
    const cost = evs.find((e) => e.kind === 'cost')
    expect(cost).toMatchObject({ kind: 'cost', costUsd: null, estimated: true })
    expect((cost as { usage: { inputTokens: number } }).usage.inputTokens).toBe(200)
    const done = evs[evs.length - 1]
    expect(done).toMatchObject({ kind: 'done', reason: 'success', costUsd: null })
  })

  it('maps a reasoning text event to a reasoning-channel delta', () => {
    const evs = mapCodexEvent(
      { type: 'text', text: 'planning', channel: 'reasoning' },
      ctx,
      seqGen(),
      () => 1,
    )
    expect(evs[0]).toMatchObject({ kind: 'text-delta', channel: 'reasoning', text: 'planning' })
  })

  it('maps an aborted result to done:aborted, falling back to accumulated text', () => {
    const evs = mapCodexEvent(
      { type: 'result', ok: false, aborted: true, summary: '' },
      ctx,
      seqGen(),
      () => 1,
      'partial',
    )
    expect(evs[evs.length - 1]).toMatchObject({
      kind: 'done',
      reason: 'aborted',
      summary: 'partial',
    })
  })
})
