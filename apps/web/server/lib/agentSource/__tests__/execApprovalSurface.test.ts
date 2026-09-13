// Somewhere an exec approval can be asked that is not a browser tab.
//
// OpenClaw sends the question only to connections that declare they can answer
// it, and with no such connection it does not queue the request — it expires it
// immediately. Before this, clawboo's server connection declared no such thing,
// so the only surface was an open tab. That is why the fleet policy could not be
// switched on: turning on "ask me" with only a tab means every command fails the
// moment the tab is shut.
//
// Two properties carry it, and both fail quietly rather than loudly:
//
//  1. THE ANSWER GOES TO THE GATEWAY FIRST. The Gateway holds the command; the
//     local row is only a mirror. Marking the row answered without the RPC
//     succeeding would show a resolved card for a command still being held, and
//     nothing on screen would say otherwise.
//  2. A SECOND ANSWER IS NORMAL. The same card can be open in a tab, and the
//     Gateway fans it out to every surface. Losing that race is expected, not an
//     error to show the operator.

import { createDb, toolCallApprovals, type ClawbooDb } from '@clawboo/db'
import { beforeEach, describe, expect, it, vi } from 'vitest'

let db: ClawbooDb
vi.mock('../../db', () => ({ getDb: () => db }))

const {
  expireStaleExecApprovals,
  parseExecApprovalRequest,
  resolveExecApproval,
  startExecApprovalSurface,
} = await import('../execApprovalSurface')

function makeSource(opts: { failWith?: string } = {}) {
  const calls: { method: string; params?: unknown }[] = []
  let onFrame: ((f: { event: string; payload?: unknown }) => void) | null = null
  return {
    calls,
    frame: (f: { event: string; payload?: unknown }) => onFrame?.(f),
    source: {
      operatorCall: async <T>(method: string, params?: unknown): Promise<T> => {
        calls.push({ method, params })
        if (opts.failWith) throw new Error(opts.failWith)
        return undefined as T
      },
      onGatewayBroadcast: (cb: (f: { event: string; payload?: unknown }) => void) => {
        onFrame = cb
        return () => {
          onFrame = null
        }
      },
    },
  }
}

const requestFrame = (id: string, command = 'rm -rf build') => ({
  event: 'exec.approval.requested',
  payload: {
    id,
    expiresAtMs: Date.now() + 1_800_000,
    request: { command, agentId: 'doc-writer-boo', cwd: '/tmp', reason: 'not on the list' },
  },
})

const rows = (): { id: string; kind: string; status: string; agentId: string | null }[] =>
  db
    .select({
      id: toolCallApprovals.id,
      kind: toolCallApprovals.kind,
      status: toolCallApprovals.status,
      agentId: toolCallApprovals.agentId,
    })
    .from(toolCallApprovals)
    .all()

beforeEach(() => {
  db = createDb(':memory:')
})

describe('parseExecApprovalRequest', () => {
  it('ignores a shape it does not recognise', () => {
    for (const bad of [null, {}, { id: 'x' }, { request: { command: 'ls' } }]) {
      expect(parseExecApprovalRequest(bad)).toBeNull()
    }
  })
})

describe('startExecApprovalSurface', () => {
  it('mirrors a request so it outlives a closed tab', () => {
    const h = makeSource()
    startExecApprovalSurface(h.source, () => 'clawboo-row-1')
    h.frame(requestFrame('ap-1'))

    const [row] = rows()
    expect(row?.id).toBe('ap-1')
    expect(row?.kind).toBe('exec')
    expect(row?.status).toBe('pending')
    // Filed under clawboo's row id, which is what the card and the feed use.
    expect(row?.agentId).toBe('clawboo-row-1')
  })

  it('keeps an approval it cannot attribute', () => {
    // Unlike an activity row, an unattributed approval must still be ANSWERABLE.
    // Dropping it would leave the Gateway holding a command with no way to reply.
    const h = makeSource()
    startExecApprovalSurface(h.source, () => null)
    h.frame(requestFrame('ap-2'))
    expect(rows()).toHaveLength(1)
  })

  it('is idempotent on redelivery', () => {
    const h = makeSource()
    startExecApprovalSurface(h.source, () => 'a1')
    h.frame(requestFrame('ap-3'))
    h.frame(requestFrame('ap-3'))
    expect(rows()).toHaveLength(1)
  })

  it('clears the card when another surface answers first', () => {
    // The Gateway tells every surface when any one of them resolves. Without
    // this, a card answered in the browser would sit here looking pending.
    const h = makeSource()
    startExecApprovalSurface(h.source, () => 'a1')
    h.frame(requestFrame('ap-4'))
    h.frame({ event: 'exec.approval.resolved', payload: { id: 'ap-4', decision: 'allow_once' } })
    expect(rows()[0]?.status).toBe('allow_once')
  })

  it('stops listening after stop()', () => {
    const h = makeSource()
    const s = startExecApprovalSurface(h.source, () => 'a1')
    s.stop()
    h.frame(requestFrame('ap-5'))
    expect(rows()).toHaveLength(0)
  })
})

