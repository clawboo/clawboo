// A snapshot of a folder a teammate is changing can fail: git lists a file, the
// teammate deletes it, and the whole `git add` dies. That is the race the check's
// wait exists to remove, so it must not leave the work unchecked. Real git and a
// real board over a temp clawboo home, with chosen `git add` calls made to fail.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  agents,
  claimTask,
  createExecutionProcess,
  createTask,
  getComments,
  getTask,
  getTaskVerification,
  setSetting,
  setTaskVerification,
  teams,
  type ClawbooDb,
} from '@clawboo/db'
import type { WorkCheck } from '@clawboo/team-orchestration'

const failAdds = vi.hoisted(() => ({ left: 0 }))

vi.mock('@clawboo/worktrees', async (importOriginal) => {
  const real = await importOriginal<typeof import('@clawboo/worktrees')>()
  return {
    ...real,
    execGit: (cwd: string, args: string[]) => {
      if (args.includes('add') && failAdds.left > 0) {
        failAdds.left -= 1
        return Promise.reject(new Error("fatal: unable to stat 'tmp.txt': No such file"))
      }
      return real.execGit(cwd, args)
    },
  }
})

const { getDb, getDbPath, resetDb } = await import('../../db')
const { startFolderRun } = await import('../../runtimes/teamFolderActivity')
const { teamWorkdirPath } = await import('../../runtimes/teamWorkdir')
const { teamVerifyCommandSettingKey } = await import('../../verification/teamVerifyCommand')
const { createTeamWorkCheck } = await import('../teamWorkCheck')

const TEAM = 'T'
const AGENT = 'coder'
const NEVER = new AbortController().signal
/** More than one measure's worth of tries. */
const MANY = 1_000

