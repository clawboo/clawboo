import { describe, expect, it } from 'vitest'

import type { EventFrame } from '@clawboo/gateway-client'
import { resolveRuntimeIntegration } from '@clawboo/executor'
import { runAdapterContract, type AdapterTestHarness } from '@clawboo/executor/contract'

import { OpenClawAdapter } from '../adapter'
import { mapFrameToRuntimeEvents } from '../mapFrame'
import { FakeGatewayClient } from '../testing/fakeGateway'

const SK = 'agent:agent-1:main'
const RUN = 'run-1'

const chatFrame = (state: string, extra: Record<string, unknown> = {}): EventFrame => ({
  type: 'event',
  event: 'chat',
  payload: { runId: RUN, sessionKey: SK, state, ...extra },
})

// ─── Shared contract suite ───────────────────────────────────────────────────

function makeOpenClawHarness(): AdapterTestHarness {
  let fake = new FakeGatewayClient()
  return {
    label: 'openclaw',
    makeAdapter() {
      fake = new FakeGatewayClient()
      return new OpenClawAdapter(fake)
    },
    start(adapter) {
      return adapter.start({}, { agentId: 'agent-1', sessionKey: SK, message: 'hi' })
    },
    emit(frame) {
      fake.emit(frame as EventFrame)
    },
    frames: {
      delta: (text) => chatFrame('delta', { message: { role: 'assistant', content: text } }),
      toolCall: (name, input) =>
        chatFrame('delta', {
          message: {
            role: 'assistant',
            content: [{ type: 'toolCall', id: 'tc-1', name, arguments: input }],
          },
        }),
      final: (summary) => chatFrame('final', { message: { role: 'assistant', content: summary } }),
      aborted: () => chatFrame('aborted'),
      error: (message) => chatFrame('error', { errorMessage: message }),
    },
    recordedCalls() {
      return fake.calls
    },
  }
}

runAdapterContract(makeOpenClawHarness())

// ─── OpenClaw-specific behavior ──────────────────────────────────────────────

describe('OpenClawAdapter specifics', () => {
  it('capabilities() declares the connected-substrate seam (live Gateway, never a host home)', () => {
    const caps = new OpenClawAdapter(new FakeGatewayClient()).capabilities()
    expect(caps).toMatchObject({
      runtimeClass: 'connected-substrate',
      nativeChannels: 'gateway',
      nativeScheduler: true,
    })
    expect(caps.nativeHome).toBeUndefined()
  })

  it('integration plan resolves to a connected home with gateway routing', () => {
    const caps = new OpenClawAdapter(new FakeGatewayClient()).capabilities()
    expect(resolveRuntimeIntegration(caps)).toEqual({
      home: { kind: 'connected' },
      preserveSkills: false,
      preserveMemory: false,
      useGatewayChannels: true,
      coRunScheduler: false,
    })
  })

  it('start() issues chat.send with deliver:false and the message', async () => {
    const fake = new FakeGatewayClient()
    const adapter = new OpenClawAdapter(fake)
    await adapter.start({}, { agentId: 'agent-1', sessionKey: SK, message: 'do the thing' })
    const send = fake.calls.find((c) => c.method === 'chat.send')
    expect(send).toBeTruthy()
    expect(send!.params).toMatchObject({ sessionKey: SK, message: 'do the thing', deliver: false })
  })

  it('start() prepends context when provided', async () => {
    const fake = new FakeGatewayClient()
    const adapter = new OpenClawAdapter(fake)
    await adapter.start(
      {},
      { agentId: 'agent-1', sessionKey: SK, message: 'task', context: 'CONTEXT' },
    )
    const send = fake.calls.find((c) => c.method === 'chat.send')
    expect((send!.params as { message: string }).message).toBe('CONTEXT\n\ntask')
  })

  it('abort() uses chat.abort + sessions.abort backstop when runId is known', async () => {
    const fake = new FakeGatewayClient()
    const adapter = new OpenClawAdapter(fake)
    const run = await adapter.start({}, { agentId: 'agent-1', sessionKey: SK, message: 'x' })
    run.runId = RUN
    await adapter.abort(run)
    expect(fake.calls.some((c) => c.method === 'chat.abort')).toBe(true)
    expect(fake.calls.some((c) => c.method === 'sessions.abort')).toBe(true)
  })

  it('abort() skips chat.abort when runId is unknown (sessions.abort backstop only)', async () => {
    const fake = new FakeGatewayClient()
    const adapter = new OpenClawAdapter(fake)
    const run = await adapter.start({}, { agentId: 'agent-1', sessionKey: SK, message: 'x' })
    await adapter.abort(run) // runId still null
    expect(fake.calls.some((c) => c.method === 'chat.abort')).toBe(false)
    expect(fake.calls.some((c) => c.method === 'sessions.abort')).toBe(true)
  })

  it('writeContext() resolves the agentId from the sessionKey', async () => {
    const fake = new FakeGatewayClient()
    const adapter = new OpenClawAdapter(fake)
    const run = await adapter.start({}, { agentId: 'agent-1', sessionKey: SK, message: 'x' })
    await adapter.writeContext(run, 'NOTES.md', 'remember this')
    const set = fake.calls.find((c) => c.method === 'agents.files.set')
    expect(set!.params).toMatchObject({
      agentId: 'agent-1',
      name: 'NOTES.md',
      content: 'remember this',
    })
  })

  it('events() ignores frames for a different sessionKey', async () => {
    const fake = new FakeGatewayClient()
    const adapter = new OpenClawAdapter(fake)
    const run = await adapter.start({}, { agentId: 'agent-1', sessionKey: SK, message: 'x' })
    const iterator = adapter.events(run)[Symbol.asyncIterator]()
    fake.emit({
      type: 'event',
      event: 'chat',
      payload: {
        runId: 'other',
        sessionKey: 'agent:zzz:main',
        state: 'delta',
        message: { role: 'assistant', content: 'nope' },
      },
    })
    fake.emit(chatFrame('delta', { message: { role: 'assistant', content: 'yes' } }))
    const first = await iterator.next()
    expect(first.value).toMatchObject({ kind: 'text-delta', text: 'yes' })
    await iterator.return?.()
  })
})

