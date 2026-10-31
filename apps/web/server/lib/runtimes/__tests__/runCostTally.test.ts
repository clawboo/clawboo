import type { RuntimeEvent } from '@clawboo/executor'
import { describe, expect, it } from 'vitest'

import { estimateRunCostUsd, estimateRunCostUsdFromUsage } from '../estimateCost'
import { createRunCostTally, type RunCostFallback } from '../runCostTally'

let seq = 0
const base = () => ({ runId: 'run-1', sessionId: 's-1', ts: 1_000 + seq, seq: seq++ })

function cost(
  costUsd: number | null,
  usage: { inputTokens: number; outputTokens: number },
  model: string | null = null,
  estimated?: boolean,
  local?: boolean,
): RuntimeEvent {
  return {
    ...base(),
    kind: 'cost',
    costUsd,
    usage,
    model,
    ...(estimated === undefined ? {} : { estimated }),
    ...(local ? { local } : {}),
  }
}

function done(
  costUsd?: number | null,
  usage?: { inputTokens: number; outputTokens: number },
): RuntimeEvent {
  return {
    ...base(),
    kind: 'done',
    reason: 'success',
    summary: 'ok',
    ...(costUsd === undefined ? {} : { costUsd }),
    ...(usage ? { usage } : {}),
  }
}

const NO_FALLBACK: RunCostFallback = { model: null, inputChars: 4_000, outputChars: 400 }

function run(events: RuntimeEvent[], fallback: RunCostFallback = NO_FALLBACK) {
  const tally = createRunCostTally()
  for (const ev of events) tally.observe(ev)
  return tally.settle(fallback)
}

describe('createRunCostTally: local models', () => {
  it('settles a run whose cost events all ran on a local Ollama as free', () => {
    const settled = run([
      cost(0, { inputTokens: 2_000, outputTokens: 300 }, 'llama3.2', undefined, true),
      cost(0, { inputTokens: 2_500, outputTokens: 200 }, 'llama3.2', undefined, true),
      done(0),
    ])
    expect(settled).toEqual({
      costUsd: 0,
      costSource: 'local',
      inputTokens: 4_500,
      outputTokens: 500,
      unbilledUsd: 0,
    })
  })

  it('prices nothing for an OpenClaw run on an Ollama model that reported no usage', () => {
    const settled = run([done()], {
      model: 'ollama/llama3.2',
      inputChars: 40_000,
      outputChars: 4_000,
    })
    expect(settled).toEqual({
      costUsd: 0,
      costSource: 'local',
      inputTokens: null,
      outputTokens: null,
      unbilledUsd: 0,
    })
  })

  it('still estimates a run on an Ollama cloud model', () => {
    const fb = { model: 'ollama/gpt-oss:120b-cloud', inputChars: 4_000, outputChars: 400 }
    const settled = run([done()], fb)
    expect(settled.costSource).toBe('char-estimate')
    expect(settled.costUsd).toBeGreaterThan(0)
  })

  it('is not free when a local turn sits beside a paid one', () => {
    const settled = run([
      cost(0, { inputTokens: 100, outputTokens: 10 }, 'llama3.2', undefined, true),
      cost(0.05, { inputTokens: 100, outputTokens: 10 }, 'claude-haiku-4-5'),
      done(),
    ])
    expect(settled.costSource).toBe('reported')
    expect(settled.costUsd).toBeCloseTo(0.05, 12)
  })

  it('names the model the cost events reported last', () => {
    const tally = createRunCostTally()
    expect(tally.model()).toBeNull()
    tally.observe(cost(0.01, { inputTokens: 1, outputTokens: 1 }, 'claude-haiku-4-5'))
    expect(tally.model()).toBe('claude-haiku-4-5')
  })
})