describe('expireStaleExecApprovals', () => {
  it('retires a card the Gateway has stopped waiting on', () => {
    // The outcome nobody announces. The Gateway emits a resolved event when a
    // human answers, but on timeout it resolves internally and says nothing, so
    // an unswept mirror shows an answerable card for a command already refused.
    const h = makeSource()
    startExecApprovalSurface(h.source, () => 'a1')
    h.frame({
      event: 'exec.approval.requested',
      payload: {
        id: 'ap-old',
        expiresAtMs: Date.now() - 1_000, // the Gateway's deadline has passed
        request: { command: 'rm -rf /', agentId: 'doc-writer-boo' },
      },
    })
    expect(rows()[0]?.status).toBe('pending')

    expect(expireStaleExecApprovals(db)).toBe(1)
    expect(rows()[0]?.status).toBe('expired')
  })

  it('leaves a card the Gateway is still holding', () => {
    const h = makeSource()
    startExecApprovalSurface(h.source, () => 'a1')
    h.frame(requestFrame('ap-live'))
    expect(expireStaleExecApprovals(db)).toBe(0)
    expect(rows()[0]?.status).toBe('pending')
  })

  it("does not touch clawboo's own broker approvals", () => {
    // Those are held by a blocked promise in this process with its own, much
    // shorter clock. Expiring them on the Gateway's schedule would release a
    // caller nobody answered for.
    db.insert(toolCallApprovals)
      .values({
        id: 'broker-1',
        kind: 'tool',
        toolName: 'mcp__chrome-devtools__navigate_page',
        status: 'pending',
        neverRemember: 0,
        createdAt: Date.now() - 10_000,
        expiresAt: Date.now() - 5_000,
      })
      .run()
    expect(expireStaleExecApprovals(db)).toBe(0)
  })
})

describe('resolveExecApproval', () => {
  it('answers the GATEWAY, then marks the mirror', async () => {
    const h = makeSource()
    startExecApprovalSurface(h.source, () => 'a1')
    h.frame(requestFrame('ap-6'))

    const res = await resolveExecApproval(h.source, 'ap-6', 'allow-once')
    expect(res.ok).toBe(true)
    expect(h.calls).toEqual([
      { method: 'exec.approval.resolve', params: { id: 'ap-6', decision: 'allow-once' } },
    ])
    expect(rows()[0]?.status).toBe('allow_once')
  })

  it('does NOT mark the mirror when the Gateway refuses', async () => {
    // The load-bearing order. The Gateway holds the command; if it did not accept
    // the answer, a card showing "resolved" is a lie the operator cannot see past.
    const h = makeSource({ failWith: 'gateway exploded' })
    startExecApprovalSurface(h.source, () => 'a1')
    h.frame(requestFrame('ap-7'))

    const res = await resolveExecApproval(h.source, 'ap-7', 'deny')
    expect(res.ok).toBe(false)
    expect(rows()[0]?.status).toBe('pending')
  })

  it('treats losing the race to a browser tab as success', async () => {
    // Expected, not exceptional: the card is open in both places by design.
    const h = makeSource({ failWith: 'INVALID_REQUEST: approval already resolved' })
    startExecApprovalSurface(h.source, () => 'a1')
    h.frame(requestFrame('ap-8'))

    const res = await resolveExecApproval(h.source, 'ap-8', 'allow-once')
    expect(res).toEqual({ ok: true, alreadyResolved: true })
  })
})
