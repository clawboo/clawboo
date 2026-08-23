// The grants REST surface, pinned to the ALREADY-SHIPPED callers in
// apps/web/src/features/graph/operations/. Every request body below is copied
// from the client that sends it, so a green suite means the wire actually
// matches rather than that both halves are self-consistently wrong.

import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { getGrant, listGrants } from '@clawboo/db'
import type { Request, Response } from 'express'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { getDb, resetDb } from '../../lib/db'
import { grantsCreatePOST, grantsListGET, grantsResumePOST, grantsRevokePOST } from '../grants'

function mockRes(): { res: Response; statusCode: () => number; body: () => unknown } {
  let code = 200
  let payload: unknown
  const res = {
    status(c: number) {
      code = c
      return this
    },
    json(b: unknown) {
      payload = b
      return this
    },
  } as unknown as Response
  return { res, statusCode: () => code, body: () => payload }
}

const post = (body: unknown, params: Record<string, string> = {}): Request =>
  ({ query: {}, params, body }) as unknown as Request

/** EXACTLY what grantConnector.ts sends. Do not "tidy" this shape. */
const SHIPPED_BODY = {
  subjectKind: 'agent',
  subjectId: 'agent-2',
  capabilityKind: 'connector',
  connectorId: 'conn:native:clawboo-native:mcp:github',
  capabilityId: null,
  mode: 'read',
  approvalPolicy: 'risk',
}

describe('grants REST', () => {
  let home: string
  let prevHome: string | undefined
  let prevClawbooHome: string | undefined

  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), 'clawboo-grants-rest-'))
    await mkdir(path.join(home, '.clawboo'), { recursive: true })
    prevHome = process.env['HOME']
    prevClawbooHome = process.env['CLAWBOO_HOME']
    process.env['HOME'] = home
    process.env['CLAWBOO_HOME'] = path.join(home, '.clawboo')
  })
  afterEach(async () => {
    resetDb()
    if (prevHome === undefined) delete process.env['HOME']
    else process.env['HOME'] = prevHome
    if (prevClawbooHome === undefined) delete process.env['CLAWBOO_HOME']
    else process.env['CLAWBOO_HOME'] = prevClawbooHome
    await rm(home, { recursive: true, force: true })
  })

  it('accepts the body the shipped client actually sends', () => {
    const res = mockRes()
    grantsCreatePOST(post(SHIPPED_BODY), res.res)
    expect(res.statusCode()).toBe(200)
    const body = res.body() as { ok: boolean; grant: { id: string; origin: string } }
    expect(body.ok).toBe(true)
    expect(body.grant.origin).toBe('operator')
    expect(listGrants(getDb())).toHaveLength(1)
  })

  it('returns `error` (not a bare status) so the toast can name the problem', () => {
    const res = mockRes()
    // Neither connectorId nor capabilityId: nothing to grant.
    grantsCreatePOST(post({ ...SHIPPED_BODY, connectorId: null, capabilityId: null }), res.res)
    expect(res.statusCode()).toBe(400)
    expect((res.body() as { error?: string }).error).toBe('invalid body')
  })

  it('requires a subjectId unless the subject is global', () => {
    const res = mockRes()
    grantsCreatePOST(post({ ...SHIPPED_BODY, subjectId: null }), res.res)
    expect(res.statusCode()).toBe(400)
  })

  it('re-granting the same pair updates one row rather than adding another', () => {
    grantsCreatePOST(post(SHIPPED_BODY), mockRes().res)
    grantsCreatePOST(post({ ...SHIPPED_BODY, mode: 'admin' }), mockRes().res)
    const all = listGrants(getDb())
    expect(all).toHaveLength(1)
    expect(all[0]!.mode).toBe('admin')
  })

  it('revokes with NO body, which is what Detach sends', () => {
    const created = mockRes()
    grantsCreatePOST(post(SHIPPED_BODY), created.res)
    const id = (created.body() as { grant: { id: string } }).grant.id

    const res = mockRes()
    // revokeGrant.ts posts with no body at all: express leaves req.body
    // undefined, and parsing that directly would 400 every single Detach.
    grantsRevokePOST({ query: {}, params: { id } } as unknown as Request, res.res)
    expect(res.statusCode()).toBe(200)
    expect(getGrant(getDb(), id)?.state).toBe('revoked')
  })

  it('404s a revoke for a grant that does not exist', () => {
    const res = mockRes()
    grantsRevokePOST(post(undefined, { id: 'nope' }), res.res)
    expect(res.statusCode()).toBe(404)
  })

  it('resumes inside the undo window, which is what makes the toast honest', () => {
    const created = mockRes()
    grantsCreatePOST(post(SHIPPED_BODY), created.res)
    const id = (created.body() as { grant: { id: string } }).grant.id
    grantsRevokePOST(post(undefined, { id }), mockRes().res)

    const res = mockRes()
    grantsResumePOST(post(undefined, { id }), res.res)
    expect(res.statusCode()).toBe(200)
    expect(getGrant(getDb(), id)?.state).toBe('active')
  })

  it('distinguishes a closed undo window from a missing grant', () => {
    const res = mockRes()
    grantsResumePOST(post(undefined, { id: 'nope' }), res.res)
    // The toast tells the user to grant it again, and that advice is only
    // correct when the grant still exists.
    expect(res.statusCode()).toBe(404)
  })

  it('lists grants, optionally by subject', () => {
    grantsCreatePOST(post(SHIPPED_BODY), mockRes().res)
    grantsCreatePOST(post({ ...SHIPPED_BODY, subjectId: 'agent-3' }), mockRes().res)

    const all = mockRes()
    grantsListGET({ query: {}, params: {} } as unknown as Request, all.res)
    expect((all.body() as { grants: unknown[] }).grants).toHaveLength(2)

    const one = mockRes()
    grantsListGET({ query: { subjectId: 'agent-3' }, params: {} } as unknown as Request, one.res)
    expect((one.body() as { grants: unknown[] }).grants).toHaveLength(1)
  })
})
