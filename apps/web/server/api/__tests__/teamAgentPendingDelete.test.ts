// teamAgentPOST refuses an OpenClaw agent whose delete is still pending.
//
// An OpenClaw agent deleted while its Gateway was down stays listed by the
// Gateway until the server's next sync deletes it there. A browser that reads
// that list could still try to put the agent into a team (the bootstrap homes
// teamless OpenClaw agents), and the route's upsert would then re-create the
// deleted row, in a team. The route refuses instead.

import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { agents, setSetting, teams, type ClawbooDb } from '@clawboo/db'
import { eq } from 'drizzle-orm'
import type { Request, Response } from 'express'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { getDb, resetDb } from '../../lib/db'
import { teamAgentPOST } from '../teams'

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

describe('teamAgentPOST with a pending OpenClaw delete', () => {
  let home: string
  let prevHome: string | undefined
  let db: ClawbooDb

  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), 'clawboo-team-agent-pending-'))
    await mkdir(path.join(home, '.clawboo'), { recursive: true })
    prevHome = process.env['HOME']
    process.env['HOME'] = home
    process.env['CLAWBOO_HOME'] = path.join(home, '.clawboo')
    db = getDb()
    const now = Date.now()
    db.insert(teams)
      .values({ id: 't1', name: 't1', icon: '👻', color: '#fff', createdAt: now, updatedAt: now })
      .run()
  })

  afterEach(async () => {
    // Close BEFORE removing the dir: Windows refuses to remove a directory
    // that still holds an open file. (#140)
    resetDb()
    if (prevHome === undefined) delete process.env['HOME']
    else process.env['HOME'] = prevHome
    delete process.env['CLAWBOO_HOME']
    await rm(home, { recursive: true, force: true }).catch(() => {})
  })

  async function assign(agentId: string) {
    const r = mockRes()
    await teamAgentPOST(
      { params: { id: 't1' }, query: {}, body: { agentId } } as unknown as Request,
      r.res,
    )
    return r
  }

  it('refuses the agent and leaves its row deleted', async () => {
    setSetting(db, 'agent-source:openclaw:pendingDelete:oc-gone', 'oc-gone')
    const r = await assign('oc-gone')
    expect(r.status()).toBe(409)
    expect(db.select().from(agents).where(eq(agents.id, 'oc-gone')).get()).toBeUndefined()
  })

  it('still assigns an agent with no pending delete', async () => {
    const r = await assign('oc-live')
    expect(r.status()).toBe(200)
    expect(db.select().from(agents).where(eq(agents.id, 'oc-live')).get()?.teamId).toBe('t1')
  })
})
