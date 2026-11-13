// Deleting a team with agents on their own OS user (CLAWBOO_AGENT_USER): its
// folder is agent space, owned by the agent user, so the agent host removes it.
// The server could not, and must not try to as itself.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { teams } from '@clawboo/db'
import type { Request, Response } from 'express'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { setActiveAgentHost } from '../../lib/agentUser/state'
import { startInProcessHost, type InProcessHost } from '../../lib/agentUser/__tests__/inProcessHost'
import { getDb, resetDb } from '../../lib/db'
import { teamWorkdirPath } from '../../lib/runtimes/teamWorkdir'
import { teamsDELETE } from '../teams'

const posix = process.platform !== 'win32'

function fakeRes(): { res: Response; body: () => unknown } {
  let body: unknown
  const res = {
    status() {
      return this
    },
    json(b: unknown) {
      body = b
      return this
    },
  } as unknown as Response
  return { res, body: () => body }
}

const req = (id: string): Request =>
  ({
    params: { id },
    body: {},
    query: {},
    headers: { 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors' },
  }) as unknown as Request

let tmp: string
let active: InProcessHost | null = null

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'team-folder-agent-')))
  fs.mkdirSync(path.join(tmp, '.clawboo'))
  vi.stubEnv('HOME', tmp)
  vi.stubEnv('CLAWBOO_HOME', path.join(tmp, '.clawboo'))
  const now = Date.now()
  getDb()
    .insert(teams)
    .values({ id: 'T', name: 'T', icon: 'T', color: '#000', createdAt: now, updatedAt: now })
    .run()
})

afterEach(() => {
  resetDb()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  setActiveAgentHost(null)
  active?.client.close()
  active = null
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe.runIf(posix)('DELETE /api/teams/:id with agents on their own OS user', () => {
  it("removes the team's folder through the agent host", async () => {
    const folder = teamWorkdirPath('T')
    fs.mkdirSync(path.join(folder, 'notes'), { recursive: true })
    fs.writeFileSync(path.join(folder, 'notes', 'report.md'), '# findings')

    vi.stubEnv('CLAWBOO_AGENT_USER', 'clawboo-agent')
    const h = startInProcessHost()
    active = h
    const hello = await h.client.waitForHello()
    setActiveAgentHost({
      client: h.client,
      hello: { ...hello, home: tmp },
      config: { user: 'clawboo-agent', switch: 'sudo', socket: null },
    })
    const removed: string[] = []
    const request = h.client.request.bind(h.client)
    vi.spyOn(h.client, 'request').mockImplementation((r, opts) => {
      if (r.op === 'fs.rm') removed.push(r.path)
      return request(r, opts)
    })

    const r = fakeRes()
    await teamsDELETE(req('T'), r.res)

    expect(r.body()).toEqual({ ok: true, folderRemoved: true })
    // The team's folder, then the work check's history of it, which lives in
    // the work folder too with agents on their own OS user.
    expect(removed).toEqual([
      folder,
      path.join(path.dirname(path.dirname(folder)), 'team-history', 'T.git'),
    ])
    expect(fs.existsSync(folder)).toBe(false)
  })
})
