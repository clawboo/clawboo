// All-on integration test — the single flow that exercises board + executors +
// worktrees + verify + governance + obs TOGETHER, closing the "only per-subsystem
// tests" gap. Every prior server test turns on a SUBSET (executorRunner: board +
// worktrees; verification: + verify; circuit breakers: + governance + obs; obs: +
// obs, no worktrees). None drives all six at once, so the cross-subsystem
// interactions (verify gate fed by a runner-provisioned worktree; budget recorded
// alongside an obs trace; a governance halt correctly SKIPPING verify) were
// unproven as a unit.
//
// Vehicle: `runTaskOnRuntime` with a FAKE adapter, against a REAL sqlite board + a
// REAL temp git worktree, `$HOME` sandboxed. The Playwright board e2e only reaches
// the CLIENT fusion path (over the mock gateway) — it cannot touch these
// server-side subsystems — so a server-integration test is the deterministic
// vehicle. The fake adapter's factory writes a real deliverable + a real
// VERIFY_CMD into the worktree `cwd` (which the runner exposes to `makeAdapter`),
// so the verify gate actually runs and passes — the same dirtying trick
// `verification.test.ts` uses, but driven through the runner.
//
// A documented LIVE variant (env-gated `describe.skipIf`) drives the REAL Claude
// Code runtime; skipped in CI when no key/auth is present.

import { execFile } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import type { Request, Response } from 'express'

import {
  createDb,
  createTask,
  getBudget,
  getComments,
  getTask,
  getTaskVerification,
  listEvents,
  listGovernanceAudit,
  setBudgetLimit,
} from '@clawboo/db'
import type {
  Capabilities,
  RunHandle,
  RuntimeAdapter,
  RuntimeEvent,
  StartOpts,
  TaskHandle,
} from '@clawboo/executor'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { runtimesRunPOST } from '../../api/runtimes'
import { getDbPath } from '../db'
import { runTaskOnRuntime } from '../executorRunner'
import type { RuntimeRunContext } from '../runtimes'
import { getTaskWorkspace } from '../worktrees'

const execFileAsync = promisify(execFile)
async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync('git', args, { cwd, windowsHide: true })
}
async function initRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'clawboo-allon-repo-'))
  await git(dir, ['init', '-b', 'main'])
  await git(dir, ['config', 'user.name', 'test'])
  await git(dir, ['config', 'user.email', 'test@example.com'])
  await writeFile(path.join(dir, 'README.md'), '# repo\n')
  await git(dir, ['add', '-A'])
  await git(dir, ['commit', '--no-verify', '-m', 'init'])
  return dir
}

const FULL_CAPS: Capabilities = {
  streaming: true,
  mcp: true,
  worktrees: true,
  resume: true,
  toolApproval: true,
  models: [],
}

/** Simulate a runtime that did real work: write a deliverable (a non-SoR file → a
 *  dirty diff the verify gate sees) + a real VERIFY_CMD into the worktree. The
 *  runner exposes the worktree `cwd` to `makeAdapter` on the live call (and `{}` on
 *  the capability probe), so this fires exactly once, on the real run. */
function dirtyWorktree(cwd: string): void {
  writeFileSync(path.join(cwd, 'feature.txt'), 'work output\n', 'utf8')
  writeFileSync(path.join(cwd, 'init.sh'), `#!/usr/bin/env bash\nVERIFY_CMD='exit 0'\n`, 'utf8')
}

/** Scripts a normalized event stream and counts abort() calls (for halt tests). */
class ScriptedAdapter implements RuntimeAdapter {
  readonly participantKind = 'agent' as const
  startedOpts: StartOpts | null = null
  aborts = 0
  constructor(
    readonly id: string,
    private readonly script: RuntimeEvent[],
  ) {}
  capabilities(): Capabilities {
    return FULL_CAPS
  }
  async health() {
    return { ok: true }
  }
  async start(_t: TaskHandle, opts: StartOpts): Promise<RunHandle> {
    this.startedOpts = opts
    return { adapterId: this.id, sessionKey: opts.sessionKey, runId: null }
  }
  events(): AsyncIterable<RuntimeEvent> {
    const script = this.script
    return (async function* () {
      for (const e of script) yield e
    })()
  }
  async abort() {
    this.aborts += 1
  }
  async setModel() {}
  async writeContext() {}
}

