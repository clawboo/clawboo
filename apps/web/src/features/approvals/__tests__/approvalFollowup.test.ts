// The webchat approval-followup recovery (runApprovalFollowup): a deterministic,
// restore-guaranteed re-run of the approved command via deliver:false. Covers both
// the allow-once and allow-always branches, the no-op when the agent is already
// responding, and the load-bearing guarantee: the allow-once exec policy is ALWAYS
// restored — even when the re-run throws (a transport error can't strand a session
// with exec approval disabled).

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
  originalExecAsk: 'always',
  isAgentResponding: () => false,
  waitForRerunIdle: async () => {},
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

  it('allow-once: disables exec approval, re-runs deliver:false, then restores', async () => {
    const { client, calls } = makeClient()
    await runApprovalFollowup({ ...base, client, decision: 'allow-once' })
    expect(execOffPatches(calls)).toHaveLength(1) // disabled for the re-run
    expect(sentReruns(calls)[0]?.params?.['deliver']).toBe(false)
    // The LAST sessions.patch is the restore (back to the original policy, not 'off').
    const last = sessionPatches(calls).at(-1)
    expect(last?.params?.['execAsk']).not.toBe('off')
  })

  it('allow-once: ALWAYS restores the exec policy even when the re-run throws', async () => {
    const { client, calls } = makeClient({ throwOn: 'chat.send' })
    // Best-effort recovery: the throw is swallowed, never surfaced as an approval error.
    await runApprovalFollowup({ ...base, client, decision: 'allow-once' })
    // Restore still happened (the finally), despite the chat.send failure.
    const patches = sessionPatches(calls)
    expect(patches.length).toBeGreaterThanOrEqual(2) // off + restore
    expect(patches.at(-1)?.params?.['execAsk']).not.toBe('off')
  })
})
