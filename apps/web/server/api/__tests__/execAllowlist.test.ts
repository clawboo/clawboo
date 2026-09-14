// The three answers this route must keep apart.
//
// "This Boo has no standing grants", "clawboo could not read the policy", and
// "there is no policy document at all" look identical once they reach a UI as an
// empty array, and only one of them is true. The first is a safety claim; the
// second is a document whose grants are still on disk and still being enforced.
// So the unreadable branch carries NO `entries` key at all, because a client that
// destructures with a default of `[]` would quietly print the reassuring version
// of the wrong one.

import { agents, createDb, type ClawbooDb } from '@clawboo/db'
import type { Request, Response } from 'express'
import { beforeEach, describe, expect, it, vi } from 'vitest'

let db: ClawbooDb
let readResult: unknown
const calls: { method: string; params?: unknown }[] = []
let failWith: string | null = null

vi.mock('../../lib/db', () => ({ getDb: () => db }))
vi.mock('../../lib/agentSource/openclawExecAllowlistRead', () => ({
  readOpenClawExecAllowlist: () => readResult,
}))
vi.mock('../../lib/agentSource', () => ({
  getRegistry: () => ({
    source: {
      operatorCall: async (method: string, params?: unknown) => {
        calls.push({ method, params })
        if (failWith) throw new Error(failWith)
        if (method === 'exec.approvals.get') {
          return {
            exists: true,
            hash: 'h1',
            file: { version: 1, agents: { 'oc-boo': { allowlist: [] } } },
          }
        }
        return {
          exists: true,
          hash: 'h2',
          file: { version: 1, agents: { 'oc-boo': { allowlist: [] } } },
        }
      },
    },
  }),
}))

const { execAllowlistGET, execAllowlistRevokePOST } = await import('../execAllowlist')

function mockRes(): {
  res: Response
  done: Promise<{ code: number; body: Record<string, unknown> }>
} {
  let code = 200
  let settle: (v: { code: number; body: Record<string, unknown> }) => void = () => {}
  const done = new Promise<{ code: number; body: Record<string, unknown> }>((r) => {
    settle = r
  })
  const res = {
    status(c: number) {
      code = c
      return this
    },
    json(b: unknown) {
      settle({ code, body: (b ?? {}) as Record<string, unknown> })
      return this
    },
  } as unknown as Response
  return { res, done }
}

const getReq = (agentId: string): Request =>
  ({ params: {}, query: { agentId }, body: {} }) as unknown as Request
const postReq = (body: unknown): Request => ({ params: {}, query: {}, body }) as unknown as Request

