// Adding up what an agent actually spent.
//
// Summing per-turn figures is correct rather than approximate: every request
// re-sends the whole conversation, so the provider bills the full prompt each
// time. What decides whether the running total is TRUE is entirely whether a turn
// can be counted twice, so that is what these tests are about.
//
// The two ways to over-count, and both are covered below: several message frames
// land per turn carrying the same snapshot, and a restart leaves the tracker
// empty so the conversation in flight looks brand new.

import { beforeEach, describe, expect, it } from 'vitest'

import { SessionTokenSpend } from '../sessionTokenSpend'

let spend: SessionTokenSpend

beforeEach(() => {
  spend = new SessionTokenSpend()
})

const KEY = 'agent:doc-writer-boo:main'

describe('SessionTokenSpend', () => {
  it('bills a turn once, however many frames carry it', () => {
    // THE HEADLINE. A turn commits several messages and every one repeats the
    // session snapshot, so a writer that fired per frame would charge one request
    // three times and the dashboard would read high with total confidence.
    const snap = { model: 'minimax/minimax-m2.5', inputTokens: 27287, outputTokens: 117 }
    expect(spend.take(KEY, snap)).toEqual(snap)
    expect(spend.take(KEY, snap)).toBeNull()
    expect(spend.take(KEY, snap)).toBeNull()
  })

  it('bills each new turn, so the running total is the real one', () => {
    // The growing prompt is not double counting; it is what the provider charges.
    // A conversation that sends 800 then 1500 then 2400 tokens really did cost
    // 4700, because each request carried the whole history.
    const model = 'minimax/minimax-m2.5'
    const turns = [
      { model, inputTokens: 800, outputTokens: 50 },
      { model, inputTokens: 1500, outputTokens: 90 },
      { model, inputTokens: 2400, outputTokens: 30 },
    ]
    const billed = turns.map((t) => spend.take(KEY, t)).filter((t) => t !== null)
    expect(billed).toHaveLength(3)
    expect(billed.reduce((n, t) => n + (t?.inputTokens ?? 0), 0)).toBe(4700)
  })

  it('does not re-bill the turn in flight after a restart', () => {
    // The only way this design can over-count. A fresh process has no memory, so
    // the first frame of every live conversation looks like a new turn. Seeding
    // from what is already recorded turns a restart into a resume.
    const snap = { model: 'gpt-x', inputTokens: 5000, outputTokens: 200 }
    spend.seed(KEY, snap)
    expect(spend.take(KEY, snap)).toBeNull()
    // And the next genuine turn still bills.
    expect(spend.take(KEY, { ...snap, inputTokens: 6000 })).not.toBeNull()
  })

  it('keeps sessions apart', () => {
    const snap = { model: 'gpt-x', inputTokens: 100, outputTokens: 10 }
    expect(spend.take('agent:a:main', snap)).not.toBeNull()
    // Same numbers, different conversation: a real charge, not a repeat.
    expect(spend.take('agent:b:main', snap)).not.toBeNull()
  })

  it('refuses to bill without a real model name', () => {
    // "unknown" is what made every price on the dashboard zero. Writing a row we
    // cannot price rebuilds the exact fiction this replaces, so it writes nothing.
    expect(spend.take(KEY, { inputTokens: 900, outputTokens: 10 })).toBeNull()
    expect(spend.take(KEY, { model: '', inputTokens: 900, outputTokens: 10 })).toBeNull()
    expect(spend.take(KEY, { model: 'unknown', inputTokens: 900, outputTokens: 10 })).not.toBeNull()
  })

  it('ignores a frame with no usage on it', () => {
    // Most frames carry none; they must cost nothing and change nothing.
    expect(spend.take(KEY, {})).toBeNull()
    expect(spend.take(KEY, { model: 'gpt-x' })).toBeNull()
    expect(spend.take(KEY, { model: 'gpt-x', inputTokens: 0, outputTokens: 0 })).toBeNull()
  })
})
