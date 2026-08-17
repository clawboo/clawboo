// The fault-injecting runtime's grammar and event stream.
//
// The directives exist to reproduce failures the coordination work actually hit,
// so each test names the seam it is for rather than just asserting a shape.

import { describe, expect, it, vi } from 'vitest'

import { MockAdapter, MOCK_RUNTIME_ID } from '../adapter'
import { parseDirectives, startDelayMs } from '../directives'

const drain = async (
  adapter: MockAdapter,
  message: string,
  opts: { stopAfter?: number } = {},
): Promise<Array<{ kind: string; [k: string]: unknown }>> => {
  const run = await adapter.start(
    { taskId: 't1', teamId: null },
    { agentId: 'a1', sessionKey: 'agent:a1:team:t1', message },
  )
  const seen: Array<{ kind: string; [k: string]: unknown }> = []
  for await (const ev of adapter.events(run)) {
    seen.push(ev as unknown as { kind: string })
    if (opts.stopAfter && seen.length >= opts.stopAfter) break
  }
  return seen
}

describe('directive grammar', () => {
  it('treats prose without a directive as an ordinary successful run', () => {
    expect(parseDirectives('please fix the parser')).toEqual([])
  })

  it('finds a directive embedded in prose, because a real task is prose', () => {
    expect(parseDirectives('do the thing\n!error boom\nthanks')).toEqual([
      { kind: 'error', message: 'boom' },
    ])
  })

  it('clamps a hostile delay and loop count rather than hanging the suite', () => {
    expect(parseDirectives('!silent 999999999')[0]).toEqual({ kind: 'silent', ms: 600_000 })
    expect(parseDirectives('!loop 1000')[0]).toEqual({ kind: 'loop', times: 50 })
    // Garbage falls back rather than producing NaN, which would compare false
    // against every bound and silently disable the guard it feeds.
    expect(parseDirectives('!silent abc')[0]).toEqual({ kind: 'silent', ms: 1_000 })
  })

  it('reads the start delay before any run exists', () => {
    expect(startDelayMs(parseDirectives('!slowstart 250'))).toBe(250)
    expect(startDelayMs(parseDirectives('!ok hi'))).toBe(0)
  })
})

describe('MockAdapter', () => {
  it('declares itself honestly: no worktree, not steerable', () => {
    const caps = new MockAdapter().capabilities()
    // It produces no diff, so a task routed here must not be given a worktree
    // to verify. And it cannot be steered mid-run, so `signalAgent` must skip it.
    expect(caps.worktrees).toBe(false)
    expect(caps.steerable).toBe(false)
    expect(MOCK_RUNTIME_ID).toBe('clawboo-mock')
  })

  it('!ok drains to a successful terminal', async () => {
    const seen = await drain(new MockAdapter(), '!ok all good')
    expect(seen.map((e) => e.kind)).toEqual(['text-delta', 'done'])
    expect(seen[1]).toMatchObject({ reason: 'success', summary: 'all good' })
  })

  it('!error yields a FATAL error and stops — the failure-reflection path', async () => {
    const seen = await drain(new MockAdapter(), '!error disk full')
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ kind: 'error', fatal: true, message: 'disk full' })
  })

  it('!toolcall leaves the call UNRESOLVED — what earns the longer allowance', async () => {
    // A tool-call with no matching tool-result is exactly the shape that must not
    // be mistaken for a dead stream: a long build is silent but alive.
    const seen = await drain(new MockAdapter(), '!toolcall compile')
    expect(seen.map((e) => e.kind)).toEqual(['tool-call', 'done'])
    expect(seen.some((e) => e.kind === 'tool-result')).toBe(false)
  })

  it('!loop emits identical call/result pairs — the no-progress breaker input', async () => {
    const seen = await drain(new MockAdapter(), '!loop 3')
    expect(seen.filter((e) => e.kind === 'tool-call')).toHaveLength(3)
    expect(seen.filter((e) => e.kind === 'tool-result')).toHaveLength(3)
    // Identical by construction, which is what "no progress" means.
    const outputs = new Set(seen.filter((e) => e.kind === 'tool-result').map((e) => e['output']))
    expect(outputs.size).toBe(1)
  })

  it('!crash throws OUT of the stream rather than yielding a terminal', async () => {
    // The drain sees a rejection, not a `done`. That is the path a `finally` has
    // to cover, and the reason a leaked heartbeat was possible before.
    await expect(drain(new MockAdapter(), '!crash')).rejects.toThrow(/injected crash/)
  })

  it('!slowstart delays start() itself, while the caller holds its lock', async () => {
    const adapter = new MockAdapter()
    const began = Date.now()
    await adapter.start(
      { taskId: 't1', teamId: null },
      { agentId: 'a1', sessionKey: 'sk', message: '!slowstart 60' },
    )
    expect(Date.now() - began).toBeGreaterThanOrEqual(50)
  })

  it('abort ends a run that would otherwise never terminate', async () => {
    const adapter = new MockAdapter()
    const run = await adapter.start(
      { taskId: 't1', teamId: null },
      { agentId: 'a1', sessionKey: 'sk', message: '!abort' },
    )
    setTimeout(() => void adapter.abort(run), 20)
    const seen: string[] = []
    for await (const ev of adapter.events(run)) seen.push(ev.kind)
    expect(seen).toEqual(['done'])
  })

  it('a directive-free message still succeeds, so an ordinary task is not a fault', async () => {
    const seen = await drain(new MockAdapter(), 'just do the work')
    expect(seen.map((e) => e.kind)).toEqual(['done'])
    expect(seen[0]).toMatchObject({ reason: 'success' })
  })
})

