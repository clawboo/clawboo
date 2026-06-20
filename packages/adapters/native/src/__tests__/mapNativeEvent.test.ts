import { describe, expect, it } from 'vitest'

import { mapNativeEvent, nativeFrameId } from '../mapNativeEvent'

const ctx = { runId: 'native-1', sessionId: 'agent:n1:main' }
const seqGen = () => {
  let s = 0
  return () => (s += 1)
}

describe('mapNativeEvent', () => {
  it('maps init to status:init with the model', () => {
    const evs = mapNativeEvent(
      { type: 'init', sessionId: 'native-x', model: 'claude-haiku-4-5' },
      ctx,
      seqGen(),
      () => 1,
    )
    expect(evs[0]).toMatchObject({ kind: 'status', phase: 'init', model: 'claude-haiku-4-5' })
  })

  it('maps text on the assistant and reasoning channels', () => {
    expect(mapNativeEvent({ type: 'text', text: 'hi' }, ctx, seqGen(), () => 1)[0]).toMatchObject({
      kind: 'text-delta',
      channel: 'assistant',
      text: 'hi',
    })
    expect(
      mapNativeEvent(
        { type: 'text', text: 'hmm', channel: 'reasoning' },
        ctx,
        seqGen(),
        () => 1,
      )[0],
    ).toMatchObject({ kind: 'text-delta', channel: 'reasoning' })
  })

  it('passes tool-call / tool-result through with ids', () => {
    expect(
      mapNativeEvent(
        { type: 'tool-call', id: 'tc-1', name: 'write_file', input: { path: 'a' } },
        ctx,
        seqGen(),
        () => 1,
      )[0],
    ).toMatchObject({ kind: 'tool-call', toolCallId: 'tc-1', name: 'write_file', partial: false })
    expect(
      mapNativeEvent(
        { type: 'tool-result', id: 'tc-1', name: 'write_file', output: 'ok', isError: false },
        ctx,
        seqGen(),
        () => 1,
      )[0],
    ).toMatchObject({ kind: 'tool-result', toolCallId: 'tc-1', output: 'ok', isError: false })
  })

  it('maps a turn to a delta cost event (live mid-run budget signal)', () => {
    const evs = mapNativeEvent(
      {
        type: 'turn',
        usage: { inputTokens: 120, outputTokens: 45 },
        costUsd: 0.0011,
        model: 'claude-haiku-4-5',
      },
      ctx,
      seqGen(),
      () => 1,
    )
    expect(evs).toHaveLength(1)
    expect(evs[0]).toMatchObject({
      kind: 'cost',
      costUsd: 0.0011,
      usage: { inputTokens: 120, outputTokens: 45 },
      model: 'claude-haiku-4-5',
    })
    expect((evs[0] as { estimated?: boolean }).estimated).toBeUndefined()
  })

  it('flags an unpriced turn as estimated with a null costUsd', () => {
    const evs = mapNativeEvent(
      {
        type: 'turn',
        usage: { inputTokens: 10, outputTokens: 5 },
        costUsd: null,
        estimated: true,
        model: 'mystery-model',
      },
      ctx,
      seqGen(),
      () => 1,
    )
    expect(evs[0]).toMatchObject({ kind: 'cost', costUsd: null, estimated: true })
  })

  it('maps a clean result to done:success with cumulative cost + final-turn usage', () => {
    const evs = mapNativeEvent(
      {
        type: 'result',
        ok: true,
        summary: 'wrote the file',
        sessionId: 'native-x',
        usage: { inputTokens: 900, outputTokens: 210 },
        costUsd: 0.004,
      },
      ctx,
      seqGen(),
      () => 1,
    )
    expect(evs).toHaveLength(1)
    expect(evs[0]).toMatchObject({
      kind: 'done',
      reason: 'success',
      summary: 'wrote the file',
      usage: { inputTokens: 900, outputTokens: 210 },
      costUsd: 0.004,
    })
  })

  it('maps maxTurns to done:max_turns (clean out-of-room, not an error)', () => {
    const evs = mapNativeEvent(
      { type: 'result', ok: false, maxTurns: true, summary: 'partial' },
      ctx,
      seqGen(),
      () => 1,
    )
    expect(evs.some((e) => e.kind === 'error')).toBe(false)
    expect(evs[evs.length - 1]).toMatchObject({
      kind: 'done',
      reason: 'max_turns',
      summary: 'partial',
    })
  })

  it('maps aborted to done:aborted', () => {
    const evs = mapNativeEvent(
      { type: 'result', ok: false, aborted: true, summary: '' },
      ctx,
      seqGen(),
      () => 1,
      'so far',
    )
    expect(evs[0]).toMatchObject({ kind: 'done', reason: 'aborted', summary: 'so far' })
  })

  it('maps an error result to a typed error code + done:error', () => {
    const evs = mapNativeEvent(
      {
        type: 'result',
        ok: false,
        summary: '',
        errorMessage: 'invalid api key',
        errorCode: 'auth',
      },
      ctx,
      seqGen(),
      () => 1,
    )
    expect(evs[0]).toMatchObject({
      kind: 'error',
      code: 'auth',
      message: 'invalid api key',
      fatal: true,
    })
    expect(evs[1]).toMatchObject({ kind: 'done', reason: 'error' })
  })

  it('stamps a monotonic seq across emitted events', () => {
    const next = seqGen()
    const a = mapNativeEvent({ type: 'text', text: 'a' }, ctx, next, () => 1)
    const b = mapNativeEvent(
      { type: 'result', ok: false, summary: '', errorMessage: 'x' },
      ctx,
      next,
      () => 1,
    )
    const seqs = [...a, ...b].map((e) => e.seq)
    expect(seqs).toEqual([...seqs].sort((x, y) => x - y))
    expect(new Set(seqs).size).toBe(seqs.length)
  })

  it('nativeFrameId recovers the session id from init and result frames only', () => {
    expect(nativeFrameId({ type: 'init', sessionId: 's1' })).toBe('s1')
    expect(nativeFrameId({ type: 'result', ok: true, summary: '', sessionId: 's2' })).toBe('s2')
    expect(nativeFrameId({ type: 'text', text: 'x' })).toBeUndefined()
  })
})
