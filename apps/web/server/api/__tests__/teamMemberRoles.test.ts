// teamMemberRolesGET: each live team member's one-line role, for the board's New
// task suggestion. Read from SOUL.md with the lead's roster reader, so an OpenClaw
// agent, an agent with no persona, a teamless agent and an archived one are left out.

import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { agents, teams, type ClawbooDb } from '@clawboo/db'
import type { Request, Response } from 'express'

import { teamMemberRolesGET } from '../teamMemberRoles'
import { getDb, resetDb } from '../../lib/db'
import { writeRuntimeAgentFile } from '../../lib/agentSource/runtimeAgentFileStore'
import { writeNativeAgentFile } from '../../lib/runtimes/native/agentConfigStore'

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

describe('teamMemberRolesGET', () => {
  let home: string
  let prevHome: string | undefined
  let db: ClawbooDb

  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), 'clawboo-member-roles-'))
    await mkdir(path.join(home, '.clawboo'), { recursive: true })
    prevHome = process.env['HOME']
    process.env['HOME'] = home
    process.env['CLAWBOO_HOME'] = path.join(home, '.clawboo')
    db = getDb()
    const now = Date.now()
    db.insert(teams)
      .values({
        id: 'T',
        name: 'Team',
        icon: 'T',
        color: '#e94560',
        createdAt: now,
        updatedAt: now,
      })
      .run()
  })
  afterEach(async () => {
    resetDb()
    if (prevHome === undefined) delete process.env['HOME']
    else process.env['HOME'] = prevHome
    delete process.env['CLAWBOO_HOME']
    await rm(home, { recursive: true, force: true }).catch(() => {})
  })

  function seedAgent(
    id: string,
    runtime: string,
    teamId: string | null,
    extra: { archivedAt?: number } = {},
  ): void {
    const now = Date.now()
    db.insert(agents)
      .values({
        id,
        name: id,
        gatewayId: id,
        runtime,
        teamId,
        createdAt: now,
        updatedAt: now,
        ...extra,
      })
      .run()
  }

  it('returns the role from each team member’s SOUL.md', () => {
    seedAgent('writer', 'clawboo-native', 'T')
    writeNativeAgentFile(db, 'writer', 'SOUL.md', '## Role\n\nDrafts blog posts and launch notes.')
    seedAgent('coder', 'codex', 'T')
    writeRuntimeAgentFile(db, 'coder', 'SOUL.md', '- **Role**: Fixes failing tests')

    const { res, body, status } = fakeRes()
    teamMemberRolesGET({} as Request, res)

    expect(status()).toBe(200)
    expect(body()).toEqual({
      roles: { writer: 'Drafts blog posts and launch notes.', coder: 'Fixes failing tests' },
    })
  })

  it('leaves out OpenClaw, persona-less, teamless and archived agents', () => {
    seedAgent('scout', 'openclaw', 'T')
    seedAgent('blank', 'claude-code', 'T')
    seedAgent('loner', 'clawboo-native', null)
    writeNativeAgentFile(db, 'loner', 'SOUL.md', '## Role\n\nWorks alone on side projects.')
    seedAgent('gone', 'clawboo-native', 'T', { archivedAt: Date.now() })
    writeNativeAgentFile(db, 'gone', 'SOUL.md', '## Role\n\nWas archived last week.')

    const { res, body } = fakeRes()
    teamMemberRolesGET({} as Request, res)

    expect(body()).toEqual({ roles: {} })
  })
})
