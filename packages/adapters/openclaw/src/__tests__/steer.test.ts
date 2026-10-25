// Steering an OpenClaw run is a `chat.send` with `queueMode: 'steer'` into the
// session's active run. Two Gateway behaviors (verified against 2026.9.2) are what
// these tests pin: an accepted steer is closed out by a `chat` FINAL carrying the
// steer's own runId, which must never end the run it was steered into; and a steer
// the run never read would become a follow-up turn nobody watches, so it is
// cancelled when the run ends.

import { describe, expect, it } from 'vitest'

import type { EventFrame } from '@clawboo/gateway-client'
import type { RuntimeEvent } from '@clawboo/executor'

import { OpenClawAdapter } from '../adapter'
import { FakeGatewayClient } from '../testing/fakeGateway'

const SK = 'agent:agent-1:team:t1'
const RUN = 'run-1'

const chatFrame = (
  runId: string,
  state: string,
  extra: Record<string, unknown> = {},
): EventFrame => ({
  type: 'event',
  event: 'chat',
  payload: { runId, sessionKey: SK, state, ...extra },
})

const delta = (text: string): EventFrame =>
  chatFrame(RUN, 'delta', { message: { role: 'assistant', content: text } })

async function startedRun(fake = new FakeGatewayClient()) {
  const adapter = new OpenClawAdapter(fake)
  const run = await adapter.start({}, { agentId: 'agent-1', sessionKey: SK, message: 'go' })
  const events = adapter.events(run)[Symbol.asyncIterator]()
  return { fake, adapter, run, events }
}

/** The idempotencyKey of the most recent steer sent through the fake. */
function lastSteerKey(fake: FakeGatewayClient): string {
  const steers = fake.calls.filter(
    (c) => c.method === 'chat.send' && (c.params as { queueMode?: string }).queueMode === 'steer',
  )
  return (steers.at(-1)!.params as { idempotencyKey: string }).idempotencyKey
}

async function nextEvent(events: AsyncIterator<RuntimeEvent>): Promise<RuntimeEvent> {
  const r = await events.next()
  return r.value as RuntimeEvent
}

describe('OpenClawAdapter.steer', () => {
  it('declares live steering', () => {
    expect(new OpenClawAdapter(new FakeGatewayClient()).capabilities().steering).toBe('live')
  })

  it('sends a steer-mode chat.send into the session and resolves once the Gateway commits it', async () => {
    const { fake, adapter, run } = await startedRun()
    const pending = adapter.steer(run, 'Lead with the pricing change.')
    const send = fake.calls.find(
      (c) => c.method === 'chat.send' && (c.params as { queueMode?: string }).queueMode === 'steer',
    )
    expect(send?.params).toMatchObject({
      sessionKey: SK,
      message: 'Lead with the pricing change.',
      deliver: false,
      queueMode: 'steer',
    })
    const key = lastSteerKey(fake)
    expect(key).not.toBe('')
    fake.emit(chatFrame(key, 'final'))
    await expect(pending).resolves.toEqual({ delivered: true, mode: 'live' })
  })

  it('never lets the steer’s own final end the run it was steered into', async () => {
    const { fake, adapter, run, events } = await startedRun()
    fake.emit(delta('Working on it'))
    const pending = adapter.steer(run, 'Keep it short.')
    fake.emit(chatFrame(lastSteerKey(fake), 'final'))
    await pending
    fake.emit(chatFrame(RUN, 'final', { message: { role: 'assistant', content: 'Done.' } }))

    const seen: RuntimeEvent[] = []
    for (;;) {
      const ev = await nextEvent(events)
      seen.push(ev)
      if (ev.kind === 'done') break
    }
    // Exactly one terminal, and it is the run's own.
    expect(seen.filter((e) => e.kind === 'done')).toHaveLength(1)
    expect(seen.at(-1)).toMatchObject({ kind: 'done', reason: 'success', summary: 'Done.' })
    // The run id was never rebound to the steer's.
    expect(run.runId).toBe(RUN)
  })

  it('cancels a steer the run never read, so it cannot start an unwatched turn', async () => {
    const { fake, adapter, run } = await startedRun()
    const pending = adapter.steer(run, 'Also add a summary.')
    const key = lastSteerKey(fake)
    fake.emit(chatFrame(RUN, 'final', { message: { role: 'assistant', content: 'Done.' } }))
    await expect(pending).resolves.toEqual({ delivered: false, reason: 'run-ended' })
    expect(fake.calls).toContainEqual({
      method: 'chat.abort',
      params: { sessionKey: SK, runId: key },
    })
  })

  it('cancels unread steers when the consumer stops observing the run', async () => {
    const { fake, adapter, run, events } = await startedRun()
    const pending = adapter.steer(run, 'x')
    const key = lastSteerKey(fake)
    await events.return?.()
    await expect(pending).resolves.toEqual({ delivered: false, reason: 'run-ended' })
    expect(fake.calls).toContainEqual({
      method: 'chat.abort',
      params: { sessionKey: SK, runId: key },
    })
  })

  it('does not send anything into a run that has already ended', async () => {
    const { fake, adapter, run, events } = await startedRun()
    fake.emit(chatFrame(RUN, 'final', { message: { role: 'assistant', content: 'Done.' } }))
    await nextEvent(events)
    const before = fake.calls.length
    await expect(adapter.steer(run, 'too late')).resolves.toEqual({
      delivered: false,
      reason: 'run-ended',
    })
    expect(fake.calls).toHaveLength(before)
  })

  it('reports a Gateway refusal as rejected', async () => {
    class RefusingGateway extends FakeGatewayClient {
      override async call<T = unknown>(method: string, params?: unknown): Promise<T> {
        if (method === 'chat.send' && (params as { queueMode?: string }).queueMode === 'steer')
          throw new Error('session is busy')
        return super.call<T>(method, params)
      }
    }
    const { adapter, run } = await startedRun(new RefusingGateway())
    await expect(adapter.steer(run, 'x')).resolves.toEqual({
      delivered: false,
      reason: 'rejected',
      detail: 'session is busy',
    })
  })

  it('reports a steer the Gateway errored as rejected, with its reason', async () => {
    const { fake, adapter, run } = await startedRun()
    const pending = adapter.steer(run, 'x')
    fake.emit(
      chatFrame(lastSteerKey(fake), 'error', { errorMessage: 'question response indeterminate' }),
    )
    await expect(pending).resolves.toEqual({
      delivered: false,
      reason: 'rejected',
      detail: 'question response indeterminate',
    })
  })
})