describe('a team work check when the folder cannot be snapshotted', () => {
  let home: string
  const prev: Record<string, string | undefined> = {}
  let db: ClawbooDb
  let folder: string
  let wc: WorkCheck
  let taskId = ''

  const claimed = (): void => {
    const t = createTask(db, { title: 'change a file', teamId: TEAM })
    claimTask(db, t.id, AGENT)
    createExecutionProcess(db, { taskId: t.id, executorType: 'openclaw' })
    taskId = t.id
  }
  const change = (): Promise<void> => writeFile(path.join(folder, `${taskId}.txt`), 'work\n')
  const commentsOf = (id: string): string[] => getComments(db, id).map((c) => c.body)

  beforeEach(async () => {
    failAdds.left = 0
    home = await mkdtemp(path.join(os.tmpdir(), 'clawboo-work-check-snap-'))
    for (const k of ['HOME', 'CLAWBOO_HOME', 'CLAWBOO_MAX_FIX_CYCLES']) prev[k] = process.env[k]
    process.env['HOME'] = home
    process.env['CLAWBOO_HOME'] = path.join(home, '.clawboo')
    delete process.env['CLAWBOO_MAX_FIX_CYCLES']
    expect(getDbPath().startsWith(home)).toBe(true)
    db = getDb()
    const now = Date.now()
    db.insert(teams)
      .values({ id: TEAM, name: 'T', icon: 'T', color: '#000', createdAt: now, updatedAt: now })
      .run()
    db.insert(agents)
      .values({
        id: AGENT,
        name: 'Coder',
        gatewayId: AGENT,
        sourceId: 'claude-code',
        runtime: 'claude-code',
        teamId: TEAM,
        createdAt: now,
        updatedAt: now,
      })
      .run()
    folder = teamWorkdirPath(TEAM)
    await mkdir(folder, { recursive: true })
    setSetting(db, teamVerifyCommandSettingKey(TEAM), JSON.stringify({ command: 'node -v' }))
    wc = createTeamWorkCheck({ db, teamId: TEAM, mcpBaseUrl: null })
  })
  afterEach(async () => {
    resetDb()
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    await rm(home, { recursive: true, force: true })
  })

  it('a file gone mid-add at the end of a run is tried again, and the work is checked', async () => {
    claimed()
    await wc.begin(taskId, AGENT)
    await change()
    failAdds.left = 1

    const prepared = await wc.prepare(taskId, AGENT)

    expect(prepared).not.toBeNull()
    expect((await prepared!()).verdict).toBe('pass')
    expect(getTaskVerification(db, taskId)?.status).toBe('pass')
    expect(commentsOf(taskId)).toEqual([])
  })

  it('a file gone mid-add as the task starts is tried again, and it still has its start', async () => {
    claimed()
    failAdds.left = 1
    await wc.begin(taskId, AGENT)
    await change()

    const prepared = await wc.prepare(taskId, AGENT)

    expect(prepared).not.toBeNull()
    expect(commentsOf(taskId)).toEqual([])
  })

  it('a folder that cannot be staged as the task starts still leaves its work checked', async () => {
    // An earlier task's snapshot, then one that cannot stage at all.
    claimed()
    await wc.begin(taskId, AGENT)
    claimed()
    failAdds.left = MANY
    await wc.begin(taskId, AGENT)
    failAdds.left = 0
    await change()

    const prepared = await wc.prepare(taskId, AGENT)

    expect(prepared).not.toBeNull()
    expect((await prepared!()).verdict).toBe('pass')
    expect(getTaskVerification(db, taskId)?.status).toBe('pass')
    expect(commentsOf(taskId)).toEqual([])
  })

  it('a measure that fails beside a teammate waits for the teammate, then checks', async () => {
    claimed()
    await wc.begin(taskId, AGENT)
    await change()
    const run = startFolderRun(folder, 'mate')
    failAdds.left = MANY

    const prepared = await wc.prepare(taskId, AGENT)
    expect(prepared).not.toBeNull()
    expect(getTask(db, taskId)?.status).toBe('in_progress')
    const held = prepared!.hold!(NEVER)
    await new Promise((r) => setImmediate(r))
    expect(getTask(db, taskId)?.status).toBe('in_review')
    expect(commentsOf(taskId).some((c) => /could not see/.test(c))).toBe(false)

    failAdds.left = 0
    run.release()
    const giveBack = await held
    expect((await prepared!()).verdict).toBe('pass')
    giveBack()
    expect(getTaskVerification(db, taskId)?.status).toBe('pass')
    expect(getTask(db, taskId)?.checkHeldSince).toBeNull()
  })

  it('a measure that fails again after the wait gives up the way it always did, and says so', async () => {
    claimed()
    await wc.begin(taskId, AGENT)
    await change()
    const run = startFolderRun(folder, 'mate')
    failAdds.left = MANY

    const prepared = await wc.prepare(taskId, AGENT)
    const held = prepared!.hold!(NEVER)
    run.release()
    const giveBack = await held
    expect(await prepared!()).toEqual({ verdict: 'unchecked' })
    giveBack()

    expect(commentsOf(taskId).some((c) => /could not see what this run changed/.test(c))).toBe(true)
    expect(getTask(db, taskId)?.checkHeldSince).toBeNull()
    expect(getTaskVerification(db, taskId)).toBeNull()
  })

  it('after an earlier failed attempt, a measure that keeps failing goes to a person', async () => {
    claimed()
    await wc.begin(taskId, AGENT)
    await change()
    const attempt = {
      attempt: 1,
      at: Date.now(),
      deterministic: {
        passed: false,
        command: 'node -v',
        commandSource: 'configured',
        exitCode: 1,
        timedOut: false,
        stdoutTail: '',
        stderrTail: '',
        durationMs: 1,
      },
      critic: {
        ran: false,
        findings: [],
        reviewerRuntime: null,
        reviewerModel: null,
        reviewedSha: null,
      },
      status: 'fail',
      structuredError: null,
    }
    setTaskVerification(db, taskId, {
      status: 'fail',
      attempts: [attempt],
      debtNotes: [],
      updatedAt: Date.now(),
    } as never)
    failAdds.left = MANY

    const prepared = await wc.prepare(taskId, AGENT)
    const giveBack = await prepared!.hold!(NEVER)
    const result = await prepared!()
    giveBack()

    expect(result.verdict).toBe('failed')
    expect(getTask(db, taskId)?.status).toBe('blocked')
  })

  it('a folder found unchanged once it could be measured needs no check', async () => {
    claimed()
    await wc.begin(taskId, AGENT)
    failAdds.left = 3 // this measure's every try

    const prepared = await wc.prepare(taskId, AGENT)
    expect(prepared).not.toBeNull()
    const giveBack = await prepared!.hold!(NEVER)
    expect(await prepared!()).toEqual({ verdict: 'unchecked' })
    giveBack()

    expect(getTaskVerification(db, taskId)).toBeNull()
  })
})