describe('createRunCostTally', () => {
  it('prices Codex-shaped usage with no USD as a token estimate', () => {
    const settled = run([cost(null, { inputTokens: 34_115, outputTokens: 500 }), done()])
    const expected = estimateRunCostUsdFromUsage({
      model: null,
      inputTokens: 34_115,
      outputTokens: 500,
    })
    expect(expected).toBeGreaterThan(0)
    expect(settled).toEqual({
      costUsd: expected,
      costSource: 'token-estimate',
      inputTokens: 34_115,
      outputTokens: 500,
      unbilledUsd: expected,
    })
  })

  it('reads a Claude Code cost once when done repeats it', () => {
    const settled = run([
      cost(0.12, { inputTokens: 1_000, outputTokens: 200 }, 'claude-sonnet-4-6'),
      done(0.12, { inputTokens: 1_000, outputTokens: 200 }),
    ])
    expect(settled).toEqual({
      costUsd: 0.12,
      costSource: 'reported',
      inputTokens: 1_000,
      outputTokens: 200,
      unbilledUsd: 0,
    })
  })

  it("sums native's priced per-turn deltas and ignores the done total", () => {
    const settled = run([
      cost(0.01, { inputTokens: 100, outputTokens: 10 }, 'claude-haiku-4-5'),
      cost(0.02, { inputTokens: 200, outputTokens: 20 }, 'claude-haiku-4-5'),
      done(0.03),
    ])
    expect(settled.costSource).toBe('reported')
    expect(settled.costUsd).toBeCloseTo(0.03, 9)
    expect(settled.unbilledUsd).toBe(0)
    expect([settled.inputTokens, settled.outputTokens]).toEqual([300, 30])
  })

  it('reads only the cost events when done carries a different total', () => {
    const settled = run([cost(0.12, { inputTokens: 10, outputTokens: 1 }), done(0.5)])
    expect(settled.costUsd).toBe(0.12)
    expect(settled.unbilledUsd).toBe(0)
  })

  it('adds a token estimate for the unpriced turns of a mixed native run', () => {
    const settled = run([
      cost(0.01, { inputTokens: 500, outputTokens: 50 }, 'claude-sonnet-5'),
      cost(null, { inputTokens: 1_000, outputTokens: 100 }, 'claude-sonnet-5'),
      done(0.01),
    ])
    // Sonnet 5 at $2/M in and $10/M out: 1000 in + 100 out = 0.002 + 0.001.
    expect(settled.costSource).toBe('token-estimate')
    expect(settled.costUsd).toBeCloseTo(0.013, 9)
    expect(settled.unbilledUsd).toBeCloseTo(0.003, 9)
    expect([settled.inputTokens, settled.outputTokens]).toEqual([1_500, 150])
  })

  it('falls back to a char estimate at the configured model when no cost arrives', () => {
    const fallback = { model: 'claude-haiku-4-5', inputChars: 4_000, outputChars: 400 }
    const settled = run([done()], fallback)
    // 1000 tokens in and 100 out at Haiku 4.5's $1/M and $5/M.
    expect(settled).toEqual({
      costUsd: estimateRunCostUsd(fallback),
      costSource: 'char-estimate',
      inputTokens: null,
      outputTokens: null,
      unbilledUsd: estimateRunCostUsd(fallback),
    })
    expect(settled.costUsd).toBeCloseTo(0.0015, 9)
  })

  it('keeps a reported $0 instead of guessing from characters', () => {
    const settled = run([cost(0, { inputTokens: 0, outputTokens: 0 }), done(0)])
    expect(settled).toEqual({
      costUsd: 0,
      costSource: 'reported',
      inputTokens: null,
      outputTokens: null,
      unbilledUsd: 0,
    })
  })

  it('reads the done cost when no cost event came, as unbilled', () => {
    const settled = run([done(0.2)])
    expect(settled).toEqual({
      costUsd: 0.2,
      costSource: 'reported',
      inputTokens: null,
      outputTokens: null,
      unbilledUsd: 0.2,
    })
  })

  it('never reads usage off a done event', () => {
    const settled = run([done(null, { inputTokens: 1_000_000, outputTokens: 1_000_000 })])
    expect(settled.costSource).toBe('char-estimate')
    expect(settled.inputTokens).toBeNull()
    expect(settled.costUsd).toBe(estimateRunCostUsd(NO_FALLBACK))
  })

  it('marks a runtime-flagged estimate as a token estimate, already billed', () => {
    const settled = run([cost(0.05, { inputTokens: 10, outputTokens: 1 }, null, true), done()])
    expect(settled.costSource).toBe('token-estimate')
    expect(settled.costUsd).toBe(0.05)
    expect(settled.unbilledUsd).toBe(0)
  })

  it('uses the configured model only when the events name none', () => {
    const fallback = { model: 'claude-haiku-4-5', inputChars: 0, outputChars: 0 }
    const usage = { inputTokens: 1_000_000, outputTokens: 0 }
    // Opus 4.1 from the event ($15/M), not Haiku 4.5 from the agent ($1/M).
    expect(run([cost(null, usage, 'claude-opus-4-1')], fallback).costUsd).toBe(15)
    // A later event with no model keeps the model an earlier event named.
    expect(run([cost(null, usage, 'claude-opus-4-1'), cost(null, usage)], fallback).costUsd).toBe(
      30,
    )
    expect(run([cost(null, usage)], fallback).costUsd).toBe(1)
  })

  it('ignores text, tool, status and error events', () => {
    const settled = run([
      { ...base(), kind: 'status', phase: 'init', model: 'claude-opus-4-1' },
      { ...base(), kind: 'text-delta', text: 'hello' },
      { ...base(), kind: 'tool-call', toolCallId: 't1', name: 'Read', input: {}, partial: false },
      {
        ...base(),
        kind: 'tool-result',
        toolCallId: 't1',
        name: 'Read',
        output: 'x',
        isError: false,
      },
      { ...base(), kind: 'error', code: null, message: 'boom', fatal: true },
    ])
    expect(settled).toEqual({
      costUsd: estimateRunCostUsd(NO_FALLBACK),
      costSource: 'char-estimate',
      inputTokens: null,
      outputTokens: null,
      unbilledUsd: estimateRunCostUsd(NO_FALLBACK),
    })
  })
})
