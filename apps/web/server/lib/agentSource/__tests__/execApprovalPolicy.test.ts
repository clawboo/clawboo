// Applying a Boo's exec posture where it actually counts.
//
// The defect this replaces was not a crash. Setting a Boo to "Ask for Unknown"
// reported "Saved", wrote clawboo's own record, and left OpenClaw's policy empty
// — so the Boo kept running every command unasked while the operator believed a
// gate was on. The Gateway write sat behind a connection check inside a
// `catch {}`, with the success message shown regardless.
//
// So the property under test is not "does it write", it is "does it ADMIT when it
// did not write". A permissions control that can silently fail is worse than an
// absent one, because it converts an open door into a door someone thinks is shut.

import { describe, expect, it } from 'vitest'

import { applyExecApprovalPolicy, isExecAsk, readExecApprovalPolicy } from '../execApprovalPolicy'

function makeSource(opts: { failWith?: string; existing?: Record<string, unknown> } = {}) {
  const calls: { method: string; params?: unknown }[] = []
  return {
    calls,
    source: {
      operatorCall: async <T>(method: string, params?: unknown): Promise<T> => {
        calls.push({ method, params })
        if (opts.failWith) throw new Error(opts.failWith)
        if (method === 'exec.approvals.get') {
          return {
            path: 'state/openclaw.sqlite#exec_approvals_config',
            exists: true,
            hash: 'h1',
            file: { version: 1, socket: { path: '/tmp/s.sock' }, agents: opts.existing ?? {} },
          } as T
        }
        return undefined as T
      },
    },
  }
}

const setCall = (calls: { method: string; params?: unknown }[]) =>
  calls.find((c) => c.method === 'exec.approvals.set')?.params as
    { file?: { agents?: Record<string, { ask?: string; allowlist?: unknown[] }> } } | undefined

describe('isExecAsk', () => {
  it('accepts only the three postures the Gateway understands', () => {
    for (const good of ['off', 'on-miss', 'always']) expect(isExecAsk(good)).toBe(true)
    for (const bad of ['on', 'ask', '', null, undefined, 1]) expect(isExecAsk(bad)).toBe(false)
  })
})

describe('applyExecApprovalPolicy', () => {
  it('writes the posture through the Gateway RPC', () => {
    const h = makeSource()
    return applyExecApprovalPolicy(h.source, 'browser-test-boo', 'on-miss').then((res) => {
      expect(res.ok).toBe(true)
      expect(setCall(h.calls)?.file?.agents?.['browser-test-boo']?.ask).toBe('on-miss')
    })
  })

  it('REPORTS a failure instead of claiming success', async () => {
    // The whole point. The browser path swallowed this and showed "Saved".
    const h = makeSource({ failWith: 'gateway is down' })
    const res = await applyExecApprovalPolicy(h.source, 'browser-test-boo', 'always')
    expect(res.ok).toBe(false)
    expect(res.error).toContain('gateway is down')
  })

  it('never authors the trusted-command list', async () => {
    // That list is OpenClaw's, built by the operator answering "Always". A writer
    // that invented entries would produce two lists that disagree, and the Gateway
    // would then ignore approvals clawboo thought it had granted.
    const h = makeSource({ existing: { 'browser-test-boo': { allowlist: [{ pattern: 'git' }] } } })
    await applyExecApprovalPolicy(h.source, 'browser-test-boo', 'on-miss')
    expect(setCall(h.calls)?.file?.agents?.['browser-test-boo']?.allowlist).toEqual([
      { pattern: 'git' },
    ])
  })

  it('leaves every other agent untouched', async () => {
    const h = makeSource({ existing: { 'other-boo': { ask: 'always' } } })
    await applyExecApprovalPolicy(h.source, 'browser-test-boo', 'on-miss')
    expect(setCall(h.calls)?.file?.agents?.['other-boo']?.ask).toBe('always')
  })
})

describe('readExecApprovalPolicy', () => {
  it('reports an ABSENT policy as "off", which is what the Gateway does', async () => {
    // Not "unknown". An agent with no entry runs freely, and calling that unknown
    // is how a UI ends up showing a gate that was never applied.
    const h = makeSource()
    await expect(readExecApprovalPolicy(h.source, 'browser-test-boo')).resolves.toEqual({
      ok: true,
      ask: 'off',
    })
  })

  it('reports what the Gateway actually holds', async () => {
    const h = makeSource({ existing: { 'browser-test-boo': { ask: 'on-miss' } } })
    await expect(readExecApprovalPolicy(h.source, 'browser-test-boo')).resolves.toEqual({
      ok: true,
      ask: 'on-miss',
    })
  })

  it('does not pretend to know when it cannot ask', async () => {
    const h = makeSource({ failWith: 'disconnected' })
    const res = await readExecApprovalPolicy(h.source, 'browser-test-boo')
    expect(res.ok).toBe(false)
    expect(res.ask).toBeUndefined()
  })
})
