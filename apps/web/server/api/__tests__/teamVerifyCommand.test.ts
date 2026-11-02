// The team verify command: the check a person sets for a team, which the
// verification gate runs in place of the command in a worktree's init.sh.

import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { teams } from '@clawboo/db'
import type { Request, Response } from 'express'

import { teamVerifyCommandGET, teamVerifyCommandPUT } from '../teamVerifyCommand'
import { getDb, resetDb } from '../../lib/db'
import { readTeamVerifyCommand } from '../../lib/verification/teamVerifyCommand'

function fakeRes(): { res: Response; body: () => unknown; status: () => number } {
  let status = 200
  let body: unknown
  const res = {
    status(c: number) {
      status = c
      return this
    },
    json(b: unknown) {
      body = b
      return this
    },
  } as unknown as Response
  return { res, body: () => body, status: () => status }
}

const req = (teamId: string, body?: unknown) => ({ params: { teamId }, body }) as unknown as Request

describe('team verify command API', () => {
  let home: string
  let prevHome: string | undefined

  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), 'clawboo-verify-cmd-'))
    await mkdir(path.join(home, '.clawboo'), { recursive: true })
    prevHome = process.env['HOME']
    process.env['HOME'] = home
    process.env['CLAWBOO_HOME'] = path.join(home, '.clawboo')
    getDb()
      .insert(teams)
      .values({ id: 'team-1', name: 'Team', icon: 'x', color: '#000', createdAt: 1, updatedAt: 1 })
      .run()
  })
  afterEach(async () => {
    resetDb()
    if (prevHome === undefined) delete process.env['HOME']
    else process.env['HOME'] = prevHome
    delete process.env['CLAWBOO_HOME']
    await rm(home, { recursive: true, force: true }).catch(() => {})
  })

  it('stores a trimmed command, reads it back, and clears it with an empty string', () => {
    const put = fakeRes()
    teamVerifyCommandPUT(req('team-1', { command: '  pnpm test  ' }), put.res)
    expect(put.body()).toEqual({ command: 'pnpm test' })
    expect(readTeamVerifyCommand(getDb(), 'team-1')).toBe('pnpm test')

    const get = fakeRes()
    teamVerifyCommandGET(req('team-1'), get.res)
    expect(get.body()).toEqual({ command: 'pnpm test' })

    teamVerifyCommandPUT(req('team-1', { command: '' }), fakeRes().res)
    expect(readTeamVerifyCommand(getDb(), 'team-1')).toBeNull()
  })

  it('refuses a non-string, multi-line or oversized command', () => {
    for (const body of [{}, { command: 42 }, { command: 'a\nb' }, { command: 'x'.repeat(2001) }]) {
      const r = fakeRes()
      teamVerifyCommandPUT(req('team-1', body), r.res)
      expect(r.status()).toBe(400)
    }
    expect(readTeamVerifyCommand(getDb(), 'team-1')).toBeNull()
  })

  it('refuses a team that does not exist', () => {
    const r = fakeRes()
    teamVerifyCommandPUT(req('no-such-team', { command: 'pnpm test' }), r.res)
    expect(r.status()).toBe(404)
    expect(readTeamVerifyCommand(getDb(), 'no-such-team')).toBeNull()
  })
})
