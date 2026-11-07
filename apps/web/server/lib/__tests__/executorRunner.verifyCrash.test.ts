// A server that dies while a task runner run's work is being checked. The run
// stays open until the verdict, so the boot reap (or the sweep, after a quick
// restart) finds it and the card lands in Needs you instead of sitting on
// "Verifying" forever. A check that outlives its run says nothing more: no second
// verdict and no second move. Real sqlite board, real git worktree, real gate; only
// the runtime is scripted, and `verifyTask` is held open at the moment under test.

import { execFile } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import {
  adoptTaskWakes,
  attentionForTasks,
  claimTask,
  completeExecutionProcess,
  createExecutionProcess,
  createTask,
  getComments,
  getTask,
  getTaskVerification,
  listEvents,
  listExecutions,
  listUndeliveredInbox,
  listWaitingTaskWakes,
  ORPHANED_REVIEW_NOTE,
  reconcileStaleInProgress,
  recordTaskWake,
  resetBoardLifecycleListeners,
  TASK_HEARTBEAT_MS,
  tasks,
  taskWakes,
  updateStatus,
} from '@clawboo/db'
import type {
  Capabilities,
  RunHandle,
  RuntimeAdapter,
  RuntimeEvent,
  StartOpts,
  TaskHandle,
} from '@clawboo/executor'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/** What happens while the check is running. */
const check = vi.hoisted(() => ({
  during: null as null | (() => void | Promise<void>),
  fails: false,
  /** How many checks started. */
  started: 0,
  /** Done to the board while the agent is still working. */
  duringRun: null as null | (() => void),
  /** Make the move to Blocked fail, the way a write can. */
  blockWrite: null as null | 'refused' | 'throws',
}))

vi.mock('@clawboo/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@clawboo/db')>()
  return {
    ...actual,
    updateStatus: (...args: Parameters<typeof actual.updateStatus>) => {
      if (args[2] === 'blocked' && check.blockWrite === 'refused')
        return { ok: false, reason: 'illegal_transition' }
      if (args[2] === 'blocked' && check.blockWrite === 'throws')
        throw new Error('write budget exhausted')
      return actual.updateStatus(...args)
    },
  }
})

vi.mock('../verification', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../verification')>()
  return {
    ...actual,
    verifyTask: async (input: Parameters<typeof actual.verifyTask>[0]) => {
      check.started += 1
      await check.during?.()
      if (check.fails) throw new Error('the check blew up: sk-secretsecretsecretsecret')
      return actual.verifyTask(input)
    },
  }
})

const { getDb, getDbPath, resetDb } = await import('../db')
const { runTaskOnRuntime } = await import('../executorRunner')
const { reapOrphanedRuns, sweepStaleRuns } = await import('../staleTaskSweep')
const { registerBoardLifecycleSubscribers, resetBoardLifecycleRegistration } =
  await import('../teamChat/boardLifecycleSubscribers')

const execFileAsync = promisify(execFile)
async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync('git', args, { cwd, windowsHide: true })
}
async function initRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'clawboo-verify-crash-repo-'))
  await git(dir, ['init', '-b', 'main'])
  await git(dir, ['config', 'user.name', 'test'])
  await git(dir, ['config', 'user.email', 'test@example.com'])
  await writeFile(path.join(dir, 'README.md'), '# repo\n')
  await git(dir, ['add', '-A'])
  await git(dir, ['commit', '--no-verify', '-m', 'init'])
  return dir
}

const CAPS: Capabilities = {
  streaming: true,
  mcp: true,
  worktrees: true,
  resume: true,
  toolApproval: true,
  models: [],
}

function finishedRun(): RuntimeAdapter {
  return {
    id: 'claude-code',
    participantKind: 'agent',
    capabilities: () => CAPS,
    async health() {
      return { ok: true }
    },
    async start(_t: TaskHandle, opts: StartOpts): Promise<RunHandle> {
      return { adapterId: 'claude-code', sessionKey: opts.sessionKey, runId: null }
    },
    events(run: RunHandle): AsyncIterable<RuntimeEvent> {
      const b = () => ({ runId: run.sessionKey, sessionId: run.sessionKey, ts: 1, seq: 1 })
      return (async function* () {
        check.duringRun?.()
        yield {
          ...b(),
          kind: 'cost',
          costUsd: 0.25,
          usage: { inputTokens: 100, outputTokens: 50 },
          model: 'm',
        } as RuntimeEvent
        yield { ...b(), kind: 'done', reason: 'success', summary: 'built it' } as RuntimeEvent
      })()
    },
    async abort() {},
    async setModel() {},
    async writeContext() {},
  }
}

