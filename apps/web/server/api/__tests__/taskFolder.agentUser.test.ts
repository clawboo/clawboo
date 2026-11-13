// A task's own folder with agents on their own OS user (CLAWBOO_AGENT_USER).
//
// The folder is then the agent user's: the server cannot see into it, and must
// not open a file there as itself. Every look the task-folder readers make (is
// it on disk, does it hold files, is any part of it a link, what is its real
// path) and every listing and read goes to the agent host. The host here is
// served in this process and runs as the test's own user, so files still work;
// what these tests prove is that each request went through it, and that the
// link checks the readers make with the setting off still refuse with it on.

import { realpathSync } from 'node:fs'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { agents, createTask, tasks, teams, type ClawbooDb } from '@clawboo/db'
import { eq } from 'drizzle-orm'
import type { Request, Response } from 'express'

import type { HostRequest } from '../../lib/agentUser/protocol'
import { setActiveAgentHost } from '../../lib/agentUser/state'
import { startInProcessHost, type InProcessHost } from '../../lib/agentUser/__tests__/inProcessHost'
import { getDb, resetDb } from '../../lib/db'
import { realTaskFolder, resolveWorkspaceRelPath, WorkspacePathError } from '../../lib/workspaceFs'
import { resolvePreviewFile } from '../../lib/workspacePreview'
import {
  agentWorkspacesGET,
  boardTaskFolderFileGET,
  boardTaskFolderTreeGET,
  boardWorkspaceDetailGET,
} from '../board'

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
  return {
    params,
    body: {},
    query,
    headers: { 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors' },
  } as unknown as Request
}

const posix = process.platform !== 'win32'

