// Task checkouts recorded under the work folder (`resolveWorkDir`) while new
// ones go under the data folder: the old layout (`setWorkLayout('data')`), which
// is how a version before the move behaves, and how an install that cannot make
// the work folder keeps working. These tests set up the newer layout by moving a
// checkout with `git worktree move` and rewriting its recorded path, the way the
// move leaves it. Pause, complete, the verify gate, resume, GC and a repeat
// provision all have to act on the checkout where it is recorded.

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'

import {
  claimTask,
  createTask,
  getTask,
  getWorkspaceForTask,
  setSetting,
  setTaskWorkspaceRefs,
  updateStatus,
  workspaces,
} from '@clawboo/db'
import { branchExists, isWorktreeRegistered, SOR_FILES } from '@clawboo/worktrees'

import { getDb, resetDb } from '../db'
import { setWorkLayout } from '../workDir'
import { teamVerifyCommandSettingKey } from '../verification/teamVerifyCommand'
import {
  listWorkspaceDir,
  readWorkspaceFile,
  workspaceFileDiff,
  workspaceGitStatus,
} from '../workspaceFs'
import {
  actOnTaskWorkspace,
  gcTaskWorkspaces,
  provisionTaskWorkspace,
  readWorktreeDetail,
  resumeTaskWorkspace,
} from '../worktrees'

const execFileAsync = promisify(execFile)
async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, windowsHide: true })
  return stdout
}

async function initRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'clawboo-wd-repo-'))
  await git(dir, ['init', '-b', 'main'])
  await git(dir, ['config', 'user.name', 'test'])
  await git(dir, ['config', 'user.email', 'test@example.com'])
  await git(dir, ['config', 'core.autocrlf', 'false'])
  await writeFile(path.join(dir, 'README.md'), '# repo\n')
  await git(dir, ['add', '-A'])
  await git(dir, ['commit', '--no-verify', '-m', 'init'])
  return dir
}

