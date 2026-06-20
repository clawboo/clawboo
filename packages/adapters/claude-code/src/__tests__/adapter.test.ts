import { describe, expect, it } from 'vitest'

import { resolveRuntimeIntegration } from '@clawboo/executor'
import { runAdapterContract, type AdapterTestHarness } from '@clawboo/executor/contract'

import { ClaudeCodeAdapter } from '../adapter'
import { mapClaudeEvent } from '../mapClaudeEvent'
import { FakeClaudeDriver } from '../testing/fakeClaudeDriver'
import type { ClaudeNativeEvent } from '../types'

const SK = 'agent:claude-1:main'

// ─── Shared contract suite ───────────────────────────────────────────────────

function makeClaudeHarness(): AdapterTestHarness {
  let driver = new FakeClaudeDriver()
  return {
    label: 'claude-code',
    makeAdapter() {
      driver = new FakeClaudeDriver()
      return new ClaudeCodeAdapter(() => driver)
    },
    start(adapter) {
      return adapter.start({}, { agentId: 'claude-1', sessionKey: SK, message: 'hi' })
    },
    emit(frame) {
      driver.emit(frame as ClaudeNativeEvent)
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

runAdapterContract(makeClaudeHarness())

// ─── Claude Code-specific behavior ───────────────────────────────────────────

describe('ClaudeCodeAdapter specifics', () => {
  it('capabilities() advertises mcp + worktrees + resume (unlike OpenClaw)', () => {
    const caps = new ClaudeCodeAdapter(() => new FakeClaudeDriver()).capabilities()
    expect(caps).toMatchObject({ mcp: true, worktrees: true, resume: true, streaming: true })
  })

  it('start() boots the driver and returns an unbound runId', async () => {
    const driver = new FakeClaudeDriver()
    const adapter = new ClaudeCodeAdapter(() => driver)
    const run = await adapter.start({}, { agentId: 'claude-1', sessionKey: SK, message: 'go' })
    expect(driver.calls.some((c) => c.method === 'start')).toBe(true)
    expect(run).toMatchObject({ adapterId: 'claude-code', sessionKey: SK, runId: null })
  })

  it('events() late-binds runId from the init session id', async () => {
    const driver = new FakeClaudeDriver()
    const adapter = new ClaudeCodeAdapter(() => driver)
    const run = await adapter.start({}, { agentId: 'claude-1', sessionKey: SK, message: 'go' })
    const iterator = adapter.events(run)[Symbol.asyncIterator]()
    driver.emit({ type: 'init', sessionId: 'sess-xyz', model: 'sonnet' })
    const first = await iterator.next()
    expect(run.runId).toBe('sess-xyz')
    expect(first.value).toMatchObject({ kind: 'status', phase: 'init' })
    await iterator.return?.()
  })

  it('capabilities() reports a context window (drives the rotation watermark)', () => {
    const caps = new ClaudeCodeAdapter(() => new FakeClaudeDriver()).capabilities()
    expect(caps.contextWindowTokens).toBeGreaterThan(0)
  })

  it('capabilities() declares a stateless wrapped one-shot (no native preservation)', () => {
    const caps = new ClaudeCodeAdapter(() => new FakeClaudeDriver()).capabilities()
    expect(caps).toMatchObject({
      runtimeClass: 'wrapped-oneshot',
      nativeSkills: 'none',
      nativeMemory: 'none',
      nativeChannels: 'none',
      nativeScheduler: false,
    })
    expect(caps.nativeHome).toBeUndefined()
    expect(resolveRuntimeIntegration(caps).home).toEqual({ kind: 'ephemeral' })
  })

  it('sessionCodec round-trips the captured native session id', async () => {
    const driver = new FakeClaudeDriver()
    const adapter = new ClaudeCodeAdapter(() => driver)
    const run = await adapter.start({}, { agentId: 'claude-1', sessionKey: SK, message: 'go' })
    // Drain enough to capture the session id from the init frame.
    const iterator = adapter.events(run)[Symbol.asyncIterator]()
    driver.emit({ type: 'init', sessionId: 'sess-codec', model: 'sonnet' })
    await iterator.next()
    await iterator.return?.()

    const blob = await adapter.sessionCodec!.serialize(run)
    expect(JSON.parse(blob)).toMatchObject({ sessionKey: SK, sessionId: 'sess-codec' })
    const restored = await adapter.sessionCodec!.restore(blob)
    expect(restored).toMatchObject({
      adapterId: 'claude-code',
      sessionKey: SK,
      runId: 'sess-codec',
    })
  })

  it('abort() / setModel() / writeContext() delegate to the run driver', async () => {
    const driver = new FakeClaudeDriver()
    const adapter = new ClaudeCodeAdapter(() => driver)
    const run = await adapter.start({}, { agentId: 'claude-1', sessionKey: SK, message: 'go' })
    await adapter.setModel(run, 'opus')
    await adapter.writeContext(run, 'NOTES.md', 'remember')
    await adapter.abort(run)
    expect(driver.calls.find((c) => c.method === 'setModel')?.params).toMatchObject({
      model: 'opus',
    })
    expect(driver.calls.find((c) => c.method === 'writeContext')?.params).toMatchObject({
      key: 'NOTES.md',
      value: 'remember',
    })
    expect(driver.calls.some((c) => c.method === 'abort')).toBe(true)
  })
})

// ─── mapClaudeEvent (pure) ───────────────────────────────────────────────────

describe('mapClaudeEvent', () => {
  const ctx = { runId: 'sess-1', sessionId: SK }
  const seqGen = () => {
    let s = 0
    return () => (s += 1)
  }

  it('maps a result with a REAL total_cost_usd to a concrete (non-estimated) cost event', () => {
    const evs = mapClaudeEvent(
      {
        type: 'result',
        ok: true,
        summary: 'done',
        costUsd: 0.0123,
        usage: { inputTokens: 100, outputTokens: 50 },
        model: 'sonnet',
      },
      ctx,
      seqGen(),
      () => 1,
    )
    const cost = evs.find((e) => e.kind === 'cost')
    expect(cost).toMatchObject({ kind: 'cost', costUsd: 0.0123, model: 'sonnet' })
    expect((cost as { estimated?: boolean }).estimated).toBeUndefined()
    expect(evs[evs.length - 1]).toMatchObject({ kind: 'done', reason: 'success', summary: 'done' })
  })

  it('maps a reasoning text event to a reasoning-channel delta', () => {
    const evs = mapClaudeEvent(
      { type: 'text', text: 'thinking', channel: 'reasoning' },
      ctx,
      seqGen(),
      () => 1,
    )
    expect(evs[0]).toMatchObject({ kind: 'text-delta', channel: 'reasoning', text: 'thinking' })
  })

  it('maps a tool-call native event to a tool-call RuntimeEvent', () => {
    const evs = mapClaudeEvent(
      { type: 'tool-call', id: 'tc-9', name: 'Bash', input: { cmd: 'ls' } },
      ctx,
      seqGen(),
      () => 1,
    )
    expect(evs[0]).toMatchObject({
      kind: 'tool-call',
      name: 'Bash',
      toolCallId: 'tc-9',
      partial: false,
    })
  })

  it('maps an error result to error + done:error', () => {
    const evs = mapClaudeEvent(
      { type: 'result', ok: false, summary: '', errorMessage: 'boom' },
      ctx,
      seqGen(),
      () => 1,
    )
    expect(evs.some((e) => e.kind === 'error')).toBe(true)
    expect(evs[evs.length - 1]).toMatchObject({ kind: 'done', reason: 'error' })
  })

  it('maps a max_turns result to done:max_turns (a clean "out of room", not an error)', () => {
    const evs = mapClaudeEvent(
      { type: 'result', ok: false, maxTurns: true, summary: 'partial' },
      ctx,
      seqGen(),
      () => 1,
    )
    expect(evs.some((e) => e.kind === 'error')).toBe(false) // NOT a failure
    expect(evs[evs.length - 1]).toMatchObject({
      kind: 'done',
      reason: 'max_turns',
      summary: 'partial',
    })
  })
})
