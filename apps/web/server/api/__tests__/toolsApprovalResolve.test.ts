// Which hand actually releases the command.
//
// Two kinds of card share one Resolve button. A `tool` card is held by a promise
// blocked inside THIS process; an `exec` card is held by the Gateway, and the only
// thing that releases it is `exec.approval.resolve`. Sending an exec decision down
// the local path marks the card answered and leaves the Gateway holding the shell
// command, with nothing on screen to reveal the difference. That is the failure
// mode these tests exist to keep shut: not a crash, a card that lies.

import { createDb, toolCallApprovals, type ClawbooDb } from '@clawboo/db'
import { eq } from 'drizzle-orm'
import type { Request, Response } from 'express'
import { beforeEach, describe, expect, it, vi } from 'vitest'

let db: ClawbooDb
const calls: { method: string; params?: unknown }[] = []
let failWith: string | null = null

vi.mock('../../lib/db', () => ({ getDb: () => db }))
vi.mock('../../lib/agentSource', () => ({
  getRegistry: () => ({
    source: {
      operatorCall: async (method: string, params?: unknown) => {
        calls.push({ method, params })
        if (failWith) throw new Error(failWith)
        return undefined
      },
    },
  }),
}))

const { toolsApprovalResolvePOST } = await import('../tools')

function mockRes(): { res: Response; done: Promise<{ code: number; body: unknown }> } {
  let code = 200
  let settle: (v: { code: number; body: unknown }) => void = () => {}
  const done = new Promise<{ code: number; body: unknown }>((r) => {
    settle = r
  })
  const res = {
    status(c: number) {
      code = c
      return this
    },
    json(b: unknown) {
      settle({ code, body: b })
      return this
    },
  } as unknown as Response
  return { res, done }
}

const req = (id: string, decision: string): Request =>
  ({ params: { id }, query: {}, body: { decision } }) as unknown as Request

function seed(id: string, kind: 'exec' | 'tool'): void {
  db.insert(toolCallApprovals)
    .values({
      id,
      kind,
      toolName: kind === 'exec' ? 'exec' : 'mcp__memory__save',
      status: 'pending',
      neverRemember: kind === 'exec' ? 1 : 0,
      createdAt: Date.now(),
      expiresAt: Date.now() + 600_000,
    })
    .run()
}

const statusOf = (id: string): string | undefined =>
  db
    .select({ status: toolCallApprovals.status })
    .from(toolCallApprovals)
    .where(eq(toolCallApprovals.id, id))
    .get()?.status

beforeEach(() => {
  db = createDb(':memory:')
  calls.length = 0
  failWith = null
})

describe('POST /api/tools/approvals/:id/resolve', () => {
  it('releases an exec card at the GATEWAY, not locally', async () => {
    seed('ap-exec', 'exec')
    const { res, done } = mockRes()
    toolsApprovalResolvePOST(req('ap-exec', 'allow_once'), res)

    await expect(done).resolves.toEqual({
      code: 200,
      body: { ok: true, kind: 'exec', alreadyResolved: false },
    })
    expect(calls).toEqual([
      { method: 'exec.approval.resolve', params: { id: 'ap-exec', decision: 'allow-once' } },
    ])
  })

  it("translates Always into OpenClaw's own word for it", async () => {
    // `allow_always` is clawboo's wire value and `allow-always` is the Gateway's.
    // A decision it does not recognise is not an error there, it is a refusal, so
    // the mismatch would read as a command the operator declined.
    seed('ap-always', 'exec')
    const { res, done } = mockRes()
    toolsApprovalResolvePOST(req('ap-always', 'allow_always'), res)
    await done
    expect(calls[0]?.params).toEqual({ id: 'ap-always', decision: 'allow-always' })
  })

  it('does NOT mark an exec card answered when the Gateway refuses', async () => {
    failWith = 'gateway is down'
    seed('ap-fail', 'exec')
    const { res, done } = mockRes()
    toolsApprovalResolvePOST(req('ap-fail', 'deny'), res)

    expect((await done).code).toBe(502)
    expect(statusOf('ap-fail')).toBe('pending')
  })

  it("leaves clawboo's own broker approvals on the local path", async () => {
    // The mirror image of the bug: routing a tool card to the Gateway would ask it
    // to release a command it never had, and the blocked caller here would hang.
    seed('ap-tool', 'tool')
    const { res, done } = mockRes()
    toolsApprovalResolvePOST(req('ap-tool', 'allow_once'), res)

    expect((await done).code).toBe(200)
    expect(calls).toEqual([])
    expect(statusOf('ap-tool')).toBe('allow_once')
  })

  it('404s an id it has no card for instead of calling the Gateway', async () => {
    const { res, done } = mockRes()
    toolsApprovalResolvePOST(req('nope', 'deny'), res)
    expect((await done).code).toBe(404)
    expect(calls).toEqual([])
  })
})