describe('directive parsing after the ReDoS-shape fix', () => {
  // CodeQL flagged the old `/^\s*!(\w+)\s*(.*)$/` as polynomial ReDoS: `\s*`
  // and `.*` both match a space, so they overlap. Measured, V8 handles it fine
  // (3ms on four million spaces), so this was a PATTERN finding rather than an
  // exploitable one, and no timing assertion here would bind. What is worth
  // pinning is that removing the ambiguity did not change what the parser does.
  it('splits a directive from its argument exactly as before', () => {
    expect(parseDirectives('!loop 5')).toEqual([{ kind: 'loop', times: 5 }])
    expect(parseDirectives('  !ok hello there')).toEqual([{ kind: 'ok', text: 'hello there' }])
    expect(parseDirectives('!ok')).toEqual([{ kind: 'ok', text: 'ok' }])
    expect(parseDirectives('!ok' + ' '.repeat(200))).toEqual([{ kind: 'ok', text: 'ok' }])
    expect(parseDirectives('not a directive')).toEqual([])
    expect(parseDirectives('text\n!error boom\nmore')).toEqual([{ kind: 'error', message: 'boom' }])
  })

  it('the !abort hold-open survives past the directive clamp', async () => {
    // A regression I introduced and the suite could not catch: clamping inside
    // `sleep` also capped this, so a run meant to hang until something aborts it
    // ended itself after ten minutes. Real time cannot show that, so this drives
    // the clock forward past the cap.
    vi.useFakeTimers()
    try {
      const adapter = new MockAdapter()
      const run = await adapter.start(
        {} as never,
        {
          agentId: 'a1',
          sessionKey: 'agent:a1:team:T',
          message: '!abort',
        } as never,
      )
      let terminal: string | null = null
      const drain = (async () => {
        for await (const ev of adapter.events(run)) if (ev.kind === 'done') terminal = ev.kind
      })()
      await vi.advanceTimersByTimeAsync(11 * 60_000) // past MAX_DIRECTIVE_SLEEP_MS
      expect(terminal).toBeNull() // still held open, as the directive promises
      await adapter.abort(run)
      await vi.advanceTimersByTimeAsync(10)
      await drain
      expect(terminal).toBe('done')
    } finally {
      vi.useRealTimers()
    }
  })

  it('an unbounded ask for silence is still clamped', () => {
    const [d] = parseDirectives('!silent 999999999')
    expect(d).toMatchObject({ kind: 'silent' })
    expect((d as { ms: number }).ms).toBe(10 * 60_000)
  })
})
