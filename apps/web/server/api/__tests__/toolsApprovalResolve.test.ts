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
const { obsEventsGET } = await import('../obs')

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

/** The dashboard's own page: only a person may answer (see personCheck.test.ts). */
const DASHBOARD = { 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors' }
const req = (id: string, decision: string): Request =>
  ({ params: { id }, query: {}, body: { decision }, headers: DASHBOARD }) as unknown as Request

function seed(id: string, kind: 'exec' | 'tool', expiresAt = Date.now() + 600_000): void {
  db.insert(toolCallApprovals)
    .values({
      id,
      kind,
      toolName: kind === 'exec' ? 'exec' : 'mcp__memory__save',
      status: 'pending',
      neverRemember: kind === 'exec' ? 1 : 0,
      createdAt: Date.now(),
      expiresAt,
    })
    .run()
}

/** The approval events, read back through GET /api/obs/events. */
function approvalEventsFromApi(): { kind: string; data: Record<string, unknown> }[] {
  let body: { events: { kind: string; data: string }[] } = { events: [] }
  const res = {
    status() {
      return this
    },
    json(b: typeof body) {
      body = b
      return this
    },
  } as unknown as Response
  obsEventsGET(
    { query: { kinds: 'approval_requested,approval_resolved' } } as unknown as Request,
    res,
  )
  return body.events.map((e) => ({
    kind: e.kind,
    data: JSON.parse(e.data) as Record<string, unknown>,
  }))
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

/** A request signed by the app that started the engine, for one of its own
 *  people: the identity lane set `person`, and it carries no fetch metadata. */
const fromApp = (id: string, decision: string): Request =>
  ({
    params: { id },
    query: {},
    body: { decision },
    headers: {},
    person: { id: 'account:u-7', name: 'Grace', role: null },
    personVia: 'app',
  }) as unknown as Request

/** The same id from a sign-in proxy on its own: a proxy may name people so. */
const fromProxy = (id: string, decision: string): Request =>
  ({
    params: { id },
    query: {},
    body: { decision },
    headers: {},
    person: { id: 'account:u-7', name: 'Grace', role: null },
    personVia: 'proxy',
  }) as unknown as Request

describe('an answer from the app that started the engine', () => {
  it('may not allow always, on either kind of card, and leaves the card waiting', async () => {
    seed('ap-app-exec', 'exec')
    seed('ap-app-tool', 'tool')
    for (const id of ['ap-app-exec', 'ap-app-tool']) {
      const { res, done } = mockRes()
      toolsApprovalResolvePOST(fromApp(id, 'allow_always'), res)
      expect(await done).toEqual({
        code: 403,
        body: {
          error: 'allow_always_from_app',
          message: 'An answer from the app that started Clawboo can allow once or deny.',
        },
      })
      expect(statusOf(id)).toBe('pending')
    }
    expect(calls).toEqual([])
  })

  it("leaves a sign-in proxy's person free to allow always, whatever their id", async () => {
    seed('ap-proxy-always', 'tool')
    const { res, done } = mockRes()
    toolsApprovalResolvePOST(fromProxy('ap-proxy-always', 'allow_always'), res)
    expect((await done).code).toBe(200)
    expect(statusOf('ap-proxy-always')).toBe('allow_always')
  })

  it('may allow once, and the card records who answered', async () => {
    seed('ap-app-once', 'tool')
    const { res, done } = mockRes()
    toolsApprovalResolvePOST(fromApp('ap-app-once', 'allow_once'), res)
    expect((await done).code).toBe(200)
    const row = db
      .select({ status: toolCallApprovals.status, resolvedBy: toolCallApprovals.resolvedBy })
      .from(toolCallApprovals)
      .where(eq(toolCallApprovals.id, 'ap-app-once'))
      .get()
    expect(row?.status).toBe('allow_once')
    expect(JSON.parse(row?.resolvedBy ?? 'null')).toEqual({
      id: 'account:u-7',
      name: 'Grace',
      role: null,
    })
  })
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

  it('announces a decision on a tool card in the event log, once', async () => {
    // A decision that lands only on the row never reaches the Activity feeds or
    // anything else that follows the event log.
    seed('ap-tool-ev', 'tool')
    const first = mockRes()
    toolsApprovalResolvePOST(req('ap-tool-ev', 'allow_always'), first.res)
    await first.done
    const again = mockRes()
    toolsApprovalResolvePOST(req('ap-tool-ev', 'deny'), again.res)
    await again.done

    expect(approvalEventsFromApi()).toEqual([
      {
        kind: 'approval_resolved',
        data: {
          approvalId: 'ap-tool-ev',
          decision: 'allow_always',
          kind: 'tool',
          toolName: 'mcp__memory__save',
        },
      },
    ])
  })

  it('announces a decision on an exec card once the Gateway accepts it', async () => {
    seed('ap-exec-ev', 'exec')
    const { res, done } = mockRes()
    toolsApprovalResolvePOST(req('ap-exec-ev', 'deny'), res)
    await done

    expect(approvalEventsFromApi()).toEqual([
      {
        kind: 'approval_resolved',
        data: { approvalId: 'ap-exec-ev', decision: 'deny', kind: 'exec', toolName: 'exec' },
      },
    ])
  })

  it('announces nothing when the Gateway refuses the decision', async () => {
    failWith = 'gateway is down'
    seed('ap-exec-down', 'exec')
    const { res, done } = mockRes()
    toolsApprovalResolvePOST(req('ap-exec-down', 'allow_once'), res)
    await done
    expect(approvalEventsFromApi()).toEqual([])
  })

  it('refuses a late answer to a tool card and closes the card as expired', async () => {
    // Past its deadline nothing is waiting on the card, so the answer would run
    // nothing. Saying ok would tell the caller it counted.
    seed('ap-late', 'tool', Date.now() - 1_000)
    const { res, done } = mockRes()
    toolsApprovalResolvePOST(req('ap-late', 'allow_once'), res)

    const answer = await done
    expect(answer.code).toBe(409)
    expect(answer.body).toMatchObject({
      error: 'approval expired',
      approval: { status: 'expired' },
    })
    expect(statusOf('ap-late')).toBe('expired')
    expect(approvalEventsFromApi()).toEqual([
      {
        kind: 'approval_resolved',
        data: {
          approvalId: 'ap-late',
          decision: 'expired',
          kind: 'tool',
          toolName: 'mcp__memory__save',
        },
      },
    ])
  })

  it('refuses an answer to a tool card that already expired', async () => {
    seed('ap-gone', 'tool')
    db.update(toolCallApprovals)
      .set({ status: 'expired', resolvedAt: Date.now() })
      .where(eq(toolCallApprovals.id, 'ap-gone'))
      .run()
    const { res, done } = mockRes()
    toolsApprovalResolvePOST(req('ap-gone', 'deny'), res)

    expect((await done).code).toBe(409)
    expect(statusOf('ap-gone')).toBe('expired')
    expect(approvalEventsFromApi()).toEqual([])
  })

  it('404s an id it has no card for instead of calling the Gateway', async () => {
    const { res, done } = mockRes()
    toolsApprovalResolvePOST(req('nope', 'deny'), res)
    expect((await done).code).toBe(404)
    expect(calls).toEqual([])
  })
})

// Who answered: the person a sign-in proxy vouched for (req.person, set only by
// the proxy identity lane from a token it verified), never a guess.
describe('who answered', () => {
  type Person = { id: string; name: string | null; role: string | null }
  const ADA: Person = { id: 'user-42', name: 'Ada', role: 'admin' }
  const asPerson = (id: string, decision: string, person: Person | null): Request =>
    ({
      params: { id },
      query: {},
      body: { decision },
      headers: DASHBOARD,
      person,
    }) as unknown as Request
  const resolvedByOf = (id: string): string | null | undefined =>
    db
      .select({ resolvedBy: toolCallApprovals.resolvedBy })
      .from(toolCallApprovals)
      .where(eq(toolCallApprovals.id, id))
      .get()?.resolvedBy

  it('records the person on a tool card and in its approval_resolved event', async () => {
    seed('ap-who', 'tool')
    const { res, done } = mockRes()
    toolsApprovalResolvePOST(asPerson('ap-who', 'deny', ADA), res)
    expect((await done).body).toMatchObject({ approval: { resolvedBy: JSON.stringify(ADA) } })

    expect(JSON.parse(resolvedByOf('ap-who') ?? 'null')).toEqual(ADA)
    expect(approvalEventsFromApi()).toEqual([
      {
        kind: 'approval_resolved',
        data: {
          approvalId: 'ap-who',
          decision: 'deny',
          kind: 'tool',
          toolName: 'mcp__memory__save',
          resolvedBy: ADA,
        },
      },
    ])
  })

  it('records no one when nothing vouched for the request, and ignores a body that claims someone', async () => {
    seed('ap-anon', 'tool')
    const { res, done } = mockRes()
    toolsApprovalResolvePOST(
      {
        params: { id: 'ap-anon' },
        query: {},
        body: { decision: 'allow_once', resolvedBy: ADA, person: ADA },
        headers: DASHBOARD,
      } as unknown as Request,
      res,
    )
    await done
    expect(resolvedByOf('ap-anon')).toBeNull()
    expect(approvalEventsFromApi()[0]?.data).not.toHaveProperty('resolvedBy')
  })

  it('a second answer cannot rename who answered first', async () => {
    seed('ap-twice', 'tool')
    const first = mockRes()
    toolsApprovalResolvePOST(asPerson('ap-twice', 'allow_once', ADA), first.res)
    await first.done
    const second = mockRes()
    toolsApprovalResolvePOST(
      asPerson('ap-twice', 'deny', { id: 'user-7', name: 'Bob', role: null }),
      second.res,
    )
    await second.done
    expect(JSON.parse(resolvedByOf('ap-twice') ?? 'null')).toEqual(ADA)
  })

  it('records the person on an exec card once the Gateway takes the answer', async () => {
    seed('ap-exec-who', 'exec')
    const { res, done } = mockRes()
    toolsApprovalResolvePOST(asPerson('ap-exec-who', 'allow_once', ADA), res)
    await done
    expect(JSON.parse(resolvedByOf('ap-exec-who') ?? 'null')).toEqual(ADA)
    expect(approvalEventsFromApi()[0]?.data).toMatchObject({ resolvedBy: ADA })
  })

  it('names no one on an exec card the Gateway refused or another answer had settled', async () => {
    failWith = 'gateway is down'
    seed('ap-exec-refused', 'exec')
    const refused = mockRes()
    toolsApprovalResolvePOST(asPerson('ap-exec-refused', 'deny', ADA), refused.res)
    await refused.done
    expect(resolvedByOf('ap-exec-refused')).toBeNull()

    failWith = 'APPROVAL_ALREADY_RESOLVED'
    seed('ap-exec-raced', 'exec')
    const raced = mockRes()
    toolsApprovalResolvePOST(asPerson('ap-exec-raced', 'deny', ADA), raced.res)
    expect((await raced.done).body).toMatchObject({ alreadyResolved: true })
    expect(resolvedByOf('ap-exec-raced')).toBeNull()
  })
})
