// The tool-approval poll and `resolveTool`'s optimistic removal write the same list, so
// the poll is sequenced last-write-wins. Driven through the hook rather than a panel: the
// interesting case is a read that was already in flight when a decision was sent, which is
// far easier to stage deterministically here than through a rendered queue.

import { renderHook, waitFor } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { afterEach, describe, expect, it } from 'vitest'

import { server } from '../../../__vitest__/mswServer'
import { useToolApprovals } from '../usePendingApprovals'

function approval(id: string) {
  return {
    id,
    toolName: 'write_file',
    agentId: 'agent-1',
    argsSummary: null,
    reason: null,
    createdAt: 0,
    expiresAt: 0,
  }
}

afterEach(() => server.resetHandlers())

describe('useToolApprovals', () => {
  it('does not resurrect a resolved approval when an in-flight poll lands late', async () => {
    // Without sequencing, the parked read below lands after the optimistic removal and
    // re-adds the card — a reappearing gate on a time-sensitive prompt, which invites a
    // second click on a decision already sent.
    let calls = 0
    let releaseStale: (() => void) | undefined
    let staleAnswered = false
    let resolveHits = 0
    server.use(
      http.get('/api/tools/approvals', async () => {
        calls += 1
        // Read 2 is parked and still lists the approval; read 3 (resolveTool's own
        // reconcile) sees it gone.
        if (calls === 2) {
          await new Promise<void>((resolve) => {
            releaseStale = resolve
          })
          staleAnswered = true
          return HttpResponse.json({ approvals: [approval('ap-1')] })
        }
        return HttpResponse.json({ approvals: calls >= 3 ? [] : [approval('ap-1')] })
      }),
      http.post('/api/tools/approvals/ap-1/resolve', () => {
        resolveHits += 1
        return HttpResponse.json({ ok: true })
      }),
    )

    const { result } = renderHook(() => useToolApprovals())
    await waitFor(() => expect(result.current.tool).toHaveLength(1))

    // Start a read and leave it in flight, then send the decision underneath it.
    void result.current.refetch()
    await waitFor(() => expect(calls).toBe(2))
    await result.current.resolveTool('ap-1', 'deny')
    await waitFor(() => expect(result.current.tool).toHaveLength(0)) // optimistic removal

    // The stale read now answers, still listing the approval.
    releaseStale?.()
    await waitFor(() => expect(staleAnswered).toBe(true))
    await waitFor(() => expect(calls).toBeGreaterThanOrEqual(3))

    expect(result.current.tool).toHaveLength(0) // stays resolved
    expect(resolveHits).toBe(1) // and the decision was sent exactly once
  })

  it('applies a fresh poll that arrives after the resolve reconciled', async () => {
    // The guard must not wedge the list: a read issued after the commit still applies, so
    // a NEW approval showing up later is not swallowed.
    let calls = 0
    server.use(
      http.get('/api/tools/approvals', () => {
        calls += 1
        return HttpResponse.json({ approvals: calls === 1 ? [] : [approval('ap-2')] })
      }),
    )
    const { result } = renderHook(() => useToolApprovals())
    await waitFor(() => expect(calls).toBeGreaterThanOrEqual(1))

    await result.current.refetch()
    await waitFor(() => expect(result.current.tool.map((a) => a.id)).toEqual(['ap-2']))
  })
})
