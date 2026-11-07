// The team chat's work check over a real team folder, a real git history kept
// outside it, and the task runner's real verification gate (the team's verify
// command runs through a shell). A temp clawboo home holds the database, the
// folder and the history; a scripted reviewer stands in for the runtime.

import { existsSync } from 'node:fs'
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
  listGovernanceAudit,
  setBudgetLimit,
  setSetting,
  tasks,
  teams,
  updateStatus,
  placePause,
  type ClawbooDb,
} from '@clawboo/db'
import type {
  Capabilities,
  RunHandle,
  RuntimeAdapter,
  RuntimeEvent,
  StartOpts,
  TaskHandle,
} from '@clawboo/executor'
import type { WorkCheckResult } from '@clawboo/team-orchestration'
import { execGit } from '@clawboo/worktrees'
import { eq } from 'drizzle-orm'

import { getDb, getDbPath, resetDb } from '../../db'
import { startFolderRun } from '../../runtimes/teamFolderActivity'
import { teamWorkdirPath } from '../../runtimes/teamWorkdir'
import { teamVerifyCommandSettingKey } from '../../verification/teamVerifyCommand'
import { noteHumanMove } from '../humanMove'
import { createTeamWorkCheck, teamFolderHistoryDir } from '../teamWorkCheck'

const TEAM = 'T'
const AGENT = 'coder'

/** A reviewer that reads nothing and finds nothing. */
class QuietReviewer implements RuntimeAdapter {
  readonly participantKind = 'agent' as const
  readonly id = 'claude-code'
  readonly started: StartOpts[] = []
  capabilities(): Capabilities {
    return {
      streaming: true,
      mcp: false,
      worktrees: true,
      resume: false,
      toolApproval: false,
      models: [],
      runtimeClass: 'wrapped-oneshot',
    }
  }
  async health(): Promise<{ ok: boolean }> {
    return { ok: true }
  }
  async start(_t: TaskHandle, opts: StartOpts): Promise<RunHandle> {
    this.started.push(opts)
    return { adapterId: this.id, sessionKey: opts.sessionKey, runId: null }
  }
  events(): AsyncIterable<RuntimeEvent> {
    return (async function* () {
      yield {
        kind: 'done',
        reason: 'success',
        summary: '{"findings":[]}',
        runId: 'review',
        sessionId: null,
        ts: 1,
        seq: 1,
      } as RuntimeEvent
    })()
  }
  async abort(): Promise<void> {}
  async setModel(): Promise<void> {}
  async writeContext(): Promise<void> {}
}