// ─── mapFrameToRuntimeEvents (pure) ──────────────────────────────────────────

describe('mapFrameToRuntimeEvents', () => {
  const ctx = { runId: RUN, sessionId: SK }
  const seqGen = () => {
    let s = 0
    return () => (s += 1)
  }

  it('maps a structured tool call (e.g. sessions_send) to a tool-call event', () => {
    const frame = chatFrame('delta', {
      message: {
        role: 'assistant',
        content: [
          {
            type: 'toolCall',
            id: 'tc-9',
            name: 'sessions_send',
            arguments: { targetAgentId: 'a2', message: 'go' },
          },
        ],
      },
    })
    const evs = mapFrameToRuntimeEvents(frame, ctx, seqGen(), () => 1)
    const call = evs.find((e) => e.kind === 'tool-call')
    expect(call).toMatchObject({ kind: 'tool-call', name: 'sessions_send', toolCallId: 'tc-9' })
  })

  it('maps chat final to done:success with the summary', () => {
    const evs = mapFrameToRuntimeEvents(
      chatFrame('final', { message: { role: 'assistant', content: 'all set' } }),
      ctx,
      seqGen(),
      () => 1,
    )
    expect(evs[evs.length - 1]).toMatchObject({
      kind: 'done',
      reason: 'success',
      summary: 'all set',
    })
  })

  it('maps chat aborted to done:aborted, falling back to accumulated text', () => {
    const evs = mapFrameToRuntimeEvents(
      chatFrame('aborted'),
      ctx,
      seqGen(),
      () => 1,
      'partial output',
    )
    expect(evs[evs.length - 1]).toMatchObject({
      kind: 'done',
      reason: 'aborted',
      summary: 'partial output',
    })
  })

  it('maps chat error to an error event followed by done:error', () => {
    const evs = mapFrameToRuntimeEvents(
      chatFrame('error', { errorMessage: 'boom' }),
      ctx,
      seqGen(),
      () => 1,
    )
    expect(evs.some((e) => e.kind === 'error')).toBe(true)
    expect(evs[evs.length - 1]).toMatchObject({ kind: 'done', reason: 'error' })
  })

  it('maps a reasoning agent stream to a reasoning-channel text-delta', () => {
    const frame: EventFrame = {
      type: 'event',
      event: 'agent',
      payload: { runId: RUN, sessionKey: SK, stream: 'reasoning', data: { text: 'thinking...' } },
    }
    const evs = mapFrameToRuntimeEvents(frame, ctx, seqGen(), () => 1)
    expect(evs[0]).toMatchObject({ kind: 'text-delta', channel: 'reasoning', text: 'thinking...' })
  })
})

describe('OpenClawAdapter chat.send verification', () => {
  it('fails fast when chat.send is acknowledged but no run will stream', async () => {
    class NoRunGateway extends FakeGatewayClient {
      override async call<T = unknown>(method: string, params?: unknown): Promise<T> {
        if (method === 'chat.send') return { accepted: false } as T // ack, but no run
        return super.call<T>(method, params)
      }
    }
    const adapter = new OpenClawAdapter(new NoRunGateway())
    await expect(
      adapter.start({}, { agentId: 'a', sessionKey: SK, message: 'hi' }),
    ).rejects.toThrow(/did not start a run/)
  })

  it('does NOT throw on a normal accept (no negative signal → runId binds via events)', async () => {
    const adapter = new OpenClawAdapter(new FakeGatewayClient()) // call() resolves undefined
    const run = await adapter.start({}, { agentId: 'a', sessionKey: SK, message: 'hi' })
    expect(run.sessionKey).toBe(SK)
    expect(run.runId).toBeNull()
  })
})
