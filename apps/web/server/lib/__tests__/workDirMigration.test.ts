// The work folder move at boot, against real git repositories in a sandboxed
// home. An older version (the old layout, `setWorkLayout('data')`) makes team
// folders and task checkouts in the data folder; the move renames them into the
// work folder, with git's links fixed, the board's records updated and a link
// left at each old path. What cannot move stays and keeps working.
//
// The kill tests stop the move after every step, run the version before it
// (the old layout, which reads both, knows no journal) on what is left, then
// boot again: nothing committed or uncommitted is lost, no checkout is removed,
// and the second boot finishes the move.

import { execFile } from 'node:child_process'
import { existsSync, lstatSync, readdirSync, realpathSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'

import {
  agents,
  claimTask,
  createExecutionProcess,
  createTask,
  getSetting,
  getTask,
  getWorkspaceForTask,
  setSetting,
  settings,
  tasks,
  teams,
  workspaces,
} from '@clawboo/db'
import {
  isWorktreeRegistered,
  readHandoff,
  writeHandoff,
  type AgentHandoffInput,
} from '@clawboo/worktrees'

import { getDb, getDbPath, resetDb } from '../db'
import { ensureTeamWorkdir, teamWorkdirPath } from '../runtimes/teamWorkdir'
import { installId, readOwnerMarker, reviewsRoot, setWorkLayout } from '../workDir'
import { setWorkDirJournal, workDirJournal } from '../workDirJournal'
import {
  runWorkDirMove,
  workDirMovePending,
  workDirMoveProgress,
  WorkDirMoveInterrupted,
  type WorkDirMoveStep,
} from '../workDirMigration'
import {
  actOnTaskWorkspace,
  gcTaskWorkspaces,
  provisionTaskWorkspace,
  resumeTaskWorkspace,
} from '../worktrees'

const isWindows = process.platform === 'win32'
const isRoot = process.getuid?.() === 0
const execFileAsync = promisify(execFile)
async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, windowsHide: true })
  return stdout
}

let base: string
let home: string
let data: string
let work: string
let repo: string
let prevHome: string | undefined
let prevClawbooHome: string | undefined
let prevWorkDir: string | undefined

async function initRepo(): Promise<string> {
  const dir = path.join(base, 'repo')
  await mkdir(dir)
  await git(dir, ['init', '-b', 'main'])
  await git(dir, ['config', 'user.name', 'test'])
  await git(dir, ['config', 'user.email', 'test@example.com'])
  await git(dir, ['config', 'core.autocrlf', 'false'])
  await writeFile(path.join(dir, 'README.md'), '# repo\n')
  await git(dir, ['add', '-A'])
  await git(dir, ['commit', '--no-verify', '-m', 'init'])
  return dir
}

beforeEach(async () => {
  base = realpathSync.native(await mkdtemp(path.join(os.tmpdir(), 'clawboo-move-')))
  home = path.join(base, 'home')
  await mkdir(home)
  data = path.join(home, '.clawboo')
  work = path.join(home, 'clawboo-work')
  prevHome = process.env['HOME']
  prevClawbooHome = process.env['CLAWBOO_HOME']
  prevWorkDir = process.env['CLAWBOO_WORK_DIR']
  process.env['HOME'] = home
  delete process.env['CLAWBOO_HOME']
  delete process.env['CLAWBOO_WORK_DIR']
  repo = await initRepo()
  const db = getDb()
  expect(getDbPath().startsWith(home + path.sep)).toBe(true)
  const now = Date.now()
  db.insert(teams)
    .values({ id: 'T1', name: 'T1', icon: 'T', color: '#000', createdAt: now, updatedAt: now })
    .run()
  // The old layout: what a version before the move makes.
  setWorkLayout('data')
})

afterEach(async () => {
  setWorkLayout('work')
  setWorkDirJournal({ version: 1, items: [] })
  resetDb()
  if (prevHome === undefined) delete process.env['HOME']
  else process.env['HOME'] = prevHome
  if (prevClawbooHome === undefined) delete process.env['CLAWBOO_HOME']
  else process.env['CLAWBOO_HOME'] = prevClawbooHome
  if (prevWorkDir === undefined) delete process.env['CLAWBOO_WORK_DIR']
  else process.env['CLAWBOO_WORK_DIR'] = prevWorkDir
  await rm(base, { recursive: true, force: true })
})

/** A claimed code task with a checkout in the data folder holding uncommitted
 *  work: a changed tracked file and a new one. */
async function taskWithWork(): Promise<{ taskId: string; oldPath: string; branch: string }> {
  const db = getDb()
  const task = createTask(db, { title: 'Change X', teamId: 'T1', status: 'todo' })
  expect(claimTask(db, task.id, 'agent-1', 'claude-code').ok).toBe(true)
  const prov = await provisionTaskWorkspace(task.id, { repoPath: repo, kind: 'code' })
  if (!prov.ok) throw new Error(`provision failed: ${prov.reason}`)
  const oldPath = prov.worktree.worktreePath
  expect(oldPath.startsWith(path.join(data, 'worktrees') + path.sep)).toBe(true)
  await writeFile(path.join(oldPath, 'README.md'), '# changed\n')
  await writeFile(path.join(oldPath, 'work.txt'), 'uncommitted work\n')
  return { taskId: task.id, oldPath, branch: prov.worktree.branch }
}

