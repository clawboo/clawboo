// A task's own folder (`<team folder>/tasks/<task id>`, where a run of a task
// with no worktree starts) at the API: the task drawer learns of it from the
// detail route, an agent's Computer tab lists it and reads it read-only, and the
// preview serves from it. The folder always comes from the task's row, never the
// request, and is refused when an agent swapped part of it for a link.

import { realpathSync } from 'node:fs'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { agents, createTask, tasks, teams, type ClawbooDb } from '@clawboo/db'
import { eq } from 'drizzle-orm'
import type { Request, Response } from 'express'

import { getDb, resetDb } from '../../lib/db'
import { taskFolderPath } from '../../lib/runtimes/teamWorkdir'
import { resolveWorkspaceRelPath, WorkspacePathError } from '../../lib/workspaceFs'
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

const isWindows = process.platform === 'win32'

describe('task folder API', () => {
  let home: string
  let prevHome: string | undefined
  let prevClawbooHome: string | undefined
  let db: ClawbooDb
  /** CLAWBOO_HOME's `-work` sibling's teams/, by its real path. */
  let teamsRoot: string

  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), 'clawboo-task-folder-'))
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
    for (const id of ['cx', 'other']) {
      db.insert(agents)
        .values({
          id,
          name: id,
          gatewayId: id,
          runtime: 'codex',
          teamId: 'T',
          createdAt: now,
          updatedAt: now,
        })
        .run()
    }
  })
  afterEach(async () => {
    resetDb()
    if (prevHome === undefined) delete process.env['HOME']
    else process.env['HOME'] = prevHome
    if (prevClawbooHome === undefined) delete process.env['CLAWBOO_HOME']
    else process.env['CLAWBOO_HOME'] = prevClawbooHome
    await rm(home, { recursive: true, force: true })
  })

  /** A task of team T for `assignee`, with its row's fields set as given. */
  function task(
    title: string,
    fields: Partial<{
      assigneeAgentId: string
      status: string
      updatedAt: number
      worktreeRef: string
      teamId: string | null
    }> = {},
  ): string {
    const id = createTask(db, {
      title,
      status: 'todo',
      teamId: fields.teamId === undefined ? 'T' : fields.teamId,
    }).id
    const { teamId: _teamId, ...rest } = fields
    if (Object.keys(rest).length > 0)
      db.update(tasks)
        .set(rest as Partial<typeof tasks.$inferInsert>)
        .where(eq(tasks.id, id))
        .run()
    return id
  }

  /** Make a task's folder on disk, with the files given. */
  async function folderWith(taskId: string, files: Record<string, string> = {}): Promise<string> {
    const dir = path.join(teamsRoot, 'T', 'tasks', taskId)
    await mkdir(dir, { recursive: true })
    for (const [name, body] of Object.entries(files)) await writeFile(path.join(dir, name), body)
    return dir
  }

  it('puts a task folder inside its team folder, and a teamless one under _no-team', () => {
    expect(taskFolderPath('T', 'task-1')).toBe(path.join(teamsRoot, 'T', 'tasks', 'task-1'))
    expect(taskFolderPath(null, 'task-1')).toBe(path.join(teamsRoot, '_no-team', 'tasks', 'task-1'))
    // A task id is one path segment, never a way out of the folder.
    expect(() => taskFolderPath('T', '../escape')).toThrow()
    expect(() => taskFolderPath('T', 'a/b')).toThrow()
  })

  it('lists and reads the folder of a task, read-only', async () => {
    const id = task('Write the brief')
    await folderWith(id, { 'brief.md': '# Brief' })

    const tree = fakeRes()
    await boardTaskFolderTreeGET(req({ taskId: id }), tree.res)
    expect(tree.status()).toBe(200)
    expect(tree.body()).toMatchObject({
      ok: true,
      entries: [{ name: 'brief.md', kind: 'file' }],
    })

    const file = fakeRes()
    await boardTaskFolderFileGET(req({ taskId: id }, { path: 'brief.md' }), file.res)
    expect(file.status()).toBe(200)
    expect(file.body()).toMatchObject({ ok: true, binary: false, content: '# Brief' })
  })

  it('answers 404 for a folder not made yet and for an unknown task', async () => {
    const id = task('Not run yet')

    const missing = fakeRes()
    await boardTaskFolderTreeGET(req({ taskId: id }), missing.res)
    expect(missing.status()).toBe(404)
    expect(missing.body()).toMatchObject({ reason: 'gone' })

    const unknown = fakeRes()
    await boardTaskFolderTreeGET(req({ taskId: 'no-such-task' }), unknown.res)
    expect(unknown.status()).toBe(404)
    expect(unknown.body()).toMatchObject({ reason: 'not_found' })
  })

  it('refuses a path out of the folder', async () => {
    const id = task('Write the brief')
    await folderWith(id, { 'brief.md': '# Brief' })

    const out = fakeRes()
    await boardTaskFolderFileGET(req({ taskId: id }, { path: '../../secret.txt' }), out.res)
    expect(out.status()).toBe(400)
  })

  it.skipIf(isWindows)(
    'never reads through a task folder an agent swapped for a link',
    async () => {
      const id = task('Write the brief')
      const outside = path.join(home, 'outside')
      await mkdir(outside, { recursive: true })
      await writeFile(path.join(outside, 'vault.key'), 'secret')
      await mkdir(path.join(teamsRoot, 'T', 'tasks'), { recursive: true })
      await symlink(outside, path.join(teamsRoot, 'T', 'tasks', id))

      const tree = fakeRes()
      await boardTaskFolderTreeGET(req({ taskId: id }), tree.res)
      expect(tree.status()).toBe(409)
      const file = fakeRes()
      await boardTaskFolderFileGET(req({ taskId: id }, { path: 'vault.key' }), file.res)
      expect(file.status()).toBe(409)
      expect(JSON.stringify(file.body())).not.toContain('secret')
      // The preview refuses it too.
      expect((await resolvePreviewFile(id, 'vault.key')).ok).toBe(false)
    },
  )

  it.skipIf(isWindows)('never reads through a tasks folder that is a link', async () => {
    const id = task('Write the brief')
    const outside = path.join(home, 'outside-tasks')
    await mkdir(path.join(outside, id), { recursive: true })
    await writeFile(path.join(outside, id, 'vault.key'), 'secret')
    await mkdir(path.join(teamsRoot, 'T'), { recursive: true })
    await symlink(outside, path.join(teamsRoot, 'T', 'tasks'))

    const file = fakeRes()
    await boardTaskFolderFileGET(req({ taskId: id }, { path: 'vault.key' }), file.res)
    expect(file.status()).toBe(409)
  })

  it.skipIf(isWindows)('does not serve a link inside the folder', async () => {
    const id = task('Write the brief')
    const dir = await folderWith(id)
    await writeFile(path.join(home, 'vault.key'), 'secret')
    await symlink(path.join(home, 'vault.key'), path.join(dir, 'notes.md'))

    const file = fakeRes()
    await boardTaskFolderFileGET(req({ taskId: id }, { path: 'notes.md' }), file.res)
    expect(file.status()).toBe(400)
    const tree = fakeRes()
    await boardTaskFolderTreeGET(req({ taskId: id }), tree.res)
    expect(tree.body()).toMatchObject({ ok: true, entries: [] })
  })

  it('reads a task folder under a `Tasks` folder an agent made, where case is ignored', async () => {
    const id = task('Write the brief')
    // On macOS and Windows `tasks/<id>` lands in an existing `Tasks/`.
    await mkdir(path.join(teamsRoot, 'T', 'Tasks'), { recursive: true })
    await folderWith(id, { 'brief.md': '# Brief' })

    const file = fakeRes()
    await boardTaskFolderFileGET(req({ taskId: id }, { path: 'brief.md' }), file.res)
    expect(file.status()).toBe(200)
    expect(file.body()).toMatchObject({ content: '# Brief' })
  })

  it.skipIf(isWindows)('refuses a checked root that has become a link', async () => {
    const real = path.join(home, 'real')
    await mkdir(real, { recursive: true })
    await writeFile(path.join(real, 'a.md'), 'a')
    const link = path.join(home, 'link')
    await symlink(real, link)

    // Read as a checked real root, the link is refused instead of followed.
    await expect(resolveWorkspaceRelPath(link, 'a.md', { exactRoot: true })).rejects.toThrow(
      WorkspacePathError,
    )
    // The real path itself still reads.
    const realRoot = realpathSync.native(real)
    expect((await resolveWorkspaceRelPath(realRoot, 'a.md', { exactRoot: true })).realRoot).toBe(
      realRoot,
    )
  })

  it("tells the drawer about the task's own folder when it has no worktree", async () => {
    const id = task('Write the brief')

    const before = fakeRes()
    await boardWorkspaceDetailGET(req({ taskId: id }), before.res)
    expect(before.body()).toEqual({
      ok: false,
      reason: 'no_workspace',
      taskFolder: {
        path: path.join(teamsRoot, 'T', 'tasks', id),
        onDisk: false,
        holdsFiles: false,
      },
    })

    await folderWith(id)
    const empty = fakeRes()
    await boardWorkspaceDetailGET(req({ taskId: id }), empty.res)
    expect(empty.body()).toMatchObject({ taskFolder: { onDisk: true, holdsFiles: false } })

    await folderWith(id, { 'notes.md': 'n' })
    const after = fakeRes()
    await boardWorkspaceDetailGET(req({ taskId: id }), after.res)
    expect(after.body()).toMatchObject({ taskFolder: { onDisk: true, holdsFiles: true } })
  })

  it("lists the agent's task folders, newest first, leaving out empty finished ones", async () => {
    const live = task('Going now', { assigneeAgentId: 'cx', status: 'in_progress', updatedAt: 300 })
    const withFile = task('Done with a file', {
      assigneeAgentId: 'cx',
      status: 'done',
      updatedAt: 200,
    })
    const emptyDone = task('Done, empty', { assigneeAgentId: 'cx', status: 'done', updatedAt: 400 })
    const neverRan = task('Never ran', { assigneeAgentId: 'cx', status: 'todo', updatedAt: 500 })
    const theirs = task('Someone else', { assigneeAgentId: 'other', updatedAt: 600 })
    const withWorktree = task('Has a worktree', {
      assigneeAgentId: 'cx',
      status: 'in_progress',
      updatedAt: 700,
      worktreeRef: '/w/worktrees/abc/x',
    })
    await folderWith(live)
    await folderWith(withFile, { 'report.md': '# Report' })
    await folderWith(emptyDone)
    await folderWith(theirs, { 'a.md': 'a' })
    await folderWith(withWorktree, { 'a.md': 'a' })

    const out = fakeRes()
    agentWorkspacesGET(req({ agentId: 'cx' }), out.res)
    const body = out.body() as { taskFolders: Array<{ taskId: string; path: string }> }
    expect(body.taskFolders.map((f) => f.taskId)).toEqual([live, withFile])
    expect(body.taskFolders[0]?.path).toBe(path.join(teamsRoot, 'T', 'tasks', live))
    expect(body.taskFolders.map((f) => f.taskId)).not.toContain(neverRan)
  })

  it('serves the preview from the task folder when the task has no worktree', async () => {
    const id = task('Build the page')
    await folderWith(id, { 'index.html': '<h1>Hi</h1>' })

    const found = await resolvePreviewFile(id, '')
    expect(found).toMatchObject({
      ok: true,
      isIndex: true,
      contentType: 'text/html; charset=utf-8',
    })
  })
})
