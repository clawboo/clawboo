// Task folder cleanup with agents on their own OS user (CLAWBOO_AGENT_USER).
//
// The folders are then the agent user's: the server cannot see into them, and
// must not remove anything there as itself. So the sweep looks, lists and
// removes through agentFs, which asks the agent host. Here agentFs is replaced
// by a small in-memory agent space that only it can see: a sweep that used the
// server's own `lstat`, `readdir` or `rmdir` would find no folders at all and
// remove nothing.

import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createTask, tasks, teams, type ClawbooDb } from '@clawboo/db'
import { eq } from 'drizzle-orm'

import type { FsEntry, FsStat } from '../agentUser/protocol'

type Kind = FsStat['type']

/** The agent space: what the host sees, by absolute path. */
const space = new Map<string, Kind>()

function childrenOf(dir: string): string[] {
  const prefix = dir.endsWith(path.sep) ? dir : dir + path.sep
  return [...space.keys()].filter(
    (p) => p.startsWith(prefix) && !p.slice(prefix.length).includes(path.sep),
  )
}

const agentStat = vi.fn(async (p: string): Promise<FsStat | null> => {
  const type = space.get(p)
  return type ? { type, size: 0, mtimeMs: 0, mode: 0o700, uid: 4242, nlink: 1 } : null
})

const agentList = vi.fn(
  async (dir: string): Promise<{ entries: FsEntry[]; truncated: boolean }> => {
    if (space.get(dir) !== 'dir') {
      throw Object.assign(new Error(`ENOTDIR: ${dir}`), { code: 'ENOTDIR' })
    }
    const entries = childrenOf(dir)
      .sort()
      .map((p) => ({ name: path.basename(p), type: space.get(p)!, size: 0, mtimeMs: 0 }))
    return { entries, truncated: false }
  },
)

const agentRemoveEmptyDir = vi.fn(async (dir: string): Promise<void> => {
  if (space.get(dir) !== 'dir') {
    throw Object.assign(new Error(`ENOTDIR: ${dir}`), { code: 'ENOTDIR' })
  }
  if (childrenOf(dir).length > 0) {
    throw Object.assign(new Error(`ENOTEMPTY: ${dir}`), { code: 'ENOTEMPTY' })
  }
  space.delete(dir)
})

vi.mock('../agentUser/agentFs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../agentUser/agentFs')>()),
  agentStat: (p: string) => agentStat(p),
  agentList: (dir: string) => agentList(dir),
  agentRemoveEmptyDir: (dir: string) => agentRemoveEmptyDir(dir),
}))

const { getDb, resetDb } = await import('../db')
const { gcTaskFolders, removeEmptyTaskFolder } = await import('../taskFolders')
const { teamWorkdirPath } = await import('../runtimes/teamWorkdir')

describe('task folder cleanup through the agent host', () => {
  let home: string
  let prevHome: string | undefined
  let prevClawbooHome: string | undefined
  let prevWorkDir: string | undefined
  let db: ClawbooDb

  beforeEach(async () => {
    space.clear()
    agentStat.mockClear()
    agentList.mockClear()
    agentRemoveEmptyDir.mockClear()
    home = await mkdtemp(path.join(os.tmpdir(), 'clawboo-task-folder-gc-agent-'))
    const clawbooHome = path.join(home, '.clawboo')
    await mkdir(clawbooHome, { recursive: true })
    prevHome = process.env['HOME']
    prevClawbooHome = process.env['CLAWBOO_HOME']
    prevWorkDir = process.env['CLAWBOO_WORK_DIR']
    process.env['HOME'] = home
    process.env['CLAWBOO_HOME'] = clawbooHome
    // The agent user's work folder: never created on the server's side here.
    process.env['CLAWBOO_WORK_DIR'] = path.join(home, 'agent-home', 'work')
    db = getDb()
    const now = Date.now()
    db.insert(teams)
      .values({ id: 'T', name: 'T', icon: 'T', color: '#000', createdAt: now, updatedAt: now })
      .run()
  })

  afterEach(async () => {
    resetDb()
    const restore = (key: string, value: string | undefined): void => {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    restore('HOME', prevHome)
    restore('CLAWBOO_HOME', prevClawbooHome)
    restore('CLAWBOO_WORK_DIR', prevWorkDir)
    await rm(home, { recursive: true, force: true })
  })

  function task(status: string, teamId: string | null = 'T'): string {
    const id = createTask(db, { title: status, status: 'todo', teamId }).id
    db.update(tasks)
      .set({ status } as Partial<typeof tasks.$inferInsert>)
      .where(eq(tasks.id, id))
      .run()
    return id
  }

  /** Put a folder (and its parents) in agent space, with files in it. */
  function folder(team: string, name: string, files: string[] = []): string {
    const teamDir = teamWorkdirPath(team)
    const tasksDir = path.join(teamDir, 'tasks')
    for (const p of [path.dirname(teamDir), teamDir, tasksDir]) {
      if (!space.has(p)) space.set(p, 'dir')
    }
    const dir = path.join(tasksDir, name)
    space.set(dir, 'dir')
    for (const f of files) space.set(path.join(dir, f), 'file')
    return dir
  }

  it('removes the empty folders of finished tasks through the host', async () => {
    const done = folder('T', task('done'))
    const cancelled = folder('T', task('cancelled'))
    const teamless = folder('_no-team', task('done', null))
    const withFiles = folder('T', task('done'), ['report.md'])
    const live = folder('T', task('in_progress'))
    // A link named for a finished task is never followed or removed.
    const linkName = task('done')
    const link = path.join(teamWorkdirPath('T'), 'tasks', linkName)
    space.set(link, 'link')

    // Nothing of this is on the server's own disk: only the host sees it.
    expect(existsSync(done)).toBe(false)

    const result = await gcTaskFolders(db)

    expect(result.removed.sort()).toEqual([cancelled, done, teamless].sort())
    expect(result.kept).toBe(1)
    for (const gone of [done, cancelled, teamless]) expect(space.has(gone)).toBe(false)
    for (const kept of [withFiles, live, link]) expect(space.has(kept)).toBe(true)
    expect(agentRemoveEmptyDir).not.toHaveBeenCalledWith(link)
    expect(agentRemoveEmptyDir).not.toHaveBeenCalledWith(live)
    expect(agentList).toHaveBeenCalledWith(path.join(teamWorkdirPath('T'), 'tasks'))
  })

  it('does not sweep a tasks folder that is a link', async () => {
    const teamDir = teamWorkdirPath('T')
    space.set(path.dirname(teamDir), 'dir')
    space.set(teamDir, 'dir')
    space.set(path.join(teamDir, 'tasks'), 'link')

    const result = await gcTaskFolders(db)

    expect(result).toEqual({ removed: [], kept: 0 })
    // The host was asked, and its answer (a link) stopped the sweep there.
    expect(agentStat).toHaveBeenCalledWith(path.join(teamDir, 'tasks'))
    expect(agentList).not.toHaveBeenCalled()
    expect(agentRemoveEmptyDir).not.toHaveBeenCalled()
  })

  it('removes one folder through the host, and keeps one it refuses', async () => {
    const empty = folder('T', task('done'))
    const full = folder('T', task('done'), ['notes.md'])

    expect(await removeEmptyTaskFolder(empty)).toBe(true)
    expect(await removeEmptyTaskFolder(full)).toBe(false)
    expect(agentRemoveEmptyDir).toHaveBeenCalledWith(empty)
    expect(agentRemoveEmptyDir).toHaveBeenCalledWith(full)
    expect(space.has(full)).toBe(true)
  })
})