describe.runIf(posix)('task folder API with agent isolation on', { timeout: 60_000 }, () => {
  let home: string
  let prevHome: string | undefined
  let prevClawbooHome: string | undefined
  let db: ClawbooDb
  let teamsRoot: string
  let h: InProcessHost
  let ops: Array<{ op: string; path?: string }>

  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), 'clawboo-task-folder-agent-'))
    const clawbooHome = path.join(home, '.clawboo')
    teamsRoot = path.join(realpathSync.native(home), '.clawboo-work', 'teams')
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
    db.insert(agents)
      .values({
        id: 'cx',
        name: 'cx',
        gatewayId: 'cx',
        runtime: 'codex',
        teamId: 'T',
        createdAt: now,
        updatedAt: now,
      })
      .run()

    vi.stubEnv('CLAWBOO_AGENT_USER', 'clawboo-agent')
    h = startInProcessHost()
    const hello = await h.client.waitForHello()
    setActiveAgentHost({
      client: h.client,
      hello,
      config: { user: 'clawboo-agent', switch: 'sudo', socket: null },
    })
    ops = []
    const origRequest = h.client.request.bind(h.client) as InProcessHost['client']['request']
    vi.spyOn(h.client, 'request').mockImplementation(((
      r: HostRequest,
      opts?: { timeoutMs?: number },
    ) => {
      ops.push({ op: r.op, ...('path' in r ? { path: r.path } : {}) })
      return origRequest(r, opts)
    }) as InProcessHost['client']['request'])
  })

  afterEach(async () => {
    setActiveAgentHost(null)
    h.client.close()
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
    resetDb()
    if (prevHome === undefined) delete process.env['HOME']
    else process.env['HOME'] = prevHome
    if (prevClawbooHome === undefined) delete process.env['CLAWBOO_HOME']
    else process.env['CLAWBOO_HOME'] = prevClawbooHome
    await rm(home, { recursive: true, force: true })
  })

  function task(
    title: string,
    fields: Partial<{ assigneeAgentId: string; status: string; updatedAt: number }> = {},
  ): string {
    const id = createTask(db, { title, status: 'todo', teamId: 'T' }).id
    if (Object.keys(fields).length > 0) {
      db.update(tasks)
        .set(fields as Partial<typeof tasks.$inferInsert>)
        .where(eq(tasks.id, id))
        .run()
    }
    return id
  }

  async function folderWith(taskId: string, files: Record<string, string> = {}): Promise<string> {
    const dir = path.join(teamsRoot, 'T', 'tasks', taskId)
    await mkdir(dir, { recursive: true })
    for (const [name, body] of Object.entries(files)) await writeFile(path.join(dir, name), body)
    return dir
  }

  it('lists and reads the folder of a task through the host', async () => {
    const id = task('Write the brief')
    const dir = await folderWith(id, { 'brief.md': '# Brief' })

    const tree = fakeRes()
    await boardTaskFolderTreeGET(req({ taskId: id }), tree.res)
    expect(tree.status()).toBe(200)
    expect(tree.body()).toMatchObject({ ok: true, entries: [{ name: 'brief.md', kind: 'file' }] })

    const file = fakeRes()
    await boardTaskFolderFileGET(req({ taskId: id }, { path: 'brief.md' }), file.res)
    expect(file.status()).toBe(200)
    expect(file.body()).toMatchObject({ ok: true, binary: false, content: '# Brief' })

    // The folder's real path and every look came from the host.
    expect(ops).toContainEqual({ op: 'fs.realpath', path: dir })
    expect(ops).toContainEqual({ op: 'fs.list', path: dir })
    expect(ops).toContainEqual({ op: 'fs.read', path: path.join(dir, 'brief.md') })
  })

  it('tells the drawer about the folder, asking the host', async () => {
    const id = task('Write the brief')
    const dir = await folderWith(id, { 'notes.md': 'n' })

    const out = fakeRes()
    await boardWorkspaceDetailGET(req({ taskId: id }), out.res)
    expect(out.body()).toMatchObject({
      ok: false,
      reason: 'no_workspace',
      taskFolder: { path: dir, onDisk: true, holdsFiles: true },
    })
    expect(ops).toContainEqual({ op: 'fs.stat', path: dir })
    expect(ops).toContainEqual({ op: 'fs.list', path: dir })
  })

  it("lists the agent's task folders through the host", async () => {
    const withFile = task('Done with a file', {
      assigneeAgentId: 'cx',
      status: 'done',
      updatedAt: 200,
    })
    const emptyDone = task('Done, empty', { assigneeAgentId: 'cx', status: 'done', updatedAt: 300 })
    const withFileDir = await folderWith(withFile, { 'report.md': '# Report' })
    await folderWith(emptyDone)

    const out = fakeRes()
    await agentWorkspacesGET(req({ agentId: 'cx' }), out.res)
    const body = out.body() as { taskFolders: Array<{ taskId: string }> }
    expect(body.taskFolders.map((f) => f.taskId)).toEqual([withFile])
    expect(ops).toContainEqual({ op: 'fs.stat', path: withFileDir })
  })

  it('never reads through a team folder an agent swapped for a link', async () => {
    const id = task('Write the brief')
    const outside = path.join(home, 'outside-team')
    await mkdir(path.join(outside, 'tasks', id), { recursive: true })
    await writeFile(path.join(outside, 'tasks', id, 'vault.key'), 'secret')
    await mkdir(teamsRoot, { recursive: true })
    await symlink(outside, path.join(teamsRoot, 'T'))

    expect(await realTaskFolder(path.join(teamsRoot, 'T', 'tasks', id))).toBeNull()
    // The host was asked about the team folder: the server cannot look there.
    expect(ops).toContainEqual({ op: 'fs.stat', path: path.join(teamsRoot, 'T') })
    const file = fakeRes()
    await boardTaskFolderFileGET(req({ taskId: id }, { path: 'vault.key' }), file.res)
    expect(file.status()).not.toBe(200)
    expect(JSON.stringify(file.body())).not.toContain('secret')
    expect((await resolvePreviewFile(id, 'vault.key')).ok).toBe(false)
  })

  it('refuses a checked root that has become a link', async () => {
    const real = path.join(home, 'real')
    await mkdir(path.join(real, 'inner'), { recursive: true })
    await writeFile(path.join(real, 'inner', 'a.md'), 'a')
    const link = path.join(home, 'link')
    await symlink(real, link)

    // The root's last part is a real folder, but a folder above it is a link:
    // read as a checked real root, it is refused instead of followed.
    await expect(
      resolveWorkspaceRelPath(path.join(link, 'inner'), 'a.md', { exactRoot: true }),
    ).rejects.toThrow(WorkspacePathError)
    expect(ops).toContainEqual({ op: 'fs.realpath', path: path.join(link, 'inner') })
    // The real path itself still reads.
    const realRoot = realpathSync.native(path.join(real, 'inner'))
    expect((await resolveWorkspaceRelPath(realRoot, 'a.md', { exactRoot: true })).realRoot).toBe(
      realRoot,
    )
  })
})