/** Build a RuntimeEvent[] with auto-incrementing seq + correlated tool-call ids. */
function scriptBuilder() {
  const out: RuntimeEvent[] = []
  let n = 0
  let cid = 0
  const base = (ts: number) => ({ runId: 'r', sessionId: 'r', ts, seq: (n += 1) })
  const api = {
    toolCall(name: string, input: unknown, ts = 1): string {
      const toolCallId = `c${(cid += 1)}`
      out.push({
        ...base(ts),
        kind: 'tool-call',
        toolCallId,
        name,
        input,
        partial: false,
      } as RuntimeEvent)
      return toolCallId
    },
    toolResult(toolCallId: string, name: string, isError: boolean, ts = 1) {
      out.push({
        ...base(ts),
        kind: 'tool-result',
        toolCallId,
        name,
        output: isError ? 'boom' : 'ok',
        isError,
      } as RuntimeEvent)
    },
    pair(name: string, input: unknown, isError: boolean, ts = 1) {
      api.toolResult(api.toolCall(name, input, ts), name, isError, ts)
    },
    costUsd(usd: number, ts = 1) {
      out.push({
        ...base(ts),
        kind: 'cost',
        costUsd: usd,
        usage: { inputTokens: 1, outputTokens: 1 },
        model: 'm',
      } as RuntimeEvent)
    },
    done(reason: 'success' | 'error' = 'success', ts = 1) {
      out.push({ ...base(ts), kind: 'done', reason, summary: 'scripted done' } as RuntimeEvent)
    },
    build: () => out,
  }
  return api
}

describe('executor runner — all-on integration (board + executors + worktrees + verify + governance + obs)', () => {
  let repo: string
  let home: string
  let prevHome: string | undefined

  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), 'clawboo-allon-home-'))
    await mkdir(path.join(home, '.openclaw', 'clawboo'), { recursive: true })
    prevHome = process.env['HOME']
    process.env['HOME'] = home // → getDbPath() + the worktree root land in the sandbox
    repo = await initRepo()
  })

  afterEach(async () => {
    if (prevHome === undefined) delete process.env['HOME']
    else process.env['HOME'] = prevHome
    await rm(home, { recursive: true, force: true }).catch(() => {})
    await rm(repo, { recursive: true, force: true }).catch(() => {})
  })

  function newCodeTask(title = 'Implement the thing'): string {
    return createTask(createDb(getDbPath()), {
      title,
      description: 'do it',
      status: 'todo',
      teamId: 'team-1',
    }).id
  }

  it('happy path: all six subsystems cooperate on one successful run', async () => {
    const taskId = newCodeTask()
    // A generous agent budget: spend is RECORDED (governance live) without pausing.
    setBudgetLimit(createDb(getDbPath()), {
      scope: 'agent',
      scopeId: 'claude-1',
      limitUsdCents: 10_000,
    })

    const b = scriptBuilder()
    b.pair('read_file', { path: 'README.md' }, false) // tool-call + tool-result (success)
    b.costUsd(0.05) // 5¢ recorded against the agent budget; far under the cap
    b.done('success')
    const adapter = new ScriptedAdapter('claude-code', b.build())

    const result = await runTaskOnRuntime({
      db: createDb(getDbPath()),
      makeAdapter: (ctx: RuntimeRunContext) => {
        if (ctx.cwd) dirtyWorktree(ctx.cwd) // real call (worktree present) → leave a verifiable deliverable
        return adapter
      },
      taskId,
      assigneeAgentId: 'claude-1',
      repoPath: repo,
      kind: 'code',
      mcpBaseUrl: 'http://localhost:18790',
    })

    // ── executors ──────────────────────────────────────────────────────────────
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.runtimeId).toBe('claude-code')
    expect(result.usedWorktree).toBe(true)
    expect(result.doneReason).toBe('success')
    expect(result.status).toBe('done') // verify gate passed → in_review → done

    const db = createDb(getDbPath())

    // ── board ──────────────────────────────────────────────────────────────────
    expect(getTask(db, taskId)?.status).toBe('done')
    expect(getComments(db, taskId).some((c) => c.body.includes('scripted done'))).toBe(true) // report-up

    // ── worktrees ──────────────────────────────────────────────────────────────
    const ws = await getTaskWorkspace(taskId)
    expect(ws.ok).toBe(true)
    if (ws.ok) expect(ws.handoff).toBeTruthy() // AGENT_HANDOFF.json clock-out written

    // ── verify ─────────────────────────────────────────────────────────────────
    expect(getTaskVerification(db, taskId)?.status).toBe('pass')

    // ── governance ─────────────────────────────────────────────────────────────
    expect(getBudget(db, 'agent', 'claude-1')?.spentUsdCents).toBeGreaterThan(0) // ledger recorded
    expect(listGovernanceAudit(db, { eventType: 'budget' })).toHaveLength(0) // no pause
    expect(listGovernanceAudit(db, { eventType: 'circuit_break' })).toHaveLength(0) // no breaker trip

    // ── obs ────────────────────────────────────────────────────────────────────
    const starts = listEvents(db, { taskId, kinds: ['span_start'], limit: 100 })
    expect(starts).toHaveLength(1)
    const traceId = starts[0]!.traceId
    expect(traceId).toBeTruthy()
    const trace = listEvents(db, { traceId: traceId!, limit: 1000 })
    const kinds = trace.map((e) => e.kind)
    for (const k of [
      'span_start',
      'execution_started',
      'tool_call',
      'tool_result',
      'cost',
      'execution_completed',
      'span_end',
    ]) {
      expect(kinds).toContain(k)
    }
    expect(kinds[0]).toBe('span_start')
    expect(kinds[kinds.length - 1]).toBe('span_end') // the span brackets the whole run incl. verify
  })

  it('all-on halt path: a budget trip cancels the run cleanly and SKIPS verify', async () => {
    const taskId = newCodeTask()
    setBudgetLimit(createDb(getDbPath()), {
      scope: 'agent',
      scopeId: 'claude-1',
      limitUsdCents: 1,
      mode: 'cap',
    }) // 1¢ hard cap

    const b = scriptBuilder()
    b.costUsd(0.5) // 50¢ on the first cost event → budget pauses immediately
    for (let i = 0; i < 5; i += 1) b.pair('read', { path: 'x' }, true) // would also trip the breaker, but later
    b.done('success') // safety net — never reached
    const adapter = new ScriptedAdapter('claude-code', b.build())

    const result = await runTaskOnRuntime({
      db: createDb(getDbPath()),
      makeAdapter: (ctx: RuntimeRunContext) => {
        if (ctx.cwd) dirtyWorktree(ctx.cwd)
        return adapter
      },
      taskId,
      assigneeAgentId: 'claude-1',
      repoPath: repo,
      kind: 'code',
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.doneReason).toBe('aborted')
    expect(result.status).toBe('todo') // released — clean resumable state
    expect(result.summary).toBe('auto-paused (budget)') // budget, not the breaker
    expect(adapter.aborts).toBe(1) // exactly one abort — no double-abort

    const db = createDb(getDbPath())
    expect(getTask(db, taskId)?.status).toBe('todo')
    expect(listGovernanceAudit(db, { eventType: 'budget' })).toHaveLength(1)
    expect(listGovernanceAudit(db, { eventType: 'circuit_break' })).toHaveLength(0) // breaker did NOT fire
    // verify never runs on a halt (it only gates a SUCCESSFUL run's completion).
    expect(getTaskVerification(db, taskId) ?? null).toBeNull()
    // obs still recorded a terminal for the cancelled run.
    expect(listEvents(db, { taskId, kinds: ['execution_completed'], limit: 100 })).toHaveLength(1)
    // the worktree survives the halt → resumable.
    const ws = await getTaskWorkspace(taskId)
    expect(ws.ok).toBe(true)
  })
})

