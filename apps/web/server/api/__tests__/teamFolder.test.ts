// The team folder (`<clawboo home>/workspaces/<teamId>`, where Claude Code /
// Codex / Hermes runs start with no worktree) at the API: deleting a team
// removes it, and an agent's Workspace tab can list and read it read-only. The
// folder is always resolved from the agent's or team's row, never the request.

import { mkdir, mkdtemp, rm, stat, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { agents, teams, type ClawbooDb } from '@clawboo/db'
import type { Request, Response } from 'express'

import { getDb, resetDb } from '../../lib/db'
import { agentTeamFolderFileGET, agentTeamFolderTreeGET, agentWorkspacesGET } from '../board'
import { teamsDELETE } from '../teams'

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

function req(params: Record<string, string>, query: Record<string, string> = {}): Request {
  return { params, body: {}, query, headers: {} } as unknown as Request
}

describe('team folder API', () => {
  let home: string
  let clawbooHome: string
  let prevHome: string | undefined
  let prevClawbooHome: string | undefined
  let db: ClawbooDb

  const folder = (segment: string): string => path.join(clawbooHome, 'workspaces', segment)

  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), 'clawboo-team-folder-'))
    clawbooHome = path.join(home, '.clawboo')
    await mkdir(clawbooHome, { recursive: true })
    prevHome = process.env['HOME']
    prevClawbooHome = process.env['CLAWBOO_HOME']
    process.env['HOME'] = home
    process.env['CLAWBOO_HOME'] = clawbooHome
    db = getDb()
    const now = Date.now()
    db.insert(teams)
      .values({ id: 'T', name: 'T', icon: 'T', color: '#000', createdAt: now, updatedAt: now })
      .run()
    const seed: Array<{ id: string; runtime: string; teamId: string | null }> = [
      { id: 'cx', runtime: 'codex', teamId: 'T' },
      { id: 'nv', runtime: 'clawboo-native', teamId: 'T' },
      { id: 'oc', runtime: 'openclaw', teamId: 'T' },
      { id: 'solo', runtime: 'claude-code', teamId: null },
    ]
    for (const a of seed) {
      db.insert(agents)
        .values({ ...a, name: a.id, gatewayId: a.id, createdAt: now, updatedAt: now })
        .run()
    }
  })

  afterEach(async () => {
    resetDb()
    if (prevHome === undefined) delete process.env['HOME']
    else process.env['HOME'] = prevHome
    if (prevClawbooHome === undefined) delete process.env['CLAWBOO_HOME']
    else process.env['CLAWBOO_HOME'] = prevClawbooHome
    await rm(home, { recursive: true, force: true }).catch(() => {})
  })

  describe('DELETE /api/teams/:id', () => {
    it("removes the team's folder and the files in it", async () => {
      await mkdir(path.join(folder('T'), 'notes'), { recursive: true })
      await writeFile(path.join(folder('T'), 'notes', 'report.md'), '# findings')

      const r = fakeRes()
      await teamsDELETE(req({ id: 'T' }), r.res)

      expect(r.body()).toEqual({ ok: true, folderRemoved: true })
      await expect(stat(folder('T'))).rejects.toThrow()
    })

    it('succeeds for a team that never had a folder', async () => {
      const r = fakeRes()
      await teamsDELETE(req({ id: 'T' }), r.res)

      expect(r.body()).toEqual({ ok: true, folderRemoved: true })
    })

    it('never removes another folder for an id that is not a team', async () => {
      await mkdir(folder('_no-team'), { recursive: true })
      await writeFile(path.join(folder('_no-team'), 'keep.md'), 'keep')

      const r = fakeRes()
      await teamsDELETE(req({ id: '_no-team' }), r.res)

      expect(r.body()).toEqual({ ok: true, folderRemoved: false })
      expect((await stat(path.join(folder('_no-team'), 'keep.md'))).isFile()).toBe(true)
    })

    it.skipIf(process.platform === 'win32')(
      'removes a symlink inside the folder without touching its target',
      async () => {
        const outside = path.join(home, 'outside.txt')
        await writeFile(outside, 'not ours')
        await mkdir(folder('T'), { recursive: true })
        await symlink(outside, path.join(folder('T'), 'link.txt'))

        await teamsDELETE(req({ id: 'T' }), fakeRes().res)

        expect((await stat(outside)).isFile()).toBe(true)
      },
    )
  })

  describe('GET /api/agents/:agentId/workspaces teamFolder', () => {
    it('names the team folder for a coding agent, onDisk once it exists', async () => {
      const before = fakeRes()
      agentWorkspacesGET(req({ agentId: 'cx' }), before.res)
      expect((before.body() as { teamFolder: unknown }).teamFolder).toEqual({
        teamId: 'T',
        path: folder('T'),
        onDisk: false,
      })

      await mkdir(folder('T'), { recursive: true })
      const after = fakeRes()
      agentWorkspacesGET(req({ agentId: 'cx' }), after.res)
      expect((after.body() as { teamFolder: { onDisk: boolean } }).teamFolder.onDisk).toBe(true)
    })

    it('names the shared _no-team folder for a coding agent with no team', () => {
      const r = fakeRes()
      agentWorkspacesGET(req({ agentId: 'solo' }), r.res)
      expect((r.body() as { teamFolder: unknown }).teamFolder).toEqual({
        teamId: null,
        path: folder('_no-team'),
        onDisk: false,
      })
    })

    it('names the same team folder for a Clawboo Native agent', () => {
      const r = fakeRes()
      agentWorkspacesGET(req({ agentId: 'nv' }), r.res)
      expect((r.body() as { teamFolder: { path: string } }).teamFolder.path).toBe(folder('T'))
    })

    it('is null for an OpenClaw agent and an unknown agent', () => {
      for (const agentId of ['oc', 'nobody']) {
        const r = fakeRes()
        agentWorkspacesGET(req({ agentId }), r.res)
        expect((r.body() as { teamFolder: unknown }).teamFolder).toBeNull()
      }
    })
  })

  describe('tree + file routes', () => {
    beforeEach(async () => {
      await mkdir(path.join(folder('T'), 'docs'), { recursive: true })
      await writeFile(path.join(folder('T'), 'docs', 'plan.md'), 'step one')
    })

    it("lists and reads the agent's team folder", async () => {
      const tree = fakeRes()
      await agentTeamFolderTreeGET(req({ agentId: 'cx' }, { dir: 'docs' }), tree.res)
      expect(tree.body()).toMatchObject({
        ok: true,
        dir: 'docs',
        entries: [{ name: 'plan.md', kind: 'file' }],
      })

      const file = fakeRes()
      await agentTeamFolderFileGET(req({ agentId: 'cx' }, { path: 'docs/plan.md' }), file.res)
      expect(file.body()).toMatchObject({ ok: true, binary: false, content: 'step one' })
    })

    it('refuses a path that leaves the folder', async () => {
      await writeFile(path.join(clawbooHome, 'secret.txt'), 'no')
      const r = fakeRes()
      await agentTeamFolderFileGET(req({ agentId: 'cx' }, { path: '../../secret.txt' }), r.res)
      expect(r.status()).toBe(400)
    })

    it('answers 404 for an agent with no folder, and for one not created yet', async () => {
      const gateway = fakeRes()
      await agentTeamFolderTreeGET(req({ agentId: 'oc' }), gateway.res)
      expect(gateway.status()).toBe(404)

      const notYet = fakeRes()
      await agentTeamFolderTreeGET(req({ agentId: 'solo' }), notYet.res)
      expect(notYet.status()).toBe(404)
      expect((notYet.body() as { reason: string }).reason).toBe('gone')
    })
  })
})