function seedAgent(id: string, runtime: string, sourceAgentId: string | null) {
  db.insert(agents)
    .values({
      id,
      name: id,
      gatewayId: id,
      runtime,
      sourceAgentId,
      status: 'idle',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    .run()
}

beforeEach(() => {
  db = createDb(':memory:')
  calls.length = 0
  failWith = null
  readResult = { state: 'ok', snapshot: { entries: [], wildcard: [], duplicatedInWildcard: [] } }
})

describe('GET /api/exec-allowlist', () => {
  it('returns the grants for an OpenClaw Boo', async () => {
    seedAgent('boo', 'openclaw', 'oc-boo')
    readResult = {
      state: 'ok',
      snapshot: {
        entries: [{ key: 'k', pattern: '/bin/echo' }],
        wildcard: [],
        duplicatedInWildcard: [],
      },
    }
    const { res, done } = mockRes()
    execAllowlistGET(getReq('boo'), res)
    const out = await done
    expect(out.code).toBe(200)
    expect(out.body['state']).toBe('ok')
    expect(out.body['entries']).toHaveLength(1)
  })

  it('does NOT send an entries key when the policy cannot be read', async () => {
    // The load-bearing assertion. A client doing `entries ?? []` would render
    // "no standing grants" over a document whose grants are still enforced.
    seedAgent('boo', 'openclaw', 'oc-boo')
    readResult = {
      state: 'unreadable',
      reason: 'bad json',
      knownAgentCount: 3,
      knownAllowlistCount: 7,
    }
    const { res, done } = mockRes()
    execAllowlistGET(getReq('boo'), res)
    const out = await done
    expect(out.code).toBe(502)
    expect(out.body).not.toHaveProperty('entries')
    expect(out.body['knownAllowlistCount']).toBe(7)
  })

  it('separates "no document at all" from "unreadable"', async () => {
    seedAgent('boo', 'openclaw', 'oc-boo')
    readResult = { state: 'absent' }
    const { res, done } = mockRes()
    execAllowlistGET(getReq('boo'), res)
    const out = await done
    expect(out.code).toBe(200)
    expect(out.body['state']).toBe('absent')
    expect(out.body).not.toHaveProperty('entries')
  })

  it('says not-applicable for a runtime that keeps no such document', async () => {
    // A native Boo has no Gateway policy. An empty list would imply it has one.
    seedAgent('native', 'clawboo-native', 'native')
    const { res, done } = mockRes()
    execAllowlistGET(getReq('native'), res)
    const out = await done
    expect(out.body['state']).toBe('not-applicable')
    expect(out.body).not.toHaveProperty('entries')
  })

  it('404s an agent it does not know', async () => {
    const { res, done } = mockRes()
    execAllowlistGET(getReq('ghost'), res)
    expect((await done).code).toBe(404)
  })
})

describe('POST /api/exec-allowlist/revoke', () => {
  it("resolves clawboo's row id to the Gateway's own id", async () => {
    // The Gateway keys this document by ITS ids. Sending clawboo's would edit a
    // bucket that does not exist, which fails silently because a policy for a
    // nonexistent agent is simply never consulted.
    seedAgent('boo', 'openclaw', 'oc-boo')
    const { res, done } = mockRes()
    await execAllowlistRevokePOST(postReq({ agentId: 'boo', keys: ['k'] }), res)
    const out0 = await done
    // Proof it used the Gateway's id: the fixture's only bucket is 'oc-boo', and a
    // lookup under clawboo's 'boo' would have come back as no-such-agent instead.
    expect(out0.body['outcome']).toBe('already-absent')
    expect(calls.some((c) => c.method === 'exec.approvals.get')).toBe(true)
  })

  it('reports "already gone" as its own outcome, not as success', async () => {
    seedAgent('boo', 'openclaw', 'oc-boo')
    const { res, done } = mockRes()
    await execAllowlistRevokePOST(postReq({ agentId: 'boo', keys: ['missing'] }), res)
    const out = await done
    expect(out.code).toBe(409)
    expect(out.body['outcome']).toBe('already-absent')
  })

  it('refuses a runtime that keeps no standing grants', async () => {
    seedAgent('native', 'clawboo-native', 'native')
    const { res, done } = mockRes()
    await execAllowlistRevokePOST(postReq({ agentId: 'native', keys: ['k'] }), res)
    expect((await done).code).toBe(400)
    expect(calls).toEqual([])
  })

  it('answers 502 with the Gateway’s own words when it refuses', async () => {
    seedAgent('boo', 'openclaw', 'oc-boo')
    failWith = 'exec approvals are disabled on this node'
    const { res, done } = mockRes()
    await execAllowlistRevokePOST(postReq({ agentId: 'boo', keys: ['k'] }), res)
    const out = await done
    expect(out.code).toBe(502)
    expect(String(out.body['error'])).toContain('disabled on this node')
  })

  it('rejects a body with no keys rather than writing the document', async () => {
    seedAgent('boo', 'openclaw', 'oc-boo')
    const { res, done } = mockRes()
    await execAllowlistRevokePOST(postReq({ agentId: 'boo', keys: [] }), res)
    expect((await done).code).toBe(400)
    expect(calls).toEqual([])
  })
})
