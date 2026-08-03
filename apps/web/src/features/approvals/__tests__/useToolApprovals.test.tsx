// The tool-approval poll and `resolveTool`'s optimistic removal write the same list, so
// the poll is sequenced last-write-wins. Driven through the hook rather than a panel: the
// interesting case is a read that was already in flight when a decision was sent, which is
// far easier to stage deterministically here than through a rendered queue.

import { act, renderHook, waitFor } from '@testing-library/react'
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
    // `staleAnswered` only proves the SERVER replied. Flush a macrotask so the client's
    // fetch → json → setTool chain actually runs — otherwise a regressed guard would apply
    // its resurrection AFTER the assertion below and the test would pass anyway.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(result.current.tool).toHaveLength(0) // stays resolved
    expect(resolveHits).toBe(1) // and the decision was sent exactly once
  })

  it('applies a fresh poll that arrives after the resolve reconciled', async () => {
    // The guard must not WEDGE the list. A resolve advances the write sequence, so if that
    // bump were mishandled every later read would be judged stale forever and a new approval
    // would never appear again. The resolve here is load-bearing: without it `writeSeqRef`
    // stays 0 and this passes even if `isCurrent()` ignored the write sequence entirely.
    let calls = 0
    server.use(
      http.get('/api/tools/approvals', () => {
        calls += 1
        return HttpResponse.json({
          approvals: calls === 1 ? [approval('ap-1')] : [approval('ap-2')],
        })
      }),
      http.post('/api/tools/approvals/ap-1/resolve', () => HttpResponse.json({ ok: true })),
    )
    const { result } = renderHook(() => useToolApprovals())
    await waitFor(() => expect(result.current.tool).toHaveLength(1))

    // Commit a local write (advances writeSeq), then read AFTER it.
    await result.current.resolveTool('ap-1', 'allow_once')
    await result.current.refetch()
    await waitFor(() => expect(result.current.tool.map((a) => a.id)).toEqual(['ap-2']))
  })
})
