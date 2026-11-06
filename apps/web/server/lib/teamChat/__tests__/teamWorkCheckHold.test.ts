// The server's side of holding a check: what it does while a run is working in the
// team folder, what the wait leaves on the task, and what the check then looks at.
// A real work check and a real board over one temp clawboo home; the runs are
// reported directly, and the engine's part is played by hand.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  agents,
  claimTask,
  createExecutionProcess,
  createTask,
  getComments,
  getTask,
  getTaskVerification,
  orchestrationEvents,
  setSetting,
  setTaskCheckHeld,
  teams,
  updateStatus,
  type ClawbooDb,
} from '@clawboo/db'
import type { BoardChange, PreparedWorkCheck, WorkCheck } from '@clawboo/team-orchestration'
import { eq } from 'drizzle-orm'

import { getDb, getDbPath, resetDb } from '../../db'
import { startFolderRun } from '../../runtimes/teamFolderActivity'
import { teamWorkdirPath } from '../../runtimes/teamWorkdir'
import { teamVerifyCommandSettingKey } from '../../verification/teamVerifyCommand'
import { createTeamWorkCheck } from '../teamWorkCheck'

const TEAM = 'T'
const AGENT = 'coder'
const MATE = 'mate'

describe('holding a team work check', () => {
  let home: string
  const prev: Record<string, string | undefined> = {}
  let db: ClawbooDb
  let folder: string
  let wc: WorkCheck
  const changes: BoardChange[] = []

  const verifyFailsOn = (file: string): void =>
    setSetting(
      db,
      teamVerifyCommandSettingKey(TEAM),
      JSON.stringify({
        command: `node -e "process.exit(require('fs').existsSync('${file}') ? 1 : 0)"`,
      }),
    )

  let taskId = ''

  /** A claimed task with a run open, its start recorded, and a change in the folder. */
  const finishedTask = async (title = 'change a file'): Promise<PreparedWorkCheck> => {
    const t = createTask(db, { title, teamId: TEAM })
    claimTask(db, t.id, AGENT)
    createExecutionProcess(db, { taskId: t.id, executorType: 'openclaw' })
    await wc.begin(t.id, AGENT)
    await writeFile(path.join(folder, `${t.id}.txt`), 'work\n')
    taskId = t.id
    const prepared = await wc.prepare(t.id, AGENT)
    expect(prepared).not.toBeNull()
    return prepared!
  }

  const commentsOf = (id: string): string[] => getComments(db, id).map((c) => c.body)

  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), 'clawboo-work-check-hold-'))
    for (const k of ['HOME', 'CLAWBOO_HOME', 'CLAWBOO_MAX_FIX_CYCLES']) prev[k] = process.env[k]
    process.env['HOME'] = home
    process.env['CLAWBOO_HOME'] = path.join(home, '.clawboo')
    delete process.env['CLAWBOO_MAX_FIX_CYCLES']
    expect(getDbPath().startsWith(home)).toBe(true)
    db = getDb()
    const now = Date.now()
    db.insert(teams)
      .values({
        id: TEAM,
        name: 'Team',
        icon: '🚀',
        color: '#e94560',
        createdAt: now,
        updatedAt: now,
      })
      .run()
    db.insert(agents)
      .values(
        [
          [AGENT, 'Coder'],
          [MATE, 'Mate'],
        ].map(([id, name]) => ({
          id: id!,
          name: name!,
          gatewayId: id!,
          sourceId: 'claude-code',
          runtime: 'claude-code',
          teamId: TEAM,
          createdAt: now,
          updatedAt: now,
        })),
      )
      .run()
    folder = teamWorkdirPath(TEAM)
    await mkdir(folder, { recursive: true })
    changes.length = 0
    wc = createTeamWorkCheck({
      db,
      teamId: TEAM,
      mcpBaseUrl: null,
      onBoardChange: (change) => changes.push(change),
    })
    verifyFailsOn('half.txt')
  })
  afterEach(async () => {
    resetDb()
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    await rm(home, { recursive: true, force: true })
  })

  it('a waiting mark left behind never reads as waiting during a real check', async () => {
    const prepared = await finishedTask()
    setTaskCheckHeld(db, taskId, 1_700_000_000_000)
    const giveBack = await prepared.hold!(new AbortController().signal)

    expect((await prepared()).verdict).toBe('pass')
    giveBack()
    expect(getTask(db, taskId)?.checkHeldSince).toBeNull()
  })

  it('a card moved back to In progress during the wait is not pulled back, and gets no verdict', async () => {
    const run = startFolderRun(folder, MATE)
    const prepared = await finishedTask()
    const limit = new AbortController()
    const held = prepared.hold!(limit.signal)
    await new Promise((r) => setImmediate(r))

    expect(updateStatus(db, taskId, 'in_progress', { actor: 'person' }).ok).toBe(true)
    limit.abort()
    const giveBack = await held
    expect((await prepared()).verdict).toBe('decided')
    giveBack()
    run.release()

    expect(getTask(db, taskId)?.status).toBe('in_progress')
    expect(getTaskVerification(db, taskId)).toBeNull()
  })

  it('a clear folder holds nothing: no move, no note, and nothing on the verdict', async () => {
    const prepared = await finishedTask()
    const giveBack = await prepared.hold!(new AbortController().signal)

    expect(getTask(db, taskId)?.status).toBe('in_progress')
    expect(getTask(db, taskId)?.checkHeldSince).toBeNull()
    expect(commentsOf(taskId)).toEqual([])

    expect((await prepared()).verdict).toBe('pass')
    giveBack()
    expect(getTaskVerification(db, taskId)?.attempts[0]?.hold).toBeUndefined()
  })

  it('a busy folder moves the card to In review, marks it waiting, and names who is in there', async () => {
    const run = startFolderRun(folder, MATE)
    const prepared = await finishedTask()
    const held = prepared.hold!(new AbortController().signal)
    await new Promise((r) => setImmediate(r))

    const task = getTask(db, taskId)!
    expect(task.status).toBe('in_review')
    expect(task.checkHeldSince).toEqual(expect.any(Number))
    expect(commentsOf(taskId)).toHaveLength(1)
    expect(commentsOf(taskId)[0]).toMatch(/Mate is still working in the team folder/)
    expect(commentsOf(taskId)[0]).toMatch(/15 minutes/)
    expect(changes).toEqual([
      {
        id: taskId,
        status: 'in_review',
        checkHeldSince: task.checkHeldSince,
        updatedAt: expect.any(Number),
      },
    ])
    const logged = db
      .select()
      .from(orchestrationEvents)
      .where(eq(orchestrationEvents.taskId, taskId))
      .all()
      .filter((e) => e.kind === 'status_changed')
    expect(logged).toHaveLength(1)
    expect(JSON.parse(logged[0]!.data ?? '{}')).toMatchObject({
      to: 'in_review',
      reason: 'check_waiting',
    })

    run.release()
    const giveBack = await held
    expect((await prepared()).verdict).toBe('pass')
    giveBack()
    expect(changes.at(-1)).toMatchObject({ id: taskId, status: 'in_review', checkHeldSince: null })

    expect(getTask(db, taskId)?.checkHeldSince).toBeNull()
    const hold = getTaskVerification(db, taskId)?.attempts[0]?.hold
    expect(hold?.limitReached).toBe(false)
    expect(hold?.runBeside).toBe(false)
    expect(hold?.waitedMs).toBeGreaterThanOrEqual(0)
  })

  it('checks and measures the folder as it is after the wait, not as the run left it', async () => {
    const run = startFolderRun(folder, MATE)
    await writeFile(path.join(folder, 'half.txt'), 'half way\n')
    const prepared = await finishedTask()
    const held = prepared.hold!(new AbortController().signal)
    await rm(path.join(folder, 'half.txt'))
    run.release()
    const giveBack = await held

    expect((await prepared()).verdict).toBe('pass')
    giveBack()
    expect(getTaskVerification(db, taskId)?.status).toBe('pass')
  })

  it('at the limit it checks, says so, and warns the agent the failure may not be its own', async () => {
    const run = startFolderRun(folder, MATE)
    await writeFile(path.join(folder, 'half.txt'), 'half way\n')
    const prepared = await finishedTask()
    const limit = new AbortController()
    const held = prepared.hold!(limit.signal)
    await new Promise((r) => setImmediate(r))

    limit.abort()
    const giveBack = await held
    const result = await prepared()
    giveBack()
    run.release()

    expect(result.verdict).toBe('retry')
    if (result.verdict === 'retry')
      expect(result.fixNote).toMatch(/may come from its unfinished work rather than yours/)
    const hold = getTaskVerification(db, taskId)?.attempts[0]?.hold
    expect(hold?.limitReached).toBe(true)
    expect(hold?.runBeside).toBe(true)
    expect(commentsOf(taskId).some((c) => /Stopped waiting after 15 minutes/.test(c))).toBe(true)
    expect(getTask(db, taskId)?.checkHeldSince).toBeNull()
  })

  it('a run that starts during the check is on the verdict, with no wait', async () => {
    const prepared = await finishedTask()
    const giveBack = await prepared.hold!(new AbortController().signal)
    const run = startFolderRun(folder, MATE)

    expect((await prepared()).verdict).toBe('pass')
    giveBack()
    run.release()

    const hold = getTaskVerification(db, taskId)?.attempts[0]?.hold
    expect(hold).toEqual({ waitedMs: 0, limitReached: false, runBeside: true })
  })

  it('a second check waits for the one running, and says so', async () => {
    const first = await finishedTask('first')
    const firstBack = await first.hold!(new AbortController().signal)
    const second = await finishedTask('second')
    const secondHeld = second.hold!(new AbortController().signal)
    await new Promise((r) => setImmediate(r))

    expect(getTask(db, taskId)?.status).toBe('in_review')
    expect(commentsOf(taskId)[0]).toMatch(/another task's check is running/)

    firstBack()
    const secondBack = await secondHeld
    secondBack()
  })

  it('a card a person moved before the wait began is not waited for', async () => {
    const run = startFolderRun(folder, MATE)
    const prepared = await finishedTask()
    expect(updateStatus(db, taskId, 'done', { actor: 'person' }).ok).toBe(true)

    const giveBack = await prepared.hold!(new AbortController().signal)
    expect((await prepared()).verdict).toBe('decided')
    giveBack()
    run.release()

    expect(getTaskVerification(db, taskId)).toBeNull()
    expect(getTask(db, taskId)?.checkHeldSince).toBeNull()
  })

  it('a card a person moved during the wait gets no verdict, even if the check is asked to run', async () => {
    const run = startFolderRun(folder, MATE)
    const prepared = await finishedTask()
    const limit = new AbortController()
    const held = prepared.hold!(limit.signal)
    await new Promise((r) => setImmediate(r))

    expect(updateStatus(db, taskId, 'cancelled', { actor: 'person' }).ok).toBe(true)
    expect(getTask(db, taskId)?.checkHeldSince).toBeNull()
    limit.abort()
    const giveBack = await held
    expect((await prepared()).verdict).toBe('decided')
    giveBack()
    run.release()

    expect(getTaskVerification(db, taskId)).toBeNull()
  })
})
