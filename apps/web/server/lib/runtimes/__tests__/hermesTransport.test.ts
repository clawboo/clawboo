// Which way a Hermes run is driven: ACP unless this Hermes was just found
// without it, and the operator's override either way. And what `hermes acp
// --check` last said, which the Runtimes status reads without waiting.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const check = vi.hoisted(() => ({
  answer: null as boolean | null,
  calls: 0,
  /** When set, a check waits for this before it answers. */
  gate: null as Promise<void> | null,
}))
vi.mock('../hermesAcpCheck', () => ({
  runHermesAcpCheck: async () => {
    check.calls += 1
    const answer = check.answer
    if (check.gate) await check.gate
    return answer
  },
}))

import {
  HERMES_ACP_RECHECK_MS,
  checkHermesAcp,
  hermesTransport,
  markHermesAcpMissing,
  peekHermesAcp,
  resetHermesTransport,
} from '../hermesTransport'

describe('hermesTransport', () => {
  let prev: string | undefined
  beforeEach(() => {
    prev = process.env['CLAWBOO_HERMES_TRANSPORT']
    delete process.env['CLAWBOO_HERMES_TRANSPORT']
    resetHermesTransport()
    check.answer = null
    check.calls = 0
    check.gate = null
  })
  afterEach(() => {
    if (prev === undefined) delete process.env['CLAWBOO_HERMES_TRANSPORT']
    else process.env['CLAWBOO_HERMES_TRANSPORT'] = prev
    resetHermesTransport()
  })

  it('tries ACP by default', () => {
    expect(hermesTransport()).toBe('acp')
  })

  it('stays quiet for a while after a Hermes without ACP, then tries again', () => {
    markHermesAcpMissing('ACP dependencies not installed', 1_000)
    expect(hermesTransport(1_000 + HERMES_ACP_RECHECK_MS - 1)).toBe('quiet')
    expect(hermesTransport(1_000 + HERMES_ACP_RECHECK_MS)).toBe('acp')
  })

  it("follows the operator's override", () => {
    process.env['CLAWBOO_HERMES_TRANSPORT'] = 'quiet'
    expect(hermesTransport()).toBe('quiet')
    process.env['CLAWBOO_HERMES_TRANSPORT'] = 'ACP'
    markHermesAcpMissing('missing')
    expect(hermesTransport()).toBe('acp')
  })

  it('a check that finds no ACP keeps runs quiet, and the status reads it', async () => {
    check.answer = false
    await expect(checkHermesAcp()).resolves.toBe(false)
    expect(peekHermesAcp()).toBe(false)
    expect(hermesTransport()).toBe('quiet')
  })

  it('a check that finds ACP leaves runs on it', async () => {
    check.answer = true
    await checkHermesAcp()
    expect(peekHermesAcp()).toBe(true)
    expect(hermesTransport()).toBe('acp')
  })

  it('peeking never waits: it starts a check and answers once that check is in', async () => {
    check.answer = false
    expect(peekHermesAcp()).toBeNull()
    expect(check.calls).toBe(1)
    await checkHermesAcp()
    expect(peekHermesAcp()).toBe(false)
    // A fresh answer is not asked again.
    expect(check.calls).toBe(1)
  })

  it('asks again once the answer is old', async () => {
    check.answer = false
    await checkHermesAcp()
    const calls = check.calls
    expect(peekHermesAcp(Date.now() + HERMES_ACP_RECHECK_MS)).toBe(false)
    expect(check.calls).toBe(calls + 1)
  })

  it('a reset (after an install) forgets the answer, including a check still running', async () => {
    check.answer = false
    await checkHermesAcp()
    expect(hermesTransport()).toBe('quiet')

    // A check from before the install lands after the reset: it is dropped.
    let release!: () => void
    check.gate = new Promise<void>((r) => (release = r))
    const stale = checkHermesAcp()
    resetHermesTransport()
    expect(hermesTransport()).toBe('acp')
    // The updated Hermes has ACP; the status asks again at once.
    check.answer = true
    expect(peekHermesAcp()).toBeNull()
    release()
    await expect(stale).resolves.toBe(false)
    await expect(checkHermesAcp()).resolves.toBe(true)
    expect(peekHermesAcp()).toBe(true)
    expect(hermesTransport()).toBe('acp')
  })

  it('reports nothing, and checks nothing, when the operator pinned the quiet path', () => {
    process.env['CLAWBOO_HERMES_TRANSPORT'] = 'quiet'
    expect(peekHermesAcp()).toBeNull()
    expect(check.calls).toBe(0)
  })
})
