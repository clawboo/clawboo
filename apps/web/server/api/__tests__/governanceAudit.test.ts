// Governance audit REST: the `since` time-window filter and the `circuit_break`
// event-type in the allow-list. Sandbox HOME so the sqlite db lands in a
// throwaway dir.

import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { appendAudit, createDb } from '@clawboo/db'
import type { Request, Response } from 'express'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { getDbPath } from '../../lib/db'
import { governanceAuditGET } from '../governanceAudit'

function mockRes(): { res: Response; status: () => number; body: () => unknown } {
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
  return { res, status: () => code, body: () => payload }
}
const req = (over: Partial<Request> = {}): Request =>
  ({ params: {}, query: {}, body: {}, ...over }) as unknown as Request

const auditOf = (b: unknown): { eventType: string }[] =>
  (b as { audit: { eventType: string }[] }).audit

describe('governance audit REST', () => {
  let home: string
  let prevHome: string | undefined

  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), 'clawboo-audit-rest-'))
    await mkdir(path.join(home, '.openclaw', 'clawboo'), { recursive: true })
    prevHome = process.env['HOME']
    process.env['HOME'] = home
  })
  afterEach(async () => {
    if (prevHome === undefined) delete process.env['HOME']
    else process.env['HOME'] = prevHome
    await rm(home, { recursive: true, force: true }).catch(() => {})
  })

  it('filters by circuit_break event type and a future `since` cutoff', () => {
    const db = createDb(getDbPath())
    appendAudit(db, { eventType: 'budget', agentId: 'a1', summary: { note: 'spend' } })
    appendAudit(db, {
      eventType: 'circuit_break',
      agentId: 'a1',
      summary: { reason: 'no-progress' },
    })

    const all = mockRes()
    governanceAuditGET(req(), all.res)
    expect(all.status()).toBe(200)
    expect(auditOf(all.body()).length).toBeGreaterThanOrEqual(2)

    const breaks = mockRes()
    governanceAuditGET(
      req({ query: { eventType: 'circuit_break' } as Request['query'] }),
      breaks.res,
    )
    expect(auditOf(breaks.body()).every((r) => r.eventType === 'circuit_break')).toBe(true)
    expect(auditOf(breaks.body()).length).toBe(1)

    const future = mockRes()
    governanceAuditGET(
      req({ query: { since: String(Date.now() + 100_000) } as Request['query'] }),
      future.res,
    )
    expect(auditOf(future.body()).length).toBe(0)
  })
})