// ── LIVE variant (opt-in; skipped in CI) ────────────────────────────────────────
// Drives the REAL Claude Code runtime through the runtimes REST against a real
// worktree + a cheap model. Requires `claude` CLI auth (or ANTHROPIC_API_KEY) and
// costs real money, so it's gated on CLAWBOO_LIVE_ACCEPTANCE=1 and skipped
// otherwise (CI never has the key). Run it with:
//   CLAWBOO_LIVE_ACCEPTANCE=1 CLAWBOO_LIVE_MODEL=<cheap-model> \
//   pnpm --filter @clawboo/web exec vitest run executorRunner.integration
describe.skipIf(process.env['CLAWBOO_LIVE_ACCEPTANCE'] !== '1')(
  'LIVE: real Claude Code runtime (opt-in)',
  () => {
    let repo: string
    let _home: string
    let prevHome: string | undefined

    beforeEach(async () => {
      // Live auth (Claude CLI keychain) needs the REAL HOME — do NOT sandbox it here;
      // isolate via CLAWBOO_DB_PATH-style throwaway state when running live.
      _home = process.env['HOME'] ?? os.homedir()
      prevHome = process.env['HOME']
      repo = await initRepo()
    })
    afterEach(async () => {
      if (prevHome !== undefined) process.env['HOME'] = prevHome
      await rm(repo, { recursive: true, force: true }).catch(() => {})
    })

    it('a real Claude Code run completes a board task with a worktree + verify + obs', async () => {
      const taskId = createTask(createDb(getDbPath()), {
        title: 'Append a line to feature.txt and set VERIFY_CMD',
        description:
          "Create a file `feature.txt` with a single line of text in the working directory, then set `VERIFY_CMD='test -f feature.txt'` inside init.sh. Report a one-line summary when done.",
        status: 'todo',
        teamId: 'team-live',
      }).id

      const res = mockRes()
      await runtimesRunPOST(
        {
          params: { id: 'claude-code' },
          body: {
            taskId,
            assigneeAgentId: 'claude-live',
            repoPath: repo,
            kind: 'code',
            model: process.env['CLAWBOO_LIVE_MODEL'] ?? null,
          },
        } as unknown as Request,
        res.res,
      )
      expect(res.statusCode()).toBe(200)

      const db = createDb(getDbPath())
      const task = getTask(db, taskId)
      expect(['done', 'in_review', 'in_progress']).toContain(task?.status)
      // the run left an obs trace + a board comment (report-up).
      expect(
        listEvents(db, { taskId, kinds: ['execution_started'], limit: 10 }).length,
      ).toBeGreaterThanOrEqual(1)
      expect(getComments(db, taskId).length).toBeGreaterThan(0)
    }, 180_000)
  },
)

function mockRes(): { res: Response; statusCode: () => number; body: () => unknown } {
  let code = 200
  let payload: unknown
  const res = {
    status(c: number) {
      code = c
      return this
    },
    json(b: unknown) {
      payload = b
      return this
    },
  } as unknown as Response
  return { res, statusCode: () => code, body: () => payload }
}
