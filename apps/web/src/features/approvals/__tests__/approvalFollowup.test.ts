// The webchat approval-followup recovery (runApprovalFollowup): a deterministic
// re-run of the approved command via deliver:false, for ALLOW-ALWAYS ONLY.
//
// The allow-once branch used to drop exec approval, re-run inside that window, and
// restore afterwards, and these tests pinned that. On OpenClaw 2026.9 it had three
// faults at once: `sessions.patch` now rejects `execSecurity`/`execAsk` on key
// presence, so every allow-once approval reported a spurious failure on an approval
// that had already succeeded; the restore path wrote an EMPTY allowlist, because
// setting 'off' drops the agent entry and the restore then found no prior; and
// between the two the agent could run anything with no approval at all.
//
// The tests below now pin the absence of that whole dance. They are written as
// "must not call" assertions because the faults were all extra calls, and because
// the previous tests passed throughout — their fake returned {} for
// exec.approvals.get, which is exactly the empty-prior state that caused the wipe.

import { describe, expect, it } from 'vitest'

import { runApprovalFollowup, type ApprovalFollowupClient } from '../useApprovalActions'

interface RecordedCall {
  method: string
  params: Record<string, unknown> | undefined
}

function makeClient(opts: { throwOn?: string } = {}): {
  client: ApprovalFollowupClient
  calls: RecordedCall[]
} {
  const calls: RecordedCall[] = []
  const client: ApprovalFollowupClient = {
    async call<T = unknown>(method: string, params?: unknown): Promise<T> {
      calls.push({ method, params: params as Record<string, unknown> | undefined })
      if (opts.throwOn && method === opts.throwOn) throw new Error('transport boom')
      if (method === 'exec.approvals.get') return {} as T // no file → defaults
      return undefined as T
    },
  }
  return { client, calls }
}

const base = {
  agentId: 'a1',
  command: 'ls -la',
  sessionKey: 'agent:a1:main',
  activeRunId: 'run-1',
  isAgentResponding: () => false,
  delay: async () => {}, // no real timers
}

const sentReruns = (calls: RecordedCall[]) => calls.filter((c) => c.method === 'chat.send')
const execOffPatches = (calls: RecordedCall[]) =>
  calls.filter((c) => c.method === 'sessions.patch' && c.params?.['execAsk'] === 'off')
const sessionPatches = (calls: RecordedCall[]) => calls.filter((c) => c.method === 'sessions.patch')

describe('runApprovalFollowup', () => {
  it('does nothing when the agent is already responding (Gateway followup landed)', async () => {
    const { client, calls } = makeClient()
    await runApprovalFollowup({
      ...base,
      client,
      decision: 'allow-once',
      isAgentResponding: () => true,
    })
    expect(sentReruns(calls)).toHaveLength(0)
    expect(sessionPatches(calls)).toHaveLength(0)
  })

  it('allow-always: re-runs with deliver:false and does NOT touch the exec policy', async () => {
    const { client, calls } = makeClient()
    await runApprovalFollowup({ ...base, client, decision: 'allow-always' })
    const reruns = sentReruns(calls)
    expect(reruns).toHaveLength(1)
    expect(reruns[0]?.params?.['deliver']).toBe(false)
    // allow-always: the command is already on the allowlist — no exec policy change.
    expect(execOffPatches(calls)).toHaveLength(0)
  })

  it('allow-once: does NOT touch the exec policy at all', async () => {
    // The headline regression. Any sessions.patch here reintroduces the retired
    // execSecurity/execAsk fields, which 2026.9 rejects on key presence — and the
    // rejection surfaces to the operator as a failed approval that in fact succeeded.
    const { client, calls } = makeClient()
    await runApprovalFollowup({ ...base, client, decision: 'allow-once' })
    expect(sessionPatches(calls)).toHaveLength(0)
    expect(execOffPatches(calls)).toHaveLength(0)
  })

  it('allow-once: does NOT rewrite the stored approval policy', async () => {
    // The wipe. Writing the policy for an allow-once round-trip is what emptied the
    // operator's accumulated allow-always entries, because 'off' drops the agent's
    // entry and the restore then re-read a store with no prior to carry forward.
    const { client, calls } = makeClient()
    await runApprovalFollowup({ ...base, client, decision: 'allow-once' })
    expect(calls.filter((c) => c.method === 'exec.approvals.set')).toHaveLength(0)
  })

  it('allow-once: does not re-run the command', async () => {
    // The trade this makes, stated as a test rather than left implicit. Recovering
    // the output was only possible by disabling approvals first, so the recovery
    // goes and the output may simply not appear. 2026.9 ships its own followup with
    // turn-source delivery; one live approved exec decides whether this whole
    // function can be deleted.
    const { client, calls } = makeClient()
    await runApprovalFollowup({ ...base, client, decision: 'allow-once' })
    expect(sentReruns(calls)).toHaveLength(0)
  })

  it('allow-always still recovers, and a transport error stays swallowed', async () => {
    // The path that survives. The approval already succeeded at the Gateway, so a
    // failed re-run must never surface as an approval error.
    const { client, calls } = makeClient({ throwOn: 'chat.send' })
    await expect(
      runApprovalFollowup({ ...base, client, decision: 'allow-always' }),
    ).resolves.toBeUndefined()
    expect(sentReruns(calls)).toHaveLength(1)
    expect(sessionPatches(calls)).toHaveLength(0)
  })
})