async function teamFolderWithFiles(name = 'T1'): Promise<string> {
  const dir = teamWorkdirPath(name)
  expect(dir).toBe(path.join(data, 'workspaces', name))
  await ensureTeamWorkdir(dir)
  await writeFile(path.join(dir, 'notes.md'), `notes of ${name}\n`)
  return dir
}

/** Boot the move in the new layout. */
async function boot(opts: Parameters<typeof runWorkDirMove>[1] = {}) {
  setWorkLayout('work')
  return runWorkDirMove(getDb(), opts)
}

const newPathOf = (taskId: string, oldPath: string): string =>
  path.join(work, 'worktrees', path.basename(path.dirname(oldPath)), taskId)

/** What the task's branch holds for `file`, or null. */
async function onBranch(branch: string, file: string): Promise<string | null> {
  try {
    return await git(repo, ['show', `${branch}:${file}`])
  } catch {
    return null
  }
}

describe('the work folder move', () => {
  it('moves team folders and task checkouts out of the data folder, links at the old paths', async () => {
    const team = await teamFolderWithFiles('T1')
    const noTeam = await teamFolderWithFiles('_no-team')
    const { taskId, oldPath, branch } = await taskWithWork()
    expect(workDirMovePending(getDb())).toBe(false) // the old layout moves nothing
    setWorkLayout('work')
    expect(workDirMovePending(getDb())).toBe(true)

    const report = await boot()
    expect(report).toMatchObject({ ran: true, moved: 3, left: 0, conflicts: 0 })

    // Team folders: files at the new place, a link at the old one.
    for (const [name, old] of [
      ['T1', team],
      ['_no-team', noTeam],
    ] as const) {
      const moved = path.join(work, 'teams', name)
      expect(await readFile(path.join(moved, 'notes.md'), 'utf8')).toBe(`notes of ${name}\n`)
      expect(lstatSync(old).isSymbolicLink()).toBe(true)
      expect(realpathSync.native(old)).toBe(moved)
      expect(teamWorkdirPath(name)).toBe(moved)
    }

    // The checkout: moved with git, work intact, records updated, marked ours.
    const newPath = newPathOf(taskId, oldPath)
    const db = getDb()
    expect(getWorkspaceForTask(db, taskId)?.worktreePath).toBe(newPath)
    expect(getTask(db, taskId)?.worktreeRef).toBe(newPath)
    expect(await isWorktreeRegistered(repo, newPath)).toBe(true)
    expect(await readFile(path.join(newPath, 'work.txt'), 'utf8')).toBe('uncommitted work\n')
    expect(await readFile(path.join(newPath, 'README.md'), 'utf8')).toBe('# changed\n')
    expect(lstatSync(oldPath).isSymbolicLink()).toBe(true)
    expect(realpathSync.native(oldPath)).toBe(newPath)
    // Saved on the branch before it moved, the commit a pause makes.
    expect(await onBranch(branch, 'work.txt')).toBe('uncommitted work\n')
    expect(readOwnerMarker(path.dirname(newPath), taskId)).toBe(installId(db))
    // A prune keeps it, and boot GC removes nothing.
    await git(repo, ['worktree', 'prune'])
    expect(await isWorktreeRegistered(repo, newPath)).toBe(true)
    expect((await gcTaskWorkspaces()).reaped).toEqual([])

    expect(workDirJournal().items.every((i) => i.state === 'moved')).toBe(true)
    expect(getSetting(db, 'work-dir')).toBe(work)
    // A second boot has nothing to do.
    expect(workDirMovePending(db)).toBe(false)
    expect(await boot()).toMatchObject({ ran: true, moved: 0, left: 0, conflicts: 0 })

    // Pause and complete work on the moved checkout.
    const paused = await actOnTaskWorkspace(taskId, 'pause')
    expect(paused).toMatchObject({ ok: true, action: 'pause' })
    expect(existsSync(newPath)).toBe(false)
  })

  it('says migrating, with its count, while it runs, and stops when it ends', async () => {
    await teamFolderWithFiles('T1')
    await taskWithWork()
    const seen: Array<ReturnType<typeof workDirMoveProgress>> = []
    await boot({ afterStep: () => void seen.push(workDirMoveProgress()) })
    expect(seen.length).toBeGreaterThan(0)
    expect(seen.every((p) => p !== null && p.total === 2)).toBe(true)
    expect(seen[0]?.done).toBe(0)
    expect(seen.at(-1)?.done).toBe(1)
    expect(workDirMoveProgress()).toBeNull()
  })

  it('moves a paused task on paper, and a resume rebuilds it at the new place', async () => {
    const { taskId, oldPath, branch } = await taskWithWork()
    expect(await actOnTaskWorkspace(taskId, 'pause')).toMatchObject({ ok: true })
    expect(existsSync(oldPath)).toBe(false)

    expect(await boot()).toMatchObject({ moved: 1 })
    const newPath = newPathOf(taskId, oldPath)
    expect(getWorkspaceForTask(getDb(), taskId)?.worktreePath).toBe(newPath)
    expect(existsSync(oldPath)).toBe(false)

    const resumed = await resumeTaskWorkspace(taskId, { repoPath: repo })
    expect(resumed).toMatchObject({ ok: true })
    if (!resumed.ok) return
    expect(resumed.worktree.worktreePath).toBe(newPath)
    expect(await readFile(path.join(newPath, 'work.txt'), 'utf8')).toBe('uncommitted work\n')
    expect(await onBranch(branch, 'work.txt')).toBe('uncommitted work\n')
  })

  it('moves a locked checkout by a rename and git worktree repair', async () => {
    const { taskId, oldPath } = await taskWithWork()
    await git(repo, ['worktree', 'lock', oldPath])
    expect(await boot()).toMatchObject({ moved: 1 })
    const newPath = newPathOf(taskId, oldPath)
    expect(await isWorktreeRegistered(repo, newPath)).toBe(true)
    await git(repo, ['worktree', 'prune'])
    expect(await isWorktreeRegistered(repo, newPath)).toBe(true)
    expect(await readFile(path.join(newPath, 'work.txt'), 'utf8')).toBe('uncommitted work\n')
  })

  it('keeps a team folder where it is when the new path already holds files', async () => {
    const team = await teamFolderWithFiles('T1')
    await mkdir(path.join(work, 'teams', 'T1'), { recursive: true })
    await writeFile(path.join(work, 'teams', 'T1', 'other.md'), 'someone else\n')

    expect(await boot()).toMatchObject({ moved: 0, conflicts: 1 })
    expect(lstatSync(team).isDirectory()).toBe(true)
    expect(await readFile(path.join(team, 'notes.md'), 'utf8')).toBe('notes of T1\n')
    expect(await readFile(path.join(work, 'teams', 'T1', 'other.md'), 'utf8')).toBe(
      'someone else\n',
    )
    // The team keeps using its folder, and another team still gets the new place.
    expect(teamWorkdirPath('T1')).toBe(team)
    expect(teamWorkdirPath('T2')).toBe(path.join(work, 'teams', 'T2'))
  })

  it('leaves both kinds on another volume, working where they are, and moves them later', async () => {
    const team = await teamFolderWithFiles('T1')
    const { taskId, oldPath } = await taskWithWork()

    expect(await boot({ sameVolume: () => false })).toMatchObject({ moved: 0, left: 2 })
    expect(lstatSync(team).isDirectory()).toBe(true)
    expect(teamWorkdirPath('T1')).toBe(team)
    expect(getWorkspaceForTask(getDb(), taskId)?.worktreePath).toBe(oldPath)
    expect(await readFile(path.join(oldPath, 'work.txt'), 'utf8')).toBe('uncommitted work\n')

    // The next boot tries again.
    expect(await boot()).toMatchObject({ moved: 2, left: 0 })
    expect(teamWorkdirPath('T1')).toBe(path.join(work, 'teams', 'T1'))
    expect(getWorkspaceForTask(getDb(), taskId)?.worktreePath).toBe(newPathOf(taskId, oldPath))
  })

  it('leaves a checkout git does not list, and one with a run still going', async () => {
    const lost = await taskWithWork()
    await rm(path.join(repo, '.git', 'worktrees', lost.taskId), { recursive: true, force: true })
    const busy = await taskWithWork()
    createExecutionProcess(getDb(), { taskId: busy.taskId, executorType: 'claude-code' })

    expect(await boot()).toMatchObject({ moved: 0, left: 2 })
    for (const t of [lost, busy]) {
      expect(lstatSync(t.oldPath).isDirectory()).toBe(true)
      expect(await readFile(path.join(t.oldPath, 'work.txt'), 'utf8')).toBe('uncommitted work\n')
      expect(getWorkspaceForTask(getDb(), t.taskId)?.worktreePath).toBe(t.oldPath)
    }
    const notes = workDirJournal().items.map((i) => i.note ?? '')
    expect(notes.some((n) => /does not list/.test(n))).toBe(true)
    expect(notes.some((n) => /run of the task/.test(n))).toBe(true)
  })

  it('treats a changed CLAWBOO_WORK_DIR as a move from the previous one', async () => {
    await teamFolderWithFiles('T1')
    const { taskId, oldPath } = await taskWithWork()
    expect(await boot()).toMatchObject({ moved: 2 })
    const firstPath = newPathOf(taskId, oldPath)

    const work2 = path.join(base, 'work-2')
    process.env['CLAWBOO_WORK_DIR'] = work2
    expect(workDirMovePending(getDb())).toBe(true)
    expect(await boot()).toMatchObject({ moved: 2, left: 0, conflicts: 0 })

    const secondPath = path.join(work2, 'worktrees', path.basename(path.dirname(oldPath)), taskId)
    expect(getWorkspaceForTask(getDb(), taskId)?.worktreePath).toBe(secondPath)
    expect(await isWorktreeRegistered(repo, secondPath)).toBe(true)
    expect(await readFile(path.join(secondPath, 'work.txt'), 'utf8')).toBe('uncommitted work\n')
    expect(teamWorkdirPath('T1')).toBe(path.join(work2, 'teams', 'T1'))
    // Links at both old places still reach the files.
    expect(realpathSync.native(firstPath)).toBe(secondPath)
    expect(await readFile(path.join(data, 'workspaces', 'T1', 'notes.md'), 'utf8')).toBe(
      'notes of T1\n',
    )
    expect(getSetting(getDb(), 'work-dir')).toBe(work2)
  })

  it('keeps trying a team folder left in a work folder that is no longer the previous one', async () => {
    await teamFolderWithFiles('T1')
    expect(await boot()).toMatchObject({ moved: 1 })
    const first = path.join(work, 'teams', 'T1')

    // A new work folder on "another volume": the team stays in the first one.
    process.env['CLAWBOO_WORK_DIR'] = path.join(base, 'work-2')
    expect(await boot({ sameVolume: () => false })).toMatchObject({ moved: 0, left: 1 })
    expect(teamWorkdirPath('T1')).toBe(first)
    // Again: the first folder is no longer the previous one, but the team is
    // still there and still kept, not handed a new empty folder.
    expect(await boot({ sameVolume: () => false })).toMatchObject({ left: 1 })
    expect(teamWorkdirPath('T1')).toBe(first)
    expect(await readFile(path.join(first, 'notes.md'), 'utf8')).toBe('notes of T1\n')

    expect(await boot()).toMatchObject({ moved: 1 })
    expect(teamWorkdirPath('T1')).toBe(path.join(base, 'work-2', 'teams', 'T1'))
    expect(await readFile(path.join(teamWorkdirPath('T1'), 'notes.md'), 'utf8')).toBe(
      'notes of T1\n',
    )
  })

  it('leaves a checkout whose folder is missing while git still lists it', async () => {
    const { taskId, oldPath } = await taskWithWork()
    // Out of reach, not removed: git still has it.
    await rm(oldPath, { recursive: true, force: true })
    expect(await boot()).toMatchObject({ moved: 0, left: 1 })
    expect(getWorkspaceForTask(getDb(), taskId)?.worktreePath).toBe(oldPath)
    expect(workDirJournal().items[0]?.note).toMatch(/git still lists it/)
  })

  it('never removes a file someone put at the temporary link name', async () => {
    const team = await teamFolderWithFiles('T1')
    const stray = path.join(path.dirname(team), '.T1.link')
    await writeFile(stray, 'not ours\n')
    expect(await boot()).toMatchObject({ moved: 0 })
    expect(await readFile(stray, 'utf8')).toBe('not ours\n')
    expect(await readFile(path.join(team, 'notes.md'), 'utf8')).toBe('notes of T1\n')
    expect(teamWorkdirPath('T1')).toBe(team)
  })

  it('ignores a journal entry that is not shaped like one the move writes', async () => {
    const victim = path.join(base, 'victim')
    await mkdir(victim)
    await writeFile(path.join(victim, 'keep.txt'), 'keep\n')
    setSetting(
      getDb(),
      'work-dir-migration',
      JSON.stringify({
        version: 1,
        items: [
          { kind: 'team', name: 'victim', from: victim, to: path.join(work, 'x'), state: 'moving' },
          { kind: 'team', name: '..', from: base, to: work, state: 'moving' },
        ],
      }),
    )
    await boot()
    expect(await readFile(path.join(victim, 'keep.txt'), 'utf8')).toBe('keep\n')
    expect(workDirJournal().items).toEqual([])
  })

  it('drops Claude Code session pointers when a team folder moves, and keeps the others', async () => {
    await teamFolderWithFiles('T1')
    const { taskId, oldPath } = await taskWithWork()
    const db = getDb()
    const now = Date.now()
    for (const [id, runtime] of [
      ['cc', 'claude-code'],
      ['cx', 'codex'],
    ] as const) {
      db.insert(agents)
        .values({
          id,
          name: id,
          runtime,
          teamId: 'T1',
          gatewayId: id,
          createdAt: now,
          updatedAt: now,
        })
        .run()
      setSetting(db, `native-chat-session:${id}`, `s-${id}`)
      setSetting(db, `native-team-session:${id}:T1`, `t-${id}`)
      setSetting(
        db,
        `team-chat-leader-state:room-1:${id}`,
        JSON.stringify({
          lastSeenSeq: 7,
          nativeSessionId: `l-${id}`,
          runtime,
          lastSummary: '',
          turnIndex: 2,
        }),
      )
    }
    await writeHandoff(oldPath, {
      handoffFrom: 'cc',
      runtime: 'claude-code',
      completedSubtasks: [],
      brokenOrUnverified: [],
      nextBestStep: 'go on',
      commands: { init: './init.sh', verify: '', start: '' },
      evidence: {},
      warnings: [],
      nativeSessionId: 'h-cc',
    })

    const report = await boot()
    expect(report.sessionsCleared).toBe(3)
    expect(getSetting(db, 'native-chat-session:cc')).toBeNull()
    expect(getSetting(db, 'native-team-session:cc:T1')).toBeNull()
    expect(JSON.parse(getSetting(db, 'team-chat-leader-state:room-1:cc') ?? '{}')).toMatchObject({
      lastSeenSeq: 7,
      nativeSessionId: null,
    })
    expect(getSetting(db, 'native-chat-session:cx')).toBe('s-cx')
    expect(getSetting(db, 'native-team-session:cx:T1')).toBe('t-cx')
    expect(JSON.parse(getSetting(db, 'team-chat-leader-state:room-1:cx') ?? '{}')).toMatchObject({
      nativeSessionId: 'l-cx',
    })
    const handoff = await readHandoff(newPathOf(taskId, oldPath))
    expect(handoff?.nextBestStep).toBe('go on')
    expect(handoff?.nativeSessionId ?? null).toBeNull()
  })

  it('cleans up only the orphans this install marked in the work folder', async () => {
    setWorkLayout('work')
    const db = getDb()
    const provisioned: Array<{ taskId: string; path: string }> = []
    for (let i = 0; i < 4; i++) {
      const task = createTask(db, { title: `task ${i}`, teamId: 'T1', status: 'todo' })
      expect(claimTask(db, task.id, 'agent-1', 'claude-code').ok).toBe(true)
      const prov = await provisionTaskWorkspace(task.id, { repoPath: repo, kind: 'code' })
      if (!prov.ok) throw new Error('provision failed')
      expect(prov.worktree.worktreePath.startsWith(path.join(work, 'worktrees'))).toBe(true)
      expect(readOwnerMarker(path.dirname(prov.worktree.worktreePath), task.id)).toBe(installId(db))
      provisioned.push({ taskId: task.id, path: prov.worktree.worktreePath })
    }
    const [kept, ours, theirs, unmarked] = provisioned
    // Three orphans, as a crash between making a checkout and recording it
    // leaves them: no task or row of this install names them. `kept` is in
    // progress, so GC skips it.
    for (const o of [ours, theirs, unmarked]) {
      db.delete(workspaces).where(eq(workspaces.taskId, o.taskId)).run()
      db.delete(tasks).where(eq(tasks.id, o.taskId)).run()
    }
    await writeFile(
      path.join(path.dirname(theirs.path), `.${theirs.taskId}.owner`),
      'another-install',
    )
    await rm(path.join(path.dirname(unmarked.path), `.${unmarked.taskId}.owner`))

    const summary = await gcTaskWorkspaces({ maxAgeMs: -1 })
    expect(summary.reaped).toContain(ours.taskId)
    expect(existsSync(ours.path)).toBe(false)
    expect(existsSync(path.join(path.dirname(ours.path), `.${ours.taskId}.owner`))).toBe(false)
    expect(existsSync(theirs.path)).toBe(true)
    expect(existsSync(unmarked.path)).toBe(true)
    expect(existsSync(kept.path)).toBe(true)
  })
})