describe('task checkouts recorded under the work folder', () => {
  let repo: string
  let home: string
  let prevHome: string | undefined
  let prevWorkDir: string | undefined

  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), 'clawboo-wd-home-'))
    prevHome = process.env['HOME']
    prevWorkDir = process.env['CLAWBOO_WORK_DIR']
    process.env['HOME'] = home // data folder: <home>/.clawboo; work folder: <home>/clawboo-work
    delete process.env['CLAWBOO_WORK_DIR']
    setWorkLayout('data')
    repo = await initRepo()
  })

  afterEach(async () => {
    setWorkLayout('work')
    resetDb()
    if (prevHome === undefined) delete process.env['HOME']
    else process.env['HOME'] = prevHome
    if (prevWorkDir === undefined) delete process.env['CLAWBOO_WORK_DIR']
    else process.env['CLAWBOO_WORK_DIR'] = prevWorkDir
    await rm(home, { recursive: true, force: true })
    await rm(repo, { recursive: true, force: true })
  })

  function newClaimedCodeTask(): string {
    const db = getDb()
    const task = createTask(db, {
      title: 'Implement feature X',
      description: 'Wire feature X end to end.',
      teamId: 'team-1',
      status: 'todo',
    })
    expect(claimTask(db, task.id, 'agent-1', 'claude-code').ok).toBe(true)
    return task.id
  }

  /**
   * Provision a task's checkout (under the data folder, as every new one is),
   * then move it under `workDir` and record the new path, as the newer layout
   * does. With `link`, a link to it is left at the old path too.
   */
  async function provisionInWorkFolder(
    opts: { workDir?: string; recordedWorkDir?: string; link?: boolean } = {},
  ): Promise<{ taskId: string; oldPath: string; recorded: string; branch: string }> {
    const taskId = newClaimedCodeTask()
    const prov = await provisionTaskWorkspace(taskId, { repoPath: repo, kind: 'code' })
    if (!prov.ok) throw new Error(`provision failed: ${prov.reason}`)
    const oldPath = prov.worktree.worktreePath
    expect(oldPath.startsWith(path.join(home, '.clawboo', 'worktrees'))).toBe(true)

    const repoHash = path.basename(path.dirname(oldPath))
    const workDir = opts.workDir ?? path.join(home, 'clawboo-work')
    const moved = path.join(workDir, 'worktrees', repoHash, taskId)
    await mkdir(path.dirname(moved), { recursive: true })
    await git(repo, ['worktree', 'move', oldPath, moved])
    if (opts.link) await symlink(moved, oldPath, 'junction')

    const recorded = path.join(opts.recordedWorkDir ?? workDir, 'worktrees', repoHash, taskId)
    const db = getDb()
    db.update(workspaces).set({ worktreePath: recorded }).where(eq(workspaces.taskId, taskId)).run()
    setTaskWorkspaceRefs(db, taskId, { worktreeRef: recorded, branchRef: prov.worktree.branch })
    return { taskId, oldPath, recorded, branch: prov.worktree.branch }
  }

  it('complete with no change cleans up the recorded checkout and lands the task done', async () => {
    const { taskId, recorded, branch } = await provisionInWorkFolder()

    const result = await actOnTaskWorkspace(taskId, 'complete')

    if (!result.ok || result.action !== 'complete') throw new Error('expected complete')
    expect(result.complete).toMatchObject({ dirty: false, cleaned: true })
    expect(result.taskStatus).toBe('done')
    expect(existsSync(recorded)).toBe(false)
    expect(await branchExists(repo, branch)).toBe(false)
  })

  it('complete with a change runs the verify gate in the recorded checkout', async () => {
    const { taskId, recorded } = await provisionInWorkFolder()
    setSetting(
      getDb(),
      teamVerifyCommandSettingKey('team-1'),
      JSON.stringify({ command: 'git --version' }),
    )
    await writeFile(path.join(recorded, 'feature.ts'), 'export const x = 1\n')

    const result = await actOnTaskWorkspace(taskId, 'complete')

    if (!result.ok || result.action !== 'complete') throw new Error('expected complete')
    expect(result.complete.dirty).toBe(true)
    expect(result.verified).toBe('pass')
    expect(getTask(getDb(), taskId)?.status).toBe('done')
    const evidence = await readFile(path.join(recorded, SOR_FILES.verification), 'utf8')
    expect(evidence).toContain('- Command: `git --version`')
  })

  it('pause commits the work and removes the recorded checkout, keeping the branch', async () => {
    const { taskId, recorded, branch } = await provisionInWorkFolder()
    await writeFile(path.join(recorded, 'feature.ts'), 'export const x = 1\n')

    const result = await actOnTaskWorkspace(taskId, 'pause')

    if (!result.ok || result.action !== 'pause') throw new Error('expected pause')
    expect(result.pause.committed).toBe(true)
    expect(existsSync(recorded)).toBe(false)
    expect(await git(repo, ['show', `${branch}:feature.ts`])).toBe('export const x = 1\n')
  })

  it('resume after a pause rebuilds the checkout where it is recorded', async () => {
    const { taskId, oldPath, recorded } = await provisionInWorkFolder()
    await actOnTaskWorkspace(taskId, 'pause')

    const resumed = await resumeTaskWorkspace(taskId, { repoPath: repo })

    if (!resumed.ok) throw new Error(`resume failed: ${resumed.reason}`)
    expect(resumed.worktree.worktreePath).toBe(recorded)
    expect(await isWorktreeRegistered(repo, recorded)).toBe(true)
    expect(existsSync(oldPath)).toBe(false)
    expect(getWorkspaceForTask(getDb(), taskId)?.worktreePath).toBe(recorded)
  })

  it('GC reaps an aged checkout under the work folder and marks its row stale', async () => {
    const { taskId, recorded, branch } = await provisionInWorkFolder()
    await writeFile(path.join(recorded, 'feature.ts'), 'export const x = 1\n')
    expect(updateStatus(getDb(), taskId, 'todo').ok).toBe(true)

    const summary = await gcTaskWorkspaces({ maxAgeMs: 0, maxCount: 1000 })

    expect(summary.reaped).toContain(taskId)
    expect(existsSync(recorded)).toBe(false)
    expect(await git(repo, ['show', `${branch}:feature.ts`])).toBe('export const x = 1\n')
    expect(getWorkspaceForTask(getDb(), taskId)?.status).toBe('stale')
  })

  it('GC leaves a link at the old path alone and reaps the checkout it points to', async () => {
    const { taskId, oldPath, recorded } = await provisionInWorkFolder({ link: true })
    expect(updateStatus(getDb(), taskId, 'todo').ok).toBe(true)

    const summary = await gcTaskWorkspaces({ maxAgeMs: 0, maxCount: 1000 })

    expect(summary.reaped).toEqual([taskId])
    expect(existsSync(recorded)).toBe(false)
    expect(summary.failed).toEqual([])
    // The link itself is not a folder GC collects; it now points at nothing.
    expect(existsSync(oldPath)).toBe(false)
  })

  it('GC does not mark a row stale when the folder it reaped is not the recorded one', async () => {
    // A stray, empty folder for the task under the data folder, a day old, while
    // the row records the work-folder checkout, which is new.
    const { taskId, oldPath, recorded } = await provisionInWorkFolder()
    await mkdir(oldPath, { recursive: true })
    const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000)
    await utimes(oldPath, dayAgo, dayAgo)
    expect(updateStatus(getDb(), taskId, 'todo').ok).toBe(true)

    const summary = await gcTaskWorkspaces({ maxAgeMs: 60 * 60 * 1000, maxCount: 1000 })

    expect(summary.reaped).toEqual([taskId])
    expect(existsSync(oldPath)).toBe(false)
    expect(existsSync(recorded)).toBe(true)
    expect(getWorkspaceForTask(getDb(), taskId)?.status).toBe('active')
  })

  it('GC leaves alone a work-folder checkout this install does not record', async () => {
    // Another install's checkout of the same repository in a shared work folder:
    // registered with git, aged, and for a task this database has never seen.
    const { taskId, recorded } = await provisionInWorkFolder()
    expect(updateStatus(getDb(), taskId, 'todo').ok).toBe(true)
    const foreign = path.join(path.dirname(recorded), 'other-install-task')
    await git(repo, ['worktree', 'add', '-b', 'clawboo/task-other-install-task', foreign])
    await writeFile(path.join(foreign, '.env'), 'SECRET=1\n')

    const summary = await gcTaskWorkspaces({ maxAgeMs: 0, maxCount: 1000 })

    expect(summary.reaped).toEqual([taskId])
    expect(existsSync(recorded)).toBe(false)
    expect(existsSync(path.join(foreign, '.env'))).toBe(true)
    expect(await isWorktreeRegistered(repo, foreign)).toBe(true)
  })

  it('a provision over a missing work-folder checkout records where it rebuilt it', async () => {
    const { taskId, recorded } = await provisionInWorkFolder()
    await git(repo, ['worktree', 'remove', '--force', recorded])

    const prov = await provisionTaskWorkspace(taskId, { repoPath: repo, kind: 'code' })

    if (!prov.ok) throw new Error(`provision failed: ${prov.reason}`)
    expect(prov.worktree.worktreePath).not.toBe(recorded)
    expect(getWorkspaceForTask(getDb(), taskId)?.worktreePath).toBe(prov.worktree.worktreePath)
    // Pause now acts on the checkout the agent works in.
    await writeFile(path.join(prov.worktree.worktreePath, 'feature.ts'), 'export const x = 1\n')
    const paused = await actOnTaskWorkspace(taskId, 'pause')
    if (!paused.ok || paused.action !== 'pause') throw new Error('expected pause')
    expect(paused.pause.committed).toBe(true)
    expect(existsSync(prov.worktree.worktreePath)).toBe(false)
  })

  it('resume records the rebuilt path when the recorded one is under no known root', async () => {
    const elsewhere = path.join(home, 'elsewhere')
    const { taskId, recorded, branch } = await provisionInWorkFolder({ workDir: elsewhere })
    await git(repo, ['worktree', 'remove', '--force', recorded])

    const resumed = await resumeTaskWorkspace(taskId, { repoPath: repo })

    if (!resumed.ok) throw new Error(`resume failed: ${resumed.reason}`)
    expect(resumed.worktree.worktreePath.startsWith(path.join(home, '.clawboo'))).toBe(true)
    expect(getWorkspaceForTask(getDb(), taskId)?.worktreePath).toBe(resumed.worktree.worktreePath)
    await writeFile(path.join(resumed.worktree.worktreePath, 'feature.ts'), 'export const x = 1\n')
    const paused = await actOnTaskWorkspace(taskId, 'pause')
    if (!paused.ok || paused.action !== 'pause') throw new Error('expected pause')
    expect(paused.pause.committed).toBe(true)
    expect(await git(repo, ['show', `${branch}:feature.ts`])).toBe('export const x = 1\n')
  })

  it('a repeat provision hands back the recorded checkout, not a rebuilt path', async () => {
    const { taskId, recorded } = await provisionInWorkFolder()

    const again = await provisionTaskWorkspace(taskId, { repoPath: repo, kind: 'code' })

    if (!again.ok) throw new Error(`provision failed: ${again.reason}`)
    expect(again.worktree.worktreePath).toBe(recorded)
  })

  it('the Computer tab and the task drawer read the recorded checkout', async () => {
    const { taskId, recorded } = await provisionInWorkFolder()
    await writeFile(path.join(recorded, 'feature.ts'), 'export const x = 1\n')

    const listing = await listWorkspaceDir(taskId, '')
    if (!('entries' in listing)) throw new Error('expected a listing')
    expect(listing.entries.map((e) => e.name)).toContain('feature.ts')
    expect(await readWorkspaceFile(taskId, 'feature.ts')).toMatchObject({
      ok: true,
      content: 'export const x = 1\n',
    })
    const status = await workspaceGitStatus(taskId)
    if (!('entries' in status)) throw new Error('expected a git status')
    expect(status.entries.map((e) => e.path)).toContain('feature.ts')
    const diff = await workspaceFileDiff(taskId, 'feature.ts')
    expect(diff).toMatchObject({ ok: true })

    const detail = await readWorktreeDetail(taskId)
    expect(detail.sorFiles?.[SOR_FILES.task]).toEqual(expect.any(String))
    expect(detail.diffStat?.dirty).toBe(true)
  })

  it('accepts a checkout recorded through the real path of a linked work folder', async () => {
    // CLAWBOO_WORK_DIR names a link; the checkout is recorded under the real
    // path of the folder it points to.
    const target = path.join(home, 'real-work')
    const linked = path.join(home, 'linked-work')
    await mkdir(target, { recursive: true })
    await symlink(target, linked, 'junction')
    process.env['CLAWBOO_WORK_DIR'] = linked
    const { taskId, recorded, branch } = await provisionInWorkFolder({
      workDir: linked,
      recordedWorkDir: await realpath(target),
    })

    const result = await actOnTaskWorkspace(taskId, 'complete')

    if (!result.ok || result.action !== 'complete') throw new Error('expected complete')
    expect(result.complete.cleaned).toBe(true)
    expect(existsSync(recorded)).toBe(false)
    expect(await branchExists(repo, branch)).toBe(false)
  })

  it('still refuses a recorded checkout outside both layouts', async () => {
    const elsewhere = path.join(home, 'elsewhere')
    const { taskId, recorded } = await provisionInWorkFolder({ workDir: elsewhere })

    await expect(actOnTaskWorkspace(taskId, 'pause')).rejects.toThrow(/does not belong to task/)
    expect(existsSync(recorded)).toBe(true)
  })
})
