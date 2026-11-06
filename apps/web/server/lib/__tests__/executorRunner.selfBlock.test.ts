// A task runner run whose own agent blocked its task (its `block_task`). It ends
// the way the team engine ends one: the run succeeded, the reply is kept, the card
// stays blocked with no "late result", the steps waiting on it stay queued, and the
// delegator is told. A person's block is not read as the agent's. Real sqlite board
// and real git worktrees; only the runtime is scripted, and the agent's tool call is
// the repository write the Tasks tool makes.

import { execFile } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import { encodeHumanAssignment, taskAttention } from '@clawboo/board-core'
import {
  blockTask,
  createTask,
  getComments,
  getReadyTasks,
  getTask,
  getTaskVerification,
  INBOX_BUDGET_CHARS,
  linkDep,
  listEvents,
  listExecutions,
  listUndeliveredInbox,
  packInboxRows,
  recordTaskWake,
  taskWakes,
  teams,
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
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { getDb, getDbPath, resetDb } from '../db'
import { runTaskOnRuntime } from '../executorRunner'
import type { RuntimeRunContext } from '../runtimes'
import { getTaskWorkspace } from '../worktrees'

const execFileAsync = promisify(execFile)
async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, windowsHide: true })
  return stdout
}
async function initRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'clawboo-selfblock-repo-'))
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
const NO_WORKTREE: Capabilities = { ...CAPS, worktrees: false }

const REPLY = 'I need the staging API key from a person before I can go on.'

/** A runtime that does `during` mid-run, then ends with `reason`. */
function agentRun(
  during: () => void,
  opts: { reason?: 'success' | 'max_turns'; caps?: Capabilities; summary?: string } = {},
) {
  const starts: StartOpts[] = []
  const adapter: RuntimeAdapter = {
    id: 'claude-code',
    participantKind: 'agent',
    capabilities: () => opts.caps ?? CAPS,
    async health() {
      return { ok: true }
    },
    async start(_t: TaskHandle, start: StartOpts): Promise<RunHandle> {
      starts.push(start)
      return { adapterId: 'claude-code', sessionKey: start.sessionKey, runId: null }
    },
    events(run: RunHandle): AsyncIterable<RuntimeEvent> {
      const b = () => ({ runId: run.sessionKey, sessionId: run.sessionKey, ts: 1, seq: 1 })
      return (async function* () {
        during()
        if (opts.summary !== '')
          yield { ...b(), kind: 'text-delta', text: REPLY, channel: 'assistant' } as RuntimeEvent
        yield {
          ...b(),
          kind: 'done',
          reason: opts.reason ?? 'success',
          summary: opts.summary ?? REPLY,
        } as RuntimeEvent
      })()
    },
    async abort() {},
    async setModel() {},
    async writeContext() {},
  }
  return { adapter, starts }
}

const LEAD_SDID = 'r1:deleg:agent:coder:reflectTo:lead'