// ── Kill at every step ──────────────────────────────────────────────────────

const WORKTREE_STEPS: WorkDirMoveStep[] = [
  'saved',
  'marked',
  'moving',
  'linkReady',
  'renamed',
  'linked',
  'checked',
  'recorded',
]
const TEAM_STEPS: WorkDirMoveStep[] = ['moving', 'linkReady', 'renamed', 'linked']

/** Boot the version before the move on what a kill left: the old layout, and no
 *  journal (it does not know one). */
function bootPreviousVersion(): void {
  setWorkLayout('data')
  setWorkDirJournal({ version: 1, items: [] })
}

describe.skipIf(isWindows)('a kill at every step of a checkout move', () => {
  it.each(WORKTREE_STEPS)(
    'after %s: the version before reads it, the next boot finishes',
    async (stop) => {
      const { taskId, oldPath, branch } = await taskWithWork()
      await expect(
        boot({
          afterStep: (item, s) => {
            if (item.kind === 'worktree' && s === stop) throw new Error('killed')
          },
        }),
      ).rejects.toBeInstanceOf(WorkDirMoveInterrupted)

      // The version before: nothing it does loses work, nothing crashes.
      bootPreviousVersion()
      const recorded = getWorkspaceForTask(getDb(), taskId)?.worktreePath ?? ''
      const reachable = existsSync(recorded)
      if (stop !== 'renamed') {
        // The record names a folder that has the work, directly or through a link.
        expect(reachable).toBe(true)
        expect(await readFile(path.join(recorded, 'work.txt'), 'utf8')).toBe('uncommitted work\n')
      }
      const paused = await actOnTaskWorkspace(taskId, 'pause')
      expect(paused).toMatchObject({ ok: true, action: 'pause' })
      expect((await gcTaskWorkspaces()).reaped).toEqual([])
      // Saved on the branch (by the move, or by that pause), so nothing is lost.
      expect(await onBranch(branch, 'work.txt')).toBe('uncommitted work\n')

      // The next boot finishes: the record names the new place, and a resume
      // there has the work.
      const report = await boot()
      expect(report.ran).toBe(true)
      expect(workDirJournal().items.some((i) => i.state === 'moving')).toBe(false)
      const newPath = newPathOf(taskId, oldPath)
      expect(getWorkspaceForTask(getDb(), taskId)?.worktreePath).toBe(newPath)
      const resumed = await resumeTaskWorkspace(taskId, { repoPath: repo })
      expect(resumed).toMatchObject({ ok: true })
      expect(await readFile(path.join(newPath, 'work.txt'), 'utf8')).toBe('uncommitted work\n')
      expect(await readFile(path.join(newPath, 'README.md'), 'utf8')).toBe('# changed\n')
      // Nothing of the task is left in the data folder but links.
      for (const name of readdirSync(path.dirname(oldPath))) {
        const st = lstatSync(path.join(path.dirname(oldPath), name))
        expect(st.isDirectory() && !st.isSymbolicLink()).toBe(false)
      }
    },
  )
})