describe('team chat work check', () => {
  let home: string
  const prev: Record<string, string | undefined> = {}
  let db: ClawbooDb
  let folder: string
  let reviewer: QuietReviewer

  const check = () =>
    createTeamWorkCheck({
      db,
      teamId: TEAM,
      mcpBaseUrl: null,
      makeReviewerAdapter: () => () => reviewer,
    })

  const setCommand = (command: string): void =>
    setSetting(db, teamVerifyCommandSettingKey(TEAM), JSON.stringify({ command }))

  const startTask = (title = 'make the parser handle quotes'): string => {
    const t = createTask(db, { title, teamId: TEAM })
    claimTask(db, t.id, AGENT)
    return t.id
  }

  const runCheck = async (
    wc: ReturnType<typeof check>,
    taskId: string,
  ): Promise<WorkCheckResult | null> => {
    const run = await wc.prepare(taskId, AGENT)
    return run ? run() : null
  }

  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), 'clawboo-work-check-'))
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
    reviewer = new QuietReviewer()
  })
  afterEach(async () => {
    resetDb()
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    await rm(home, { recursive: true, force: true })
  })

  it('says when a teammate worked in the folder during the run', async () => {
    setCommand('true')
    const wc = check()
    const id = startTask()
    await wc.begin(id, AGENT)
    const mine = startFolderRun(folder, AGENT)
    const theirs = startFolderRun(folder, 'teammate')
    await writeFile(path.join(folder, 'notes.md'), '# notes\n')
    theirs.release()
    mine.release()
    const shared = await wc.prepare(id, AGENT)
    expect(shared?.sharedFolder).toBe(true)

    const alone = startFolderRun(folder, AGENT)
    await writeFile(path.join(folder, 'more.md'), '# more\n')
    alone.release()
    const quiet = await wc.prepare(id, AGENT)
    expect(quiet?.sharedFolder).toBe(false)
  })

  it('checks nothing when the team has no verify command', async () => {
    const wc = check()
    const id = startTask()
    await wc.begin(id, AGENT)
    await writeFile(path.join(folder, 'notes.md'), '# notes\n').catch(() => undefined)

    expect(await wc.prepare(id, AGENT)).toBeNull()
    expect(existsSync(teamFolderHistoryDir(TEAM))).toBe(false)
  })

  it('checks nothing when the run changed nothing', async () => {
    setCommand('exit 1')
    const wc = check()
    const id = startTask()
    await wc.begin(id, AGENT)

    expect(await wc.prepare(id, AGENT)).toBeNull()
    expect(getTask(db, id)?.status).toBe('in_progress')
  })

  it("passes a change the team's command passes, and leaves the card in review for the engine", async () => {
    setCommand('test -f parser.ts')
    const wc = check()
    const id = startTask()
    await wc.begin(id, AGENT)
    await writeFile(path.join(folder, 'parser.ts'), 'export const parse = () => []\n')

    expect(await runCheck(wc, id)).toEqual({ verdict: 'pass' })
    expect(getTask(db, id)?.status).toBe('in_review')
    const verdict = getTaskVerification(db, id)
    expect(verdict?.status).toBe('pass')
    expect(verdict?.attempts[0]?.deterministic.commandSource).toBe('configured')
    // The team folder gets no git checkout and no evidence file.
    expect(existsSync(path.join(folder, '.git'))).toBe(false)
    expect(existsSync(path.join(folder, 'VERIFICATION.md'))).toBe(false)
  })

  it('sends a failing change back with a fix note while an attempt is left, then parks it', async () => {
    setCommand('test -f tests-pass')
    const wc = check()
    const id = startTask()
    await wc.begin(id, AGENT)
    await writeFile(path.join(folder, 'parser.ts'), 'broken\n')

    const first = await runCheck(wc, id)
    expect(first?.verdict).toBe('retry')
    expect(first && 'fixNote' in first ? first.fixNote : '').toMatch(/What: .*test -f tests-pass/)
    expect(getTask(db, id)?.status).toBe('in_progress')

    // The fix round changes the folder again, and the check fails again.
    await writeFile(path.join(folder, 'parser.ts'), 'still broken\n')
    const second = await runCheck(wc, id)
    expect(second?.verdict).toBe('failed')
    expect(getTask(db, id)?.status).toBe('blocked')
    expect(getTaskVerification(db, id)?.attempts).toHaveLength(2)
  })

  it('counts only the failures when it parks a task, not an earlier pass', async () => {
    process.env['CLAWBOO_MAX_FIX_CYCLES'] = '1'
    setCommand('test -f tests-pass')
    const wc = check()
    const id = startTask()
    await wc.begin(id, AGENT)
    await writeFile(path.join(folder, 'tests-pass'), '')
    await writeFile(path.join(folder, 'parser.ts'), 'works\n')
    expect((await runCheck(wc, id))?.verdict).toBe('pass')

    // A person's comment gets a turn before Done, and that turn breaks the check.
    updateStatus(db, id, 'in_progress')
    await wc.begin(id, AGENT)
    await rm(path.join(folder, 'tests-pass'))
    expect((await runCheck(wc, id))?.verdict).toBe('failed')

    expect(getTaskVerification(db, id)?.attempts).toHaveLength(2)
    const parked = getComments(db, id)
      .map((c) => c.body)
      .filter((b) => /fix loop is exhausted/.test(b))
    expect(parked).toHaveLength(1)
    expect(parked[0]).toMatch(/^Verification failed once and the fix loop is exhausted/)
  })

  it('counts every failure when none of them passed', async () => {
    process.env['CLAWBOO_MAX_FIX_CYCLES'] = '1'
    setCommand('test -f tests-pass')
    const wc = check()
    const id = startTask()
    await wc.begin(id, AGENT)
    await writeFile(path.join(folder, 'parser.ts'), 'broken\n')
    expect((await runCheck(wc, id))?.verdict).toBe('retry')
    await writeFile(path.join(folder, 'parser.ts'), 'still broken\n')
    expect((await runCheck(wc, id))?.verdict).toBe('failed')
    const parked = getComments(db, id).find((c) => /fix loop is exhausted/.test(c.body))
    expect(parked?.body).toMatch(/^Verification failed 2 times and/)
  })

  it('measures a fix round from where the task began, not from the first attempt', async () => {
    setCommand('test -f a.txt && test -f b.txt')
    const wc = check()
    const id = startTask()
    await wc.begin(id, AGENT)
    await writeFile(path.join(folder, 'a.txt'), 'a\n')
    expect((await runCheck(wc, id))?.verdict).toBe('retry')

    await writeFile(path.join(folder, 'b.txt'), 'b\n')
    expect(await runCheck(wc, id)).toEqual({ verdict: 'pass' })
    expect(getTaskVerification(db, id)?.attempts).toHaveLength(2)
  })

  it('starts no reviewer once a pause covers the task, and records that the review did not run', async () => {
    setCommand('true')
    const wc = check()
    const id = startTask()
    await wc.begin(id, AGENT)
    for (let i = 0; i < 6; i++)
      await writeFile(path.join(folder, `f${i}.ts`), `export const v = ${i}\n`)
    placePause(db, { kind: 'agent', id: AGENT })

    await runCheck(wc, id)
    expect(reviewer.started).toHaveLength(0)
    const critic = getTaskVerification(db, id)?.attempts[0]?.critic
    expect(critic?.outcome).toBe('errored')
    expect(critic?.findings[0]?.body).toContain('paused')
  })

  it('has a reviewer read a large change, on a checkout made from the history', async () => {
    setCommand('true')
    const wc = check()
    const id = startTask()
    await wc.begin(id, AGENT)
    for (let i = 0; i < 6; i++)
      await writeFile(path.join(folder, `f${i}.ts`), `export const v = ${i}\n`)

    expect(await runCheck(wc, id)).toEqual({ verdict: 'pass' })
    expect(reviewer.started).toHaveLength(1)
    const critic = getTaskVerification(db, id)?.attempts[0]?.critic
    expect(critic?.ran).toBe(true)
    expect(critic?.outcome).toBe('reviewed')
    expect(critic?.reviewedSha).toMatch(/^[0-9a-f]{40}$/)
  })

  it('writes the audit row when what its reviewer cost crosses a budget', async () => {
    class CostlyReviewer extends QuietReviewer {
      override events(): AsyncIterable<RuntimeEvent> {
        return (async function* () {
          yield {
            kind: 'cost',
            costUsd: 0.9,
            usage: { inputTokens: 10, outputTokens: 10 },
            model: 'claude-sonnet-4-6',
            runId: 'review',
            sessionId: null,
            ts: 1,
            seq: 1,
          } as RuntimeEvent
          yield {
            kind: 'done',
            reason: 'success',
            summary: '{"findings":[]}',
            runId: 'review',
            sessionId: null,
            ts: 2,
            seq: 2,
          } as RuntimeEvent
        })()
      }
    }
    reviewer = new CostlyReviewer()
    setBudgetLimit(db, { scope: 'team', scopeId: TEAM, limitUsdCents: 100, mode: 'warn' })
    setCommand('true')
    const wc = check()
    const id = startTask()
    await wc.begin(id, AGENT)
    for (let i = 0; i < 6; i++)
      await writeFile(path.join(folder, `f${i}.ts`), `export const v = ${i}\n`)

    expect(await runCheck(wc, id)).toEqual({ verdict: 'pass' })
    const [row] = listGovernanceAudit(db, { eventType: 'budget' })
    expect(row).toMatchObject({ agentId: AGENT, teamId: TEAM, taskId: id })
    expect(JSON.parse(row!.summary)).toMatchObject({
      reason: 'warn',
      level: 'soft',
      scope: 'team',
      runKind: 'team-chat',
    })
  })

  it('leaves a task a person already moved alone', async () => {
    setCommand('true')
    const wc = check()
    const id = startTask()
    await wc.begin(id, AGENT)
    await writeFile(path.join(folder, 'x.txt'), 'x\n')
    const run = await wc.prepare(id, AGENT)
    updateStatus(db, id, 'done') // a person marks it done before the check starts

    expect(await run!()).toEqual({ verdict: 'decided' })
    expect(getTask(db, id)?.status).toBe('done')
  })

  /** Attempt 1 changes the folder and fails, leaving a fix round to come. */
  const failFirstAttempt = async (wc: ReturnType<typeof check>, id: string): Promise<void> => {
    await wc.begin(id, AGENT)
    await writeFile(path.join(folder, 'parser.ts'), 'broken\n')
    expect((await runCheck(wc, id))?.verdict).toBe('retry')
  }

  it('still checks a fix round that undid every change', async () => {
    setCommand('test -f tests-pass')
    const wc = check()
    const id = startTask()
    await failFirstAttempt(wc, id)
    await rm(path.join(folder, 'parser.ts'))

    const run = await wc.prepare(id, AGENT)
    expect(run).not.toBeNull()
    expect((await run!())?.verdict).toBe('failed')
    expect(getTask(db, id)?.status).toBe('blocked')
  })

  it('sends a fix round it can no longer check to a person', async () => {
    setCommand('test -f tests-pass')
    const wc = check()
    const id = startTask()
    await failFirstAttempt(wc, id)
    await rm(teamFolderHistoryDir(TEAM), { recursive: true, force: true })
    await writeFile(path.join(folder, 'parser.ts'), 'fixed\n')

    const result = await runCheck(wc, id)
    expect(result?.verdict).toBe('failed')
    expect(getTask(db, id)?.status).toBe('blocked')
  })

  // These two need a command that waits, then fails, and that shell loop is POSIX. The
  // engine's handling of a check that is overtaken is the same on every platform.
  //
  // The check first runs a few git calls, and only then says which run it speaks for
  // and moves the card. So the move these tests make waits for the card, and the command
  // waits for the test: with a fixed sleep, a loaded machine ran the "next run" before
  // the check had read the task's latest run, and the check took it for its own.
  const failsWhenReleased = async (id: string, move: () => void): Promise<void> => {
    await vi.waitFor(() => expect(getTask(db, id)?.status).toBe('in_review'), {
      timeout: 25_000,
      interval: 10,
    })
    move()
    await writeFile(path.join(home, 'release-check'), '')
  }
  const holdUntilReleased = (): string =>
    `i=0; until [ -e "${path.join(home, 'release-check')}" ] || [ $i -ge 500 ]; do sleep 0.05; i=$((i+1)); done; exit 1`

  it.skipIf(process.platform === 'win32')(
    "keeps a person's move to Blocked made while the check ran",
    async () => {
      setCommand(holdUntilReleased())
      const wc = check()
      const id = startTask()
      await wc.begin(id, AGENT)
      await writeFile(path.join(folder, 'parser.ts'), 'x\n')
      const running = runCheck(wc, id)
      await failsWhenReleased(id, () => updateStatus(db, id, 'blocked')) // a person parks it

      expect(await running).toEqual({ verdict: 'decided' })
      expect(getTask(db, id)?.status).toBe('blocked')
      // Nor is its verdict written over the task: a Retry would start clean.
      expect(getTaskVerification(db, id)).toBeNull()
    },
  )

  it.skipIf(process.platform === 'win32')(
    'records nothing once another run of the task has started',
    async () => {
      setCommand(holdUntilReleased())
      const wc = check()
      const id = startTask()
      createExecutionProcess(db, { taskId: id, executorType: 'openclaw' })
      await wc.begin(id, AGENT)
      await writeFile(path.join(folder, 'parser.ts'), 'x\n')
      const running = runCheck(wc, id)
      // The engine gave up on this check, and the task was run again since.
      await failsWhenReleased(id, () => {
        createExecutionProcess(db, { taskId: id, executorType: 'openclaw' })
      })

      expect(await running).toEqual({ verdict: 'decided' })
      expect(getTaskVerification(db, id)).toBeNull()
      expect(getTask(db, id)?.status).toBe('in_review')
    },
  )

  it('keeps the task alive on the board while it records where the task began', async () => {
    setCommand('true')
    const wc = check()
    const id = startTask()
    // As if the claim were minutes old: the stale sweep reads updatedAt.
    db.update(tasks).set({ updatedAt: 1 }).where(eq(tasks.id, id)).run()

    await wc.begin(id, AGENT)

    expect(getTask(db, id)?.updatedAt).toBeGreaterThan(1)
  })

  it('forgets where a task began once a person marks it Done or cancels it', async () => {
    setCommand('true')
    const wc = check()
    const done = startTask('one')
    const cancelled = startTask('two')
    await wc.begin(done, AGENT)
    await wc.begin(cancelled, AGENT)
    const hasBase = (taskId: string): Promise<boolean> =>
      execGit(folder, [
        '--git-dir',
        teamFolderHistoryDir(TEAM),
        'rev-parse',
        '--verify',
        '-q',
        `refs/clawboo/base/${taskId}`,
      ]).then(
        () => true,
        () => false,
      )
    expect(await hasBase(done)).toBe(true)

    updateStatus(db, done, 'done', { humanOverride: true })
    noteHumanMove(db, { taskId: done, teamId: TEAM, from: 'in_progress', to: 'done' })
    updateStatus(db, cancelled, 'cancelled')
    noteHumanMove(db, { taskId: cancelled, teamId: TEAM, from: 'in_progress', to: 'cancelled' })
    for (let i = 0; i < 50 && ((await hasBase(done)) || (await hasBase(cancelled))); i++)
      await new Promise((r) => setTimeout(r, 20))

    expect(await hasBase(done)).toBe(false)
    expect(await hasBase(cancelled)).toBe(false)
  })

  it("measures a person's Retry from where the task first began", async () => {
    setCommand('test -f tests-pass')
    const wc = check()
    const id = startTask()
    await failFirstAttempt(wc, id)
    await writeFile(path.join(folder, 'parser.ts'), 'still broken\n')
    expect((await runCheck(wc, id))?.verdict).toBe('failed')
    // A person retries it; the agent changes nothing this time.
    updateStatus(db, id, 'todo')
    claimTask(db, id, AGENT)
    await wc.begin(id, AGENT)

    const run = await wc.prepare(id, AGENT)
    expect(run).not.toBeNull()
    expect((await run!())?.verdict).toBe('retry')
  })

  it('says on the task when it cannot record the folder, and leaves the work unchecked', async () => {
    setCommand('true')
    const wc = check()
    const id = startTask()
    await mkdir(path.dirname(teamFolderHistoryDir(TEAM)), { recursive: true })
    await writeFile(teamFolderHistoryDir(TEAM), 'not a repository\n')
    await wc.begin(id, AGENT)
    await writeFile(path.join(folder, 'x.txt'), 'x\n')

    expect(await wc.prepare(id, AGENT)).toBeNull()
    expect(
      getComments(db, id)
        .map((c) => c.body)
        .join('\n'),
    ).toMatch(/will not be checked/)
  })
})