/** A promise the test resolves, and one that says the check has reached it. */
function holdCheck(): { reached: Promise<void>; release: () => void } {
  let release = (): void => undefined
  let arrive = (): void => undefined
  const reached = new Promise<void>((res) => {
    arrive = res
  })
  const released = new Promise<void>((res) => {
    release = res
  })
  check.during = async () => {
    arrive()
    await released
  }
  return { reached, release }
}

const WORKTREE_TIMEOUT_MS = 90_000

describe('task runner: a crash while the work is being checked', () => {
  let home: string
  let repo: string
  let prevHome: string | undefined
  let prevClawbooHome: string | undefined
  let worktree = ''

  beforeEach(async () => {
    worktree = ''
    home = await mkdtemp(path.join(os.tmpdir(), 'clawboo-verify-crash-home-'))
    await mkdir(path.join(home, '.clawboo'), { recursive: true })
    prevHome = process.env['HOME']
    prevClawbooHome = process.env['CLAWBOO_HOME']
    process.env['HOME'] = home
    process.env['CLAWBOO_HOME'] = path.join(home, '.clawboo')
    expect(getDbPath().startsWith(home)).toBe(true)
    repo = await initRepo()
    check.during = null
    check.fails = false
    check.started = 0
    check.duringRun = null
    check.blockWrite = null
  })

  afterEach(async () => {
    vi.useRealTimers()
    resetBoardLifecycleRegistration()
    resetBoardLifecycleListeners()
    resetDb()
    if (prevHome === undefined) delete process.env['HOME']
    else process.env['HOME'] = prevHome
    if (prevClawbooHome === undefined) delete process.env['CLAWBOO_HOME']
    else process.env['CLAWBOO_HOME'] = prevClawbooHome
    await rm(home, { recursive: true, force: true }).catch(() => {})
    await rm(repo, { recursive: true, force: true }).catch(() => {})
  })

  const start = (
    verifyCmd = 'exit 0',
    opts: { checkDeadlineMs?: number; cleanWorktree?: boolean } = {},
  ) => {
    const taskId = createTask(getDb(), {
      title: 'Write the parser',
      status: 'todo',
      teamId: 'team-1',
      sourceDelegationId: 'r1:deleg:agent:coder:reflectTo:lead',
    }).id
    const result = runTaskOnRuntime({
      db: getDb(),
      ...(opts.checkDeadlineMs ? { checkDeadlineMs: opts.checkDeadlineMs } : {}),
      makeAdapter: (ctx) => {
        if (ctx.cwd) worktree = ctx.cwd
        if (ctx.cwd && !opts.cleanWorktree) {
          writeFileSync(path.join(ctx.cwd, 'feature.txt'), 'work output\n', 'utf8')
          writeFileSync(
            path.join(ctx.cwd, 'init.sh'),
            `#!/usr/bin/env bash\nVERIFY_CMD='${verifyCmd}'\n`,
            'utf8',
          )
        }
        return finishedRun()
      },
      taskId,
      assigneeAgentId: 'coder',
      repoPath: repo,
      kind: 'code',
    })
    return { taskId, result }
  }

  const needsYou = (taskId: string) =>
    attentionForTasks(getDb(), [getTask(getDb(), taskId)!]).get(taskId) ?? null

  it(
    'keeps the run open until the verdict, then closes it succeeded',
    async () => {
      const seen: Array<{ task?: string; run?: string }> = []
      check.during = () => {
        const taskId = getDb().select({ id: tasks.id }).from(tasks).get()!.id
        seen.push({
          task: getTask(getDb(), taskId)?.status,
          run: listExecutions(getDb(), taskId).at(-1)?.status,
        })
      }
      const { taskId, result } = start()
      await expect(result).resolves.toMatchObject({ ok: true, status: 'done' })

      expect(seen).toEqual([{ task: 'in_review', run: 'running' }])
      expect(listExecutions(getDb(), taskId).map((e) => e.status)).toEqual(['succeeded'])
      // One close on the event log, after the card moved.
      expect(
        listEvents(getDb(), { taskId, kinds: ['execution_completed'] }).map(
          (e) => (JSON.parse(e.data) as { status: string }).status,
        ),
      ).toEqual(['succeeded'])
    },
    WORKTREE_TIMEOUT_MS,
  )

  it(
    'a restart past the beat window parks the card in Needs you, and the old check says nothing more',
    async () => {
      const hold = holdCheck()
      const { taskId, result } = start()
      await hold.reached

      // The server died here. The next boot's reap finds the open run.
      expect(reapOrphanedRuns(getDb(), -1)).toBe(1)
      expect(getTask(getDb(), taskId)?.status).toBe('blocked')
      expect(needsYou(taskId)).toMatchObject({ reason: 'failed' })
      expect(getComments(getDb(), taskId).map((c) => c.body)).toContain(ORPHANED_REVIEW_NOTE)
      const parked = listExecutions(getDb(), taskId)
      expect(parked.map((e) => e.status)).toEqual(['failed'])
      // What the run cost stays on the ledger and on the card.
      expect(parked[0]?.costUsd).toBe(0.25)
      expect(getTask(getDb(), taskId)?.costUsd).toBe(0.25)
      // Whoever handed it out hears it, and on the event log the alerts wake on.
      const told = listUndeliveredInbox(getDb(), 'lead', { teamId: 'team-1' })
      expect(told.map((m) => m.body)).toEqual([
        'The check on “Write the parser” did not finish, so the task waits for a person.',
      ])
      expect(
        listEvents(getDb(), { taskId, kinds: ['status_changed'] }).map((e) => JSON.parse(e.data)),
      ).toContainEqual({ to: 'blocked', reason: 'check_interrupted' })

      // A brief overlap: the old server was alive after all and its check finishes.
      hold.release()
      await expect(result).resolves.toMatchObject({ ok: true, status: 'blocked' })
      expect(getTaskVerification(getDb(), taskId)).toBeNull()
      expect(getTask(getDb(), taskId)?.status).toBe('blocked')
      expect(listExecutions(getDb(), taskId)).toEqual(parked)
      expect(listEvents(getDb(), { taskId, kinds: ['execution_completed'] })).toEqual([])
      expect(
        getComments(getDb(), taskId).filter((c) => c.body.includes('Verification failed')),
      ).toEqual([])
    },
    WORKTREE_TIMEOUT_MS,
  )

  it(
    'a saved wake stays with the run through its check, and settles when the run closes',
    async () => {
      const hold = holdCheck()
      const { taskId, result } = start()
      await hold.reached
      const wake = recordTaskWake(getDb(), {
        teamId: 'team-1',
        agentId: 'coder',
        taskId,
        reason: 'person_comment',
      })
      const execId = listExecutions(getDb(), taskId).at(-1)!.id
      expect(getTask(getDb(), taskId)?.runExecutionId).toBe(execId)
      adoptTaskWakes(getDb(), taskId, execId)
      expect(listWaitingTaskWakes(getDb(), { taskId })).toEqual([])

      hold.release()
      await expect(result).resolves.toMatchObject({ ok: true, status: 'done' })
      const row = getDb().select().from(taskWakes).where(eq(taskWakes.id, wake.id)).get()
      expect(row?.settledHow).toBe('delivered')
      expect(getTask(getDb(), taskId)?.runExecutionId).toBeNull()
    },
    WORKTREE_TIMEOUT_MS,
  )

  it.each(['sweep', 'boot reap'] as const)(
    'a crash during the check gives a carried wake back through the %s, once',
    async (how) => {
      const hold = holdCheck()
      const { taskId, result } = start()
      await hold.reached
      const wake = recordTaskWake(getDb(), {
        teamId: 'team-1',
        agentId: 'coder',
        taskId,
        reason: 'person_comment',
      })
      adoptTaskWakes(getDb(), taskId, listExecutions(getDb(), taskId).at(-1)!.id)
      getDb().update(tasks).set({ updatedAt: 1 }).where(eq(tasks.id, taskId)).run()

      if (how === 'sweep') expect(sweepStaleRuns(getDb(), 180_000)).toBe(1)
      else expect(reapOrphanedRuns(getDb(), 180_000)).toBe(1)
      expect(getTask(getDb(), taskId)?.status).toBe('blocked')
      expect(getTask(getDb(), taskId)?.runExecutionId).toBeNull()

      // The run that lost the task still ends, and changes nothing (`runStillOpen`).
      hold.release()
      await expect(result).resolves.toMatchObject({ ok: true, status: 'blocked' })
      const row = listWaitingTaskWakes(getDb(), { taskId }).find((w) => w.id === wake.id)
      expect(row?.replays).toBe(1)
      expect(row?.heldAt).toBeNull()
    },
    WORKTREE_TIMEOUT_MS,
  )

  it(
    'a quick restart leaves the open run to the sweep, which parks it once the beat stops',
    async () => {
      const hold = holdCheck()
      const { taskId, result } = start()
      await hold.reached

      // Fresh at boot: the reap cannot tell it from a live run, so it leaves it.
      expect(reapOrphanedRuns(getDb(), 180_000)).toBe(0)
      expect(getTask(getDb(), taskId)?.status).toBe('in_review')
      expect(sweepStaleRuns(getDb(), 180_000)).toBe(0)
      expect(getTask(getDb(), taskId)?.status).toBe('in_review')

      // No beat for the whole window.
      getDb().update(tasks).set({ updatedAt: 1 }).where(eq(tasks.id, taskId)).run()
      expect(sweepStaleRuns(getDb(), 180_000)).toBe(1)
      expect(getTask(getDb(), taskId)?.status).toBe('blocked')
      expect(needsYou(taskId)).toMatchObject({ reason: 'failed' })
      expect(getComments(getDb(), taskId).map((c) => c.body)).toContain(ORPHANED_REVIEW_NOTE)
      // The browser alerts follow the event log.
      expect(
        listEvents(getDb(), { taskId, kinds: ['status_changed'] }).map((e) => JSON.parse(e.data)),
      ).toContainEqual({ to: 'blocked', reason: 'check_interrupted' })
      expect(listUndeliveredInbox(getDb(), 'lead', { teamId: 'team-1' })).toHaveLength(1)

      hold.release()
      await expect(result).resolves.toMatchObject({ ok: true, status: 'blocked' })
      expect(getTaskVerification(getDb(), taskId)).toBeNull()
    },
    WORKTREE_TIMEOUT_MS,
  )

  it(
    'beats while the work is being checked, so a live check is never read as dead',
    async () => {
      // Only the beat's interval is faked: git and the gate need real time.
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
      let beaten = 0
      check.during = () => {
        const taskId = getDb().select({ id: tasks.id }).from(tasks).get()!.id
        getDb().update(tasks).set({ updatedAt: 1 }).where(eq(tasks.id, taskId)).run()
        vi.advanceTimersByTime(TASK_HEARTBEAT_MS)
        beaten = getTask(getDb(), taskId)!.updatedAt
      }
      const { result } = start()
      await expect(result).resolves.toMatchObject({ ok: true, status: 'done' })
      expect(beaten).toBeGreaterThan(1)
    },
    WORKTREE_TIMEOUT_MS,
  )

  it(
    'a check that fails with attempts left closes its run before the fix run opens one',
    async () => {
      const openAtCheck: number[] = []
      check.during = () => {
        const taskId = getDb().select({ id: tasks.id }).from(tasks).get()!.id
        openAtCheck.push(
          listExecutions(getDb(), taskId).filter((e) => e.status === 'running').length,
        )
      }
      const { taskId, result } = start('exit 1')
      // Two attempts by default: the first asks for a fix, the second parks it.
      await expect(result).resolves.toMatchObject({ ok: true, status: 'blocked' })

      expect(openAtCheck).toEqual([1, 1])
      expect(listExecutions(getDb(), taskId).map((e) => e.status)).toEqual([
        'succeeded',
        'succeeded',
      ])
      expect(getTaskVerification(getDb(), taskId)?.attempts).toHaveLength(2)
      expect(needsYou(taskId)).toMatchObject({ reason: 'needs_review' })
      expect(listUndeliveredInbox(getDb(), 'lead', { teamId: 'team-1' })).toHaveLength(1)
    },
    WORKTREE_TIMEOUT_MS,
  )

  it(
    'a check that blows up parks the card instead of leaving it on Verifying',
    async () => {
      registerBoardLifecycleSubscribers({ mcpBaseUrl: null })
      check.fails = true
      const { taskId, result } = start()
      await expect(result).rejects.toThrow('the check blew up')

      expect(getTask(getDb(), taskId)?.status).toBe('blocked')
      expect(listExecutions(getDb(), taskId).map((e) => e.status)).toEqual(['failed'])
      expect(needsYou(taskId)).toMatchObject({ reason: 'failed' })
      const notes = getComments(getDb(), taskId)
        .filter((c) => c.authorType === 'system')
        .map((c) => c.body)
      expect(notes.some((b) => b.includes('could not finish'))).toBe(true)
      // A check's error is scrubbed before it lands on the card.
      expect(notes.join('\n')).not.toContain('sk-secretsecretsecretsecret')
      expect(listExecutions(getDb(), taskId)[0]?.error).not.toContain('sk-secretsecretsecretsecret')
      expect(
        listEvents(getDb(), { taskId, kinds: ['status_changed'] }).map((e) => JSON.parse(e.data)),
      ).toContainEqual({ to: 'blocked', reason: 'check_interrupted' })
      // Told once, by the notice every failed run gets.
      expect(
        listUndeliveredInbox(getDb(), 'lead', { teamId: 'team-1' }).map((m) => m.body),
      ).toEqual(['“Write the parser” finished with failed. Check the board for the result.'])
    },
    WORKTREE_TIMEOUT_MS,
  )

  it.each(['refused', 'throws'] as const)(
    'a check that blows up leaves its run open when the move to Blocked is %s, for the sweep to find',
    async (how) => {
      check.fails = true
      check.blockWrite = how
      const { taskId, result } = start()
      await expect(result).rejects.toThrow('the check blew up')

      // Parked first: nothing says it is parked until it is.
      expect(getTask(getDb(), taskId)?.status).toBe('in_review')
      expect(listExecutions(getDb(), taskId).map((e) => e.status)).toEqual(['running'])
      expect(
        getComments(getDb(), taskId).filter((c) => c.body.includes('could not finish')),
      ).toEqual([])
      expect(
        listEvents(getDb(), { taskId, kinds: ['status_changed'] }).map((e) => JSON.parse(e.data)),
      ).not.toContainEqual({ to: 'blocked', reason: 'check_interrupted' })

      // The write recovers and the beat has stopped: the next sweep parks it.
      check.blockWrite = null
      getDb().update(tasks).set({ updatedAt: 1 }).where(eq(tasks.id, taskId)).run()
      expect(sweepStaleRuns(getDb(), 180_000)).toBe(1)
      expect(getTask(getDb(), taskId)?.status).toBe('blocked')
    },
    WORKTREE_TIMEOUT_MS,
  )

  it(
    'a check that never answers is given up on at its deadline and parks the card',
    async () => {
      registerBoardLifecycleSubscribers({ mcpBaseUrl: null })
      check.during = () => new Promise<void>(() => undefined)
      const { taskId, result } = start('exit 0', { checkDeadlineMs: 50 })
      await expect(result).rejects.toThrow('did not answer')

      expect(getTask(getDb(), taskId)?.status).toBe('blocked')
      const [run] = listExecutions(getDb(), taskId)
      expect(run?.status).toBe('failed')
      expect(run?.error).toContain('did not answer')
      expect(needsYou(taskId)).toMatchObject({ reason: 'failed' })
      expect(getComments(getDb(), taskId).some((c) => c.body.includes('did not answer'))).toBe(true)
      expect(listUndeliveredInbox(getDb(), 'lead', { teamId: 'team-1' })).toHaveLength(1)
    },
    WORKTREE_TIMEOUT_MS,
  )

  it(
    'a person who moved the card while the check hung keeps their move at the deadline',
    async () => {
      check.during = () => {
        const taskId = getDb().select({ id: tasks.id }).from(tasks).get()!.id
        expect(updateStatus(getDb(), taskId, 'blocked', { actor: 'person' }).ok).toBe(true)
        return new Promise<void>(() => undefined)
      }
      const { taskId, result } = start('exit 0', { checkDeadlineMs: 50 })
      await expect(result).resolves.toMatchObject({ ok: true, status: 'blocked' })

      // The run's own work was fine and the person decided: not a failed run, and
      // no note that the check failed.
      expect(listExecutions(getDb(), taskId).map((e) => e.status)).toEqual(['succeeded'])
      expect(needsYou(taskId)).toMatchObject({ reason: 'blocked', byPerson: true })
      expect(getComments(getDb(), taskId).filter((c) => c.body.includes('did not answer'))).toEqual(
        [],
      )
    },
    WORKTREE_TIMEOUT_MS,
  )

  it(
    'a run the sweep released while it worked checks nothing and moves nothing',
    async () => {
      // The sweep's own write: the row timed out, the task back in To do, no assignee.
      check.duringRun = () => {
        const taskId = getDb().select({ id: tasks.id }).from(tasks).get()!.id
        getDb().update(tasks).set({ updatedAt: 1 }).where(eq(tasks.id, taskId)).run()
        expect(reconcileStaleInProgress(getDb(), 60_000).reconciled).toBe(1)
      }
      const { taskId, result } = start()
      await expect(result).resolves.toMatchObject({ ok: true, status: 'todo' })

      expect(check.started).toBe(0)
      expect(getTask(getDb(), taskId)).toMatchObject({ status: 'todo', assigneeAgentId: null })
      expect(getTaskVerification(getDb(), taskId)).toBeNull()
      expect(listExecutions(getDb(), taskId).map((e) => e.status)).toEqual(['timed_out'])
      // Its work waits in the worktree for the next run.
      expect(existsSync(path.join(worktree, 'feature.txt'))).toBe(true)
    },
    WORKTREE_TIMEOUT_MS,
  )

  it(
    'an old run ending under a newer one leaves its card and its worktree alone',
    async () => {
      // Released, then claimed again by a newer run, which is working in this same
      // worktree. The old run found nothing changed, which `complete` cleans up as
      // finished work, so the newer run's checkout and its card are both at stake.
      let newer = ''
      check.duringRun = () => {
        const taskId = getDb().select({ id: tasks.id }).from(tasks).get()!.id
        getDb().update(tasks).set({ updatedAt: 1 }).where(eq(tasks.id, taskId)).run()
        expect(reconcileStaleInProgress(getDb(), 60_000).reconciled).toBe(1)
        expect(claimTask(getDb(), taskId, 'coder-2', 'claude-code').ok).toBe(true)
        newer = createExecutionProcess(getDb(), { taskId, executorType: 'claude-code' }).id
      }
      const { taskId, result } = start('exit 0', { cleanWorktree: true })
      await expect(result).resolves.toMatchObject({ ok: true, status: 'in_progress' })

      expect(check.started).toBe(0)
      expect(existsSync(worktree)).toBe(true)
      expect(getTask(getDb(), taskId)).toMatchObject({
        status: 'in_progress',
        assigneeAgentId: 'coder-2',
      })
      const runs = listExecutions(getDb(), taskId)
      expect(runs.find((e) => e.id === newer)?.status).toBe('running')
      expect(runs.filter((e) => e.id !== newer).map((e) => e.status)).toEqual(['timed_out'])
    },
    WORKTREE_TIMEOUT_MS,
  )

  it(
    'a run whose row something else closed does not strand its task in progress',
    async () => {
      // Closed through the executions route, say: the task is still held by this
      // claim, with no run on it and nothing that would ever look at it again.
      check.duringRun = () => {
        const taskId = getDb().select({ id: tasks.id }).from(tasks).get()!.id
        const open = listExecutions(getDb(), taskId).at(-1)!
        completeExecutionProcess(getDb(), open.id, { status: 'failed', error: 'closed elsewhere' })
      }
      const { taskId, result } = start()
      await expect(result).resolves.toMatchObject({ ok: true, status: 'todo' })
      expect(check.started).toBe(0)
      expect(getTask(getDb(), taskId)).toMatchObject({ status: 'todo', assigneeAgentId: null })
    },
    WORKTREE_TIMEOUT_MS,
  )

  it(
    'a check overtaken by a newer run records nothing and starts no fix run',
    async () => {
      // A person stopped the check and retried while it ran. The newer run owns the
      // task now, even if it reached In review itself.
      const hold = holdCheck()
      const { taskId, result } = start('exit 1')
      await hold.reached
      expect(updateStatus(getDb(), taskId, 'blocked', { actor: 'person' }).ok).toBe(true)
      expect(updateStatus(getDb(), taskId, 'in_progress').ok).toBe(true)
      expect(updateStatus(getDb(), taskId, 'in_review').ok).toBe(true)
      const newer = createExecutionProcess(getDb(), { taskId, executorType: 'claude-code' })

      hold.release()
      check.during = null
      const settled = await result
      expect(settled).toMatchObject({ ok: true, status: 'in_review' })
      expect(settled.ok && settled.needsVerifyFix).toBeFalsy()
      expect(getTaskVerification(getDb(), taskId)).toBeNull()
      expect(getTask(getDb(), taskId)?.status).toBe('in_review')
      // Only the overtaken run closed.
      const runs = listExecutions(getDb(), taskId)
      expect(runs.find((e) => e.id === newer.id)?.status).toBe('running')
      expect(runs.filter((e) => e.id !== newer.id).map((e) => e.status)).toEqual(['succeeded'])
    },
    WORKTREE_TIMEOUT_MS,
  )
})