describe.skipIf(isWindows)('a kill at every step of a team folder move', () => {
  it.each(TEAM_STEPS)(
    'after %s: the version before finds its files, the next boot finishes',
    async (stop) => {
      const team = await teamFolderWithFiles('T1')
      await expect(
        boot({
          afterStep: (item, s) => {
            if (item.kind === 'team' && s === stop) throw new Error('killed')
          },
        }),
      ).rejects.toBeInstanceOf(WorkDirMoveInterrupted)

      bootPreviousVersion()
      const dir = teamWorkdirPath('T1')
      expect(dir).toBe(team)
      // What the version before does with its team folder: a plain mkdir, which
      // goes through the link the move leaves at the old path. This version
      // refuses a link there; it never uses the old path once the move is done.
      await mkdir(dir, { recursive: true, mode: 0o700 })
      if (stop === 'renamed') {
        // The one gap, two system calls wide: the old path is missing, so the
        // version before makes it again, empty. The files are at the new path.
        expect(readdirSync(dir)).toEqual([])
      } else {
        expect(await readFile(path.join(dir, 'notes.md'), 'utf8')).toBe('notes of T1\n')
      }

      expect(await boot()).toMatchObject({ ran: true })
      expect(workDirJournal().items.some((i) => i.state === 'moving')).toBe(false)
      const moved = path.join(work, 'teams', 'T1')
      expect(teamWorkdirPath('T1')).toBe(moved)
      expect(await readFile(path.join(moved, 'notes.md'), 'utf8')).toBe('notes of T1\n')
      expect(lstatSync(team).isSymbolicLink()).toBe(true)
      expect(await readFile(path.join(team, 'notes.md'), 'utf8')).toBe('notes of T1\n')
    },
  )

  it('keeps both when the version before wrote into the folder it made in the gap', async () => {
    const team = await teamFolderWithFiles('T1')
    await expect(
      boot({
        afterStep: (item, s) => {
          if (item.kind === 'team' && s === 'renamed') throw new Error('killed')
        },
      }),
    ).rejects.toBeInstanceOf(WorkDirMoveInterrupted)
    bootPreviousVersion()
    await ensureTeamWorkdir(team)
    await writeFile(path.join(team, 'new.md'), 'written in the gap\n')

    expect(await boot()).toMatchObject({ ran: true })
    // Nothing that holds a file is removed: the team keeps the old folder.
    expect(teamWorkdirPath('T1')).toBe(team)
    expect(await readFile(path.join(team, 'new.md'), 'utf8')).toBe('written in the gap\n')
    expect(await readFile(path.join(work, 'teams', 'T1', 'notes.md'), 'utf8')).toBe('notes of T1\n')
    const item = workDirJournal().items.find((i) => i.kind === 'team')
    expect(item?.state).toBe('conflict')
  })
})

