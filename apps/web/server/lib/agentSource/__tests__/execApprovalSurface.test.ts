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
  execDecisionStatus,
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

const rows = (): {
  id: string
  kind: string
  status: string
  agentId: string | null
  neverRemember: number
  reason: string | null
}[] =>
  db
    .select({
      id: toolCallApprovals.id,
      kind: toolCallApprovals.kind,
      status: toolCallApprovals.status,
      agentId: toolCallApprovals.agentId,
      neverRemember: toolCallApprovals.neverRemember,
      reason: toolCallApprovals.reason,
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

// ─── Whether "Always" may be offered at all ────────────────────────────────
//
// OpenClaw refuses `allow-always` in two situations, and returns an error rather
// than quietly downgrading to allow-once. So a button offered where it would be
// refused does not merely under-deliver: it fails on exactly the commands an
// operator is most tired of answering for. The request states both conditions,
// which means clawboo never has to guess, and never should.
describe('when Always may be offered', () => {
  const withRequest = (extra: Record<string, unknown>) => ({
    event: 'exec.approval.requested',
    payload: {
      id: 'ap-always',
      expiresAtMs: Date.now() + 1_800_000,
      request: { command: 'pnpm build', agentId: 'doc-writer-boo', ...extra },
    },
  })
  const offered = (extra: Record<string, unknown>): boolean => {
    const h = makeSource()
    startExecApprovalSurface(h.source, () => 'a1')
    h.frame(withRequest(extra))
    return rows()[0]?.neverRemember === 0
  }

  it('offers it on an ordinary ask-on-miss request', () => {
    expect(offered({ ask: 'on-miss' })).toBe(true)
  })

  it('withholds it when the agent asks about EVERY command', () => {
    // Nothing to remember: `ask: 'always'` means the next identical command is
    // asked about too, so a rule minted here would never be consulted.
    expect(offered({ ask: 'always' })).toBe(false)
  })

  it('withholds it when the Gateway says this command cannot be persisted', () => {
    expect(offered({ ask: 'on-miss', unavailableDecisions: ['allow-always'] })).toBe(false)
  })

  it('offers it when the Gateway sent no restriction at all', () => {
    // Absent means unrestricted, which is the vendor's own default decision list.
    // Reading absence as a refusal would silently retire Always against an older
    // Gateway that simply does not send these fields.
    expect(offered({})).toBe(true)
  })

  it("prefers the Gateway's own warning to clawboo's generic sentence", () => {
    const h = makeSource()
    startExecApprovalSurface(h.source, () => 'a1')
    h.frame(withRequest({ warningText: 'writes outside the workspace' }))
    expect(rows()[0]?.reason).toBe('writes outside the workspace')
  })
})

// ─── What the record says happened ─────────────────────────────────────────
//
// "Allowed once" and "allowed from now on" are different answers, and the row is
// where someone looks to find out why a command stopped being asked about. The
// resolve path folded everything that was not a denial into `allow_once`, so a
// standing grant an operator had just minted read as a one-off, a record that
// disagreed with the allowlist entry it had created.
describe('execDecisionStatus', () => {
  it("keeps a standing grant distinct from a one-off, in clawboo's spelling", () => {
    expect(execDecisionStatus('allow-always')).toBe('allow_always')
    expect(execDecisionStatus('allow_always')).toBe('allow_always')
    expect(execDecisionStatus('allow-once')).toBe('allow_once')
    expect(execDecisionStatus('deny')).toBe('deny')
  })

  it('files a word it does not know as the WEAKEST allow, never as a grant', () => {
    // A decision clawboo cannot read must not be recorded as a standing grant:
    // over-reporting permission is the direction that misleads.
    expect(execDecisionStatus('something-new')).toBe('allow_once')
  })
})

describe('resolveExecApproval, recording the answer', () => {
  it('records a standing grant as one', async () => {
    const h = makeSource()
    startExecApprovalSurface(h.source, () => 'a1')
    h.frame(requestFrame('ap-always-rec'))
    await resolveExecApproval(h.source, 'ap-always-rec', 'allow-always')
    expect(rows()[0]?.status).toBe('allow_always')
  })

  it('records the same answer when it arrives from another surface instead', () => {
    const h = makeSource()
    startExecApprovalSurface(h.source, () => 'a1')
    h.frame(requestFrame('ap-fanout'))
    h.frame({
      event: 'exec.approval.resolved',
      payload: { id: 'ap-fanout', decision: 'allow-always' },
    })
    expect(rows()[0]?.status).toBe('allow_always')
  })
})