describe('task runner: a task its own agent blocked', () => {
  let home: string
  let repo: string
  let prevHome: string | undefined
  let prevClawbooHome: string | undefined

  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), 'clawboo-selfblock-home-'))
    await mkdir(path.join(home, '.clawboo'), { recursive: true })
    prevHome = process.env['HOME']
    prevClawbooHome = process.env['CLAWBOO_HOME']
    process.env['HOME'] = home
    process.env['CLAWBOO_HOME'] = path.join(home, '.clawboo')
    expect(getDbPath().startsWith(home)).toBe(true)
    repo = await initRepo()
  })

  afterEach(async () => {
    resetDb()
    if (prevHome === undefined) delete process.env['HOME']
    else process.env['HOME'] = prevHome
    if (prevClawbooHome === undefined) delete process.env['CLAWBOO_HOME']
    else process.env['CLAWBOO_HOME'] = prevClawbooHome
    await rm(home, { recursive: true, force: true }).catch(() => {})
    await rm(repo, { recursive: true, force: true }).catch(() => {})
  })

  const task = (title: string, sdid: string | null = LEAD_SDID): string =>
    createTask(getDb(), {
      title,
      status: 'todo',
      teamId: 'team-1',
      ...(sdid ? { sourceDelegationId: sdid } : {}),
    }).id

  const block = (taskId: string) => (): void => {
    const r = blockTask(getDb(), taskId, { unlessPersonMoved: true })
    expect(r.ok).toBe(true)
  }

  const attentionOf = (taskId: string) => {
    const t = getTask(getDb(), taskId)!
    return taskAttention({
      status: t.status,
      sourceDelegationId: t.sourceDelegationId,
      execs: listExecutions(getDb(), taskId),
      personMovedAt: t.personMovedAt,
    })
  }

  it('ends as the agent’s block: no late result, the reply kept, the run succeeded', async () => {
    const taskId = task('Deploy to staging')
    const { adapter } = agentRun(block(taskId), { caps: NO_WORKTREE })

    const result = await runTaskOnRuntime({
      db: getDb(),
      makeAdapter: () => adapter,
      taskId,
      assigneeAgentId: 'coder',
    })

    expect(result).toMatchObject({ ok: true, doneReason: 'success', status: 'blocked' })
    expect(getTask(getDb(), taskId)?.status).toBe('blocked')
    const comments = getComments(getDb(), taskId)
    expect(comments.filter((c) => c.body.includes('late result'))).toEqual([])
    expect(comments.filter((c) => c.authorType === 'agent').map((c) => c.body)).toEqual([REPLY])
    const runs = listExecutions(getDb(), taskId)
    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({ status: 'succeeded', summary: REPLY })
    // Needs you reads it as an agent's call, not a failure and not a person's move.
    expect(attentionOf(taskId)).toEqual({ reason: 'blocked', failedRuns: 0 })
    // The browser alerts follow the event log.
    expect(
      listEvents(getDb(), { taskId, kinds: ['status_changed'] }).map((e) => JSON.parse(e.data)),
    ).toContainEqual({ to: 'blocked', reason: 'agent_blocked' })
  })

  it('a saved wake the run carried was heard, since the run ended well', async () => {
    const taskId = task('Deploy to staging')
    const wake = recordTaskWake(getDb(), {
      teamId: 'team-1',
      agentId: 'coder',
      taskId,
      reason: 'person_comment',
    })
    const { adapter } = agentRun(block(taskId), { caps: NO_WORKTREE })
    await runTaskOnRuntime({
      db: getDb(),
      makeAdapter: () => adapter,
      taskId,
      assigneeAgentId: 'coder',
    })
    const row = getDb().select().from(taskWakes).where(eq(taskWakes.id, wake.id)).get()
    expect(row?.settledHow).toBe('delivered')
    expect(getTask(getDb(), taskId)?.runExecutionId).toBeNull()
  })

  it('leaves the steps waiting on it queued, and tells the delegator why', async () => {
    const taskId = task('Deploy to staging')
    const next = task('Smoke test staging')
    linkDep(getDb(), next, taskId)
    const { adapter } = agentRun(block(taskId), { caps: NO_WORKTREE })

    await runTaskOnRuntime({
      db: getDb(),
      makeAdapter: () => adapter,
      taskId,
      assigneeAgentId: 'coder',
    })

    expect(getTask(getDb(), next)?.status).toBe('todo')
    expect(getReadyTasks(getDb(), { teamId: 'team-1' }).map((t) => t.id)).not.toContain(next)
    const mail = listUndeliveredInbox(getDb(), 'lead', { teamId: 'team-1' })
    expect(mail).toHaveLength(1)
    expect(mail[0]).toMatchObject({ taskId, kind: 'task_update' })
    expect(mail[0]!.body).toContain('Deploy to staging')
    expect(mail[0]!.body).toContain('needs a person')
    expect(mail[0]!.body).toContain(REPLY)
  })

  it('says where the whole reply is before quoting it, since a digest cuts the row', async () => {
    const taskId = task('Deploy to staging')
    const long = 'x'.repeat(3_000)
    const { adapter } = agentRun(block(taskId), { caps: NO_WORKTREE, summary: long })
    await runTaskOnRuntime({
      db: getDb(),
      makeAdapter: () => adapter,
      taskId,
      assigneeAgentId: 'coder',
    })
    const rows = listUndeliveredInbox(getDb(), 'lead', { teamId: 'team-1' })
    const [line] = packInboxRows(rows, INBOX_BUDGET_CHARS).bodies
    expect(line).toContain('needs a person')
    expect(line).toContain('whole reply is on the task')
    expect(line).toContain('xxx')
  })

  it('says the agent gave no reason when its reply is empty', async () => {
    const taskId = task('Deploy to staging')
    const { adapter } = agentRun(block(taskId), { caps: NO_WORKTREE, summary: '' })
    await runTaskOnRuntime({
      db: getDb(),
      makeAdapter: () => adapter,
      taskId,
      assigneeAgentId: 'coder',
    })
    const [note] = listUndeliveredInbox(getDb(), 'lead', { teamId: 'team-1' })
    expect(note?.body).toContain('did not say why')
  })

  it('tells no agent about a task a person assigned', async () => {
    // Its result is the person's, on the card: handing it to the team lead would
    // make the lead act on work nobody asked it to coordinate.
    const now = Date.now()
    getDb()
      .insert(teams)
      .values({
        id: 'team-1',
        name: 'Team',
        icon: 'T',
        color: '#000',
        leaderAgentId: 'lead',
        createdAt: now,
        updatedAt: now,
      })
      .run()
    const taskId = task('Deploy to staging', encodeHumanAssignment('coder', 'n1'))
    const { adapter } = agentRun(block(taskId), { caps: NO_WORKTREE })
    await runTaskOnRuntime({
      db: getDb(),
      makeAdapter: () => adapter,
      taskId,
      assigneeAgentId: 'coder',
    })
    expect(getTask(getDb(), taskId)?.status).toBe('blocked')
    expect(listUndeliveredInbox(getDb(), 'lead', { teamId: 'team-1' })).toEqual([])
  })

  it('keeps a dirty worktree unchecked, for a Retry to carry on from', async () => {
    const taskId = task('Write the parser')
    const { adapter } = agentRun(block(taskId))
    let worktree = ''

    const result = await runTaskOnRuntime({
      db: getDb(),
      makeAdapter: (ctx: RuntimeRunContext) => {
        if (ctx.cwd) {
          worktree = ctx.cwd
          writeFileSync(path.join(ctx.cwd, 'half-done.txt'), 'half done\n', 'utf8')
        }
        return adapter
      },
      taskId,
      assigneeAgentId: 'coder',
      repoPath: repo,
      kind: 'code',
    })

    expect(result).toMatchObject({ ok: true, status: 'blocked' })
    expect(result.ok && result.needsVerifyFix).toBeFalsy()
    // Nothing was checked: no verdict, and no verification comment on the card.
    expect(getTaskVerification(getDb(), taskId)).toBeNull()
    expect(getComments(getDb(), taskId).map((c) => c.body)).toEqual([REPLY])
    expect(existsSync(path.join(worktree, 'half-done.txt'))).toBe(true)
    // The next run reads why it stopped.
    const ws = await getTaskWorkspace(taskId)
    expect(ws.ok && ws.handoff?.whyBlocked).toBe(REPLY)
    expect(ws.ok && ws.handoff?.nextBestStep).toBe(REPLY)
    expect(ws.ok && ws.handoff?.completedSubtasks).toEqual([])
    expect(listExecutions(getDb(), taskId)[0]).toMatchObject({ status: 'succeeded' })
  })

  it('does not clean up the worktree of a block with nothing changed yet', async () => {
    // An empty diff is what `complete` cleans up as finished work.
    const taskId = task('Write the parser')
    const { adapter } = agentRun(block(taskId))
    let worktree = ''
    await runTaskOnRuntime({
      db: getDb(),
      makeAdapter: (ctx: RuntimeRunContext) => {
        if (ctx.cwd) worktree = ctx.cwd
        return adapter
      },
      taskId,
      assigneeAgentId: 'coder',
      repoPath: repo,
      kind: 'code',
    })
    expect(worktree).not.toBe('')
    expect(existsSync(worktree)).toBe(true)
    expect(listUndeliveredInbox(getDb(), 'lead', { teamId: 'team-1' })).toHaveLength(1)
  })

  it('does not start a fresh session on a task its agent blocked', async () => {
    // Out of room right after the block: rotating would set a new session to work
    // on a task the agent said it cannot go on with.
    const taskId = task('Deploy to staging')
    const { adapter, starts } = agentRun(block(taskId), { caps: NO_WORKTREE, reason: 'max_turns' })
    const result = await runTaskOnRuntime({
      db: getDb(),
      makeAdapter: () => adapter,
      taskId,
      assigneeAgentId: 'coder',
    })
    expect(starts).toHaveLength(1)
    expect(result).toMatchObject({ ok: true, doneReason: 'max_turns', status: 'blocked' })
    expect(getTask(getDb(), taskId)?.status).toBe('blocked')
  })

  it('does not read a person’s block as the agent’s', async () => {
    // A person blocks the card in the instant the run ends, too late to stop it
    // (or from a second server, whose stop never reaches this run).
    const taskId = task('Deploy to staging')
    const { adapter } = agentRun(
      () => {
        // A ms after the run's own start, as a real move is.
        const start = Date.now()
        while (Date.now() <= start) {
          /* wait out the clock's resolution */
        }
        const moved = updateStatus(getDb(), taskId, 'blocked', { actor: 'person' })
        expect(moved.ok).toBe(true)
      },
      { caps: NO_WORKTREE },
    )
    await runTaskOnRuntime({
      db: getDb(),
      makeAdapter: () => adapter,
      taskId,
      assigneeAgentId: 'coder',
    })
    expect(getTask(getDb(), taskId)?.status).toBe('blocked')
    expect(attentionOf(taskId)).toMatchObject({ reason: 'blocked', byPerson: true })
    // The result is a late one, and the delegator hears nothing from this path.
    const comments = getComments(getDb(), taskId).map((c) => c.body)
    expect(comments.some((b) => b.includes('late result'))).toBe(true)
    expect(listUndeliveredInbox(getDb(), 'lead', { teamId: 'team-1' })).toEqual([])
  })
})