// ── Review follow-ups ───────────────────────────────────────────────────────

const LOCK = 'work-dir-migration-lock'
/** A lock as a live process that is not this one writes it. */
const foreignLock = (): string =>
  JSON.stringify({ pid: process.ppid, at: Date.now(), token: 'another-process' })

const withSession: AgentHandoffInput = {
  handoffFrom: 'cc',
  runtime: 'claude-code',
  completedSubtasks: [],
  brokenOrUnverified: [],
  nextBestStep: 'go on',
  commands: { init: './init.sh', verify: '', start: '' },
  evidence: {},
  warnings: [],
  nativeSessionId: 'h-cc',
}

function claudeCodeAgentWithSession(): void {
  const db = getDb()
  const now = Date.now()
  db.insert(agents)
    .values({
      id: 'cc',
      name: 'cc',
      runtime: 'claude-code',
      teamId: 'T1',
      gatewayId: 'cc',
      createdAt: now,
      updatedAt: now,
    })
    .run()
  setSetting(db, 'native-chat-session:cc', 's-cc')
}

const killAt =
  (kind: 'team' | 'worktree', stop: WorkDirMoveStep) =>
  (item: { kind: string }, s: WorkDirMoveStep): void => {
    if (item.kind === kind && s === stop) throw new Error('killed')
  }

