// Task folder cleanup keeps the worktree rules: a live task is never touched,
// only this install's folders are, and no work is lost (a folder with files
// stays). Plus the one-time drop of Claude Code task sessions that were filed
// under the team folder before task runs moved into their own folders.

import { existsSync, realpathSync } from 'node:fs'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createTask, getSetting, setSetting, tasks, teams, type ClawbooDb } from '@clawboo/db'
import { eq } from 'drizzle-orm'

import { getDb, resetDb } from '../db'
import { gcTaskFolders } from '../taskFolders'
import {
  clearClaudeCodeTaskPointersOnce,
  TASK_FOLDER_POINTERS_CLEARED_KEY,
} from '../teamChat/taskSessionPointers'

const isWindows = process.platform === 'win32'

describe('task folder cleanup', () => {
  let home: string
  let prevHome: string | undefined
  let prevClawbooHome: string | undefined
  let db: ClawbooDb
  let teamsRoot: string

  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), 'clawboo-task-folder-gc-'))
    const clawbooHome = path.join(home, '.clawboo')
    await mkdir(clawbooHome, { recursive: true })
    teamsRoot = path.join(realpathSync.native(home), '.clawboo-work', 'teams')
    prevHome = process.env['HOME']
    prevClawbooHome = process.env['CLAWBOO_HOME']
    process.env['HOME'] = home
    process.env['CLAWBOO_HOME'] = clawbooHome
    db = getDb()
    const now = Date.now()
    db.insert(teams)
      .values({ id: 'T', name: 'T', icon: 'T', color: '#000', createdAt: now, updatedAt: now })
      .run()
  })
  afterEach(async () => {
    resetDb()
    if (prevHome === undefined) delete process.env['HOME']
    else process.env['HOME'] = prevHome
    if (prevClawbooHome === undefined) delete process.env['CLAWBOO_HOME']
    else process.env['CLAWBOO_HOME'] = prevClawbooHome
    await rm(home, { recursive: true, force: true })
  })

  function task(status: string, teamId: string | null = 'T', dropped = false): string {
    const id = createTask(db, { title: status, status: 'todo', teamId }).id
    db.update(tasks)
      .set({ status, ...(dropped ? { dropped: 1 } : {}) } as Partial<typeof tasks.$inferInsert>)
      .where(eq(tasks.id, id))
      .run()
    return id
  }

  async function folder(team: string, name: string, files: string[] = []): Promise<string> {
    const dir = path.join(teamsRoot, team, 'tasks', name)
    await mkdir(dir, { recursive: true })
    for (const f of files) await writeFile(path.join(dir, f), 'x')
    return dir
  }

  it('removes only the empty folders of finished tasks', async () => {
    const done = await folder('T', task('done'))
    const cancelled = await folder('T', task('cancelled'))
    const dropped = await folder('T', task('todo', 'T', true))
    const teamless = await folder('_no-team', task('done', null))
    const withFiles = await folder('T', task('done'), ['report.md'])
    const live = await folder('T', task('in_progress'))
    const inReview = await folder('T', task('in_review'))
    const waiting = await folder('T', task('todo'))

    const result = await gcTaskFolders(db)

    for (const gone of [done, cancelled, dropped, teamless]) expect(existsSync(gone)).toBe(false)
    expect(result.removed.sort()).toEqual([done, cancelled, dropped, teamless].sort())
    // Work is never lost, and nothing of a task that can still run goes.
    for (const stays of [withFiles, live, inReview, waiting]) expect(existsSync(stays)).toBe(true)
    expect(result.kept).toBe(1)
  })

  it("leaves a folder whose name is not one of this install's tasks", async () => {
    // Another install sharing the work folder, or a name that is not a task id.
    const foreign = await folder('_no-team', '0b6c6f1e-0000-4000-8000-000000000000')
    const stray = await folder('T', 'not a task')

    await gcTaskFolders(db)

    expect(existsSync(foreign)).toBe(true)
    expect(existsSync(stray)).toBe(true)
  })

  it.skipIf(isWindows)('follows no link, in tasks/ or as tasks/ itself', async () => {
    const outside = path.join(home, 'outside')
    const id = task('done')
    await mkdir(path.join(outside, id), { recursive: true })
    // tasks/ of team T is a link to a folder holding an empty folder named for a
    // finished task.
    await mkdir(path.join(teamsRoot, 'T'), { recursive: true })
    await symlink(outside, path.join(teamsRoot, 'T', 'tasks'))
    // And a link named for a finished task in _no-team's tasks/.
    const other = task('done', null)
    await mkdir(path.join(outside, 'target'), { recursive: true })
    await mkdir(path.join(teamsRoot, '_no-team', 'tasks'), { recursive: true })
    await symlink(path.join(outside, 'target'), path.join(teamsRoot, '_no-team', 'tasks', other))

    await gcTaskFolders(db)

    expect(existsSync(path.join(outside, id))).toBe(true)
    expect(existsSync(path.join(outside, 'target'))).toBe(true)
  })

  it('drops Claude Code task sessions once, and keeps every other runtime', () => {
    const pointer = (runtime: string): string =>
      JSON.stringify({ sessionId: 's1', runtime, ticketHash: 'h', seenAt: 1 })
    setSetting(db, 'native-team-session:cc:T:task:t1', pointer('claude-code'))
    setSetting(db, 'native-team-session:hm:T:task:t1', pointer('hermes'))
    setSetting(db, 'native-team-session:cc:T', 'lead-session')

    expect(clearClaudeCodeTaskPointersOnce(db)).toBe(1)
    expect(getSetting(db, 'native-team-session:cc:T:task:t1')).toBeNull()
    expect(getSetting(db, 'native-team-session:hm:T:task:t1')).not.toBeNull()
    // The lead's team session still starts in the team folder.
    expect(getSetting(db, 'native-team-session:cc:T')).toBe('lead-session')
    expect(getSetting(db, TASK_FOLDER_POINTERS_CLEARED_KEY)).toBe('1')

    // A pointer a task run writes from now on is in the task folder: kept.
    setSetting(db, 'native-team-session:cc:T:task:t2', pointer('claude-code'))
    expect(clearClaudeCodeTaskPointersOnce(db)).toBe(0)
    expect(getSetting(db, 'native-team-session:cc:T:task:t2')).not.toBeNull()
  })
})