describe('the work folder move, after review', () => {
  it('keeps a previous work folder that is out of reach on record, and moves from it once it is back', async () => {
    await teamFolderWithFiles('T1')
    expect(await boot()).toMatchObject({ moved: 1 })
    // The first work folder goes out of reach, as an unmounted drive does.
    const away = path.join(base, 'away')
    await rename(work, away)
    const work2 = path.join(base, 'work-2')
    process.env['CLAWBOO_WORK_DIR'] = work2
    await boot()
    expect(getSetting(getDb(), 'work-dir')).toBe(work)

    await rename(away, work)
    expect(await boot()).toMatchObject({ moved: 1, conflicts: 0 })
    expect(teamWorkdirPath('T1')).toBe(path.join(work2, 'teams', 'T1'))
    expect(await readFile(path.join(work2, 'teams', 'T1', 'notes.md'), 'utf8')).toBe(
      'notes of T1\n',
    )
    expect(getSetting(getDb(), 'work-dir')).toBe(work2)
  })

  it('moves work back to a work folder it came from, replacing its own links there', async () => {
    await teamFolderWithFiles('T1')
    const { taskId, oldPath } = await taskWithWork()
    expect(await boot()).toMatchObject({ moved: 2 })
    const firstPath = newPathOf(taskId, oldPath)
    process.env['CLAWBOO_WORK_DIR'] = path.join(base, 'work-2')
    expect(await boot()).toMatchObject({ moved: 2 })

    process.env['CLAWBOO_WORK_DIR'] = work
    expect(await boot()).toMatchObject({ moved: 2, left: 0, conflicts: 0 })
    const team = path.join(work, 'teams', 'T1')
    expect(teamWorkdirPath('T1')).toBe(team)
    expect(lstatSync(team).isSymbolicLink()).toBe(false)
    expect(await readFile(path.join(team, 'notes.md'), 'utf8')).toBe('notes of T1\n')
    expect(getWorkspaceForTask(getDb(), taskId)?.worktreePath).toBe(firstPath)
    expect(lstatSync(firstPath).isSymbolicLink()).toBe(false)
    expect(await isWorktreeRegistered(repo, firstPath)).toBe(true)
    expect(await readFile(path.join(firstPath, 'work.txt'), 'utf8')).toBe('uncommitted work\n')
  })

  it.skipIf(isWindows || isRoot)(
    'finishes a team folder move whose link at the old path cannot be made',
    async () => {
      const team = await teamFolderWithFiles('T1')
      await expect(boot({ afterStep: killAt('team', 'renamed') })).rejects.toBeInstanceOf(
        WorkDirMoveInterrupted,
      )
      const parent = path.dirname(team)
      await chmod(parent, 0o500)
      try {
        expect(await boot()).toMatchObject({ ran: true })
      } finally {
        await chmod(parent, 0o700)
      }
      const item = workDirJournal().items.find((i) => i.kind === 'team')
      expect(item?.state).toBe('moved')
      expect(item?.note).toMatch(/no link/)
      // Runs go where the files are, not to an empty old place.
      expect(teamWorkdirPath('T1')).toBe(path.join(work, 'teams', 'T1'))
      expect(await readFile(path.join(work, 'teams', 'T1', 'notes.md'), 'utf8')).toBe(
        'notes of T1\n',
      )
    },
  )

  it.skipIf(isWindows)(
    "drops a checkout's Claude Code session even when the move is killed right after the record",
    async () => {
      const { taskId, oldPath } = await taskWithWork()
      await writeHandoff(oldPath, withSession)
      await expect(boot({ afterStep: killAt('worktree', 'recorded') })).rejects.toBeInstanceOf(
        WorkDirMoveInterrupted,
      )
      await boot()
      const handoff = await readHandoff(newPathOf(taskId, oldPath))
      expect(handoff?.nextBestStep).toBe('go on')
      expect(handoff?.nativeSessionId ?? null).toBeNull()
    },
  )

  it.skipIf(isWindows)(
    'drops the session when a crash left another folder at the old path',
    async () => {
      const { taskId, oldPath } = await taskWithWork()
      await writeHandoff(oldPath, withSession)
      await expect(boot({ afterStep: killAt('worktree', 'renamed') })).rejects.toBeInstanceOf(
        WorkDirMoveInterrupted,
      )
      await mkdir(oldPath)
      await writeFile(path.join(oldPath, 'other.txt'), 'made in the gap\n')
      await boot()
      const newPath = newPathOf(taskId, oldPath)
      expect(getWorkspaceForTask(getDb(), taskId)?.worktreePath).toBe(newPath)
      expect((await readHandoff(newPath))?.nativeSessionId ?? null).toBeNull()
      expect(await readFile(path.join(oldPath, 'other.txt'), 'utf8')).toBe('made in the gap\n')
    },
  )

  it.skipIf(isWindows)(
    'drops Claude Code session pointers in the same write that says a team folder moved',
    async () => {
      await teamFolderWithFiles('T1')
      await taskWithWork()
      claudeCodeAgentWithSession()
      // Killed on the checkout, after the team folder moved and before the end.
      await expect(boot({ afterStep: killAt('worktree', 'saved') })).rejects.toBeInstanceOf(
        WorkDirMoveInterrupted,
      )
      expect(getSetting(getDb(), 'native-chat-session:cc')).toBeNull()
    },
  )

  it('waits while another live process is moving, then moves', async () => {
    await teamFolderWithFiles('T1')
    const db = getDb()
    setSetting(db, LOCK, foreignLock())
    const freed = setTimeout(() => db.delete(settings).where(eq(settings.key, LOCK)).run(), 150)
    try {
      expect(await boot({ lockPollMs: 20, lockWaitMs: 10_000 })).toMatchObject({
        ran: true,
        moved: 1,
      })
    } finally {
      clearTimeout(freed)
    }
    expect(getSetting(db, LOCK)).toBeNull()
  })

  it('stops, and leaves the lock alone, when another process takes the move over', async () => {
    await teamFolderWithFiles('T1')
    const second = await teamFolderWithFiles('T2')
    const db = getDb()
    const theirs = foreignLock()
    let taken = false
    await boot({
      lockPollMs: 10,
      lockWaitMs: 50,
      afterStep: (item, s) => {
        if (!taken && item.kind === 'team' && s === 'linked') {
          setSetting(db, LOCK, theirs)
          taken = true
        }
      },
    })
    expect(taken).toBe(true)
    expect(getSetting(db, LOCK)).toBe(theirs)
    // The rest is the new holder's: this one moved nothing more.
    expect(lstatSync(second).isSymbolicLink()).toBe(false)
    expect(await readFile(path.join(second, 'notes.md'), 'utf8')).toBe('notes of T2\n')

    // Once that one is gone, a boot finishes everything.
    db.delete(settings).where(eq(settings.key, LOCK)).run()
    await boot()
    for (const name of ['T1', 'T2']) {
      expect(teamWorkdirPath(name)).toBe(path.join(work, 'teams', name))
      expect(await readFile(path.join(work, 'teams', name, 'notes.md'), 'utf8')).toBe(
        `notes of ${name}\n`,
      )
    }
  })

  it('replaces an install id that is not a UUID, so reviews keep a folder of their own', () => {
    const db = getDb()
    setSetting(db, 'install-id', '-'.repeat(36))
    const id = installId(db)
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    setWorkLayout('work')
    expect(path.basename(reviewsRoot(db))).toHaveLength(12)
  })

  it.skipIf(isWindows)(
    'keeps a link at the new path that leads somewhere else, for a checkout that is gone',
    async () => {
      const { taskId, oldPath } = await taskWithWork()
      expect(await actOnTaskWorkspace(taskId, 'pause')).toMatchObject({ ok: true })
      const to = newPathOf(taskId, oldPath)
      await mkdir(path.dirname(to), { recursive: true })
      await symlink(path.join(base, 'nowhere'), to)
      expect(await boot()).toMatchObject({ moved: 0, conflicts: 1 })
      expect(lstatSync(to).isSymbolicLink()).toBe(true)
      expect(getWorkspaceForTask(getDb(), taskId)?.worktreePath).toBe(oldPath)
    },
  )

  it('leaves alone, unsaved, a checkout of another repository at a path git still lists', async () => {
    const { taskId, oldPath } = await taskWithWork()
    await rm(oldPath, { recursive: true, force: true })
    await mkdir(oldPath)
    await git(oldPath, ['init', '-b', 'main'])
    await git(oldPath, ['config', 'user.name', 'other'])
    await git(oldPath, ['config', 'user.email', 'other@example.com'])
    await writeFile(path.join(oldPath, 'a.txt'), 'one\n')
    await git(oldPath, ['add', '-A'])
    await git(oldPath, ['commit', '--no-verify', '-m', 'other'])
    await writeFile(path.join(oldPath, 'b.txt'), 'not committed\n')

    expect(await boot()).toMatchObject({ moved: 0, left: 1 })
    expect(workDirJournal().items.find((i) => i.kind === 'worktree')?.note).toMatch(
      /not a checkout of/,
    )
    expect(getWorkspaceForTask(getDb(), taskId)?.worktreePath).toBe(oldPath)
    expect((await git(oldPath, ['rev-list', '--count', 'HEAD'])).trim()).toBe('1')
    expect(await git(oldPath, ['status', '--porcelain'])).toContain('b.txt')
  })

  it('gives this install a folder of its own for review checkouts', () => {
    const db = getDb()
    setWorkLayout('work')
    const root = reviewsRoot(db)
    expect(path.dirname(root)).toBe(path.join(work, 'reviews'))
    expect(path.basename(root)).toBe(installId(db).replace(/-/g, '').slice(0, 12))
    setWorkLayout('data')
    expect(reviewsRoot(db)).toBe(path.join(data, 'reviews'))
  })
})
