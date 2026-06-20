// Executor-runner integration test. Drives the runner against a REAL sqlite
// board + a REAL temp git repo (worktrees), with `$HOME` overridden so the db
// and worktree root land in a throwaway sandbox (never the dev's `~/.openclaw`).
// The runtime is a FAKE adapter that yields a scripted normalized event stream
// and records the StartOpts it received — so we assert the runner's
// ORCHESTRATION (claim → worktree → context assembly → report-up → status →
// handoff), not any adapter/driver internals (those are contract-tested in their
// own packages). Proves: happy path + execution ledger + report-up; the
// cross-runtime handoff (one runtime pauses, a DIFFERENT one resumes from the
// worktree alone); 409-no-retry; bounded spawn depth; capability degradation;
// and the REST gating 404 when no runtime flag is set.

import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import type { Response } from 'express'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { CodexAdapter, type CodexDriver, type CodexNativeEvent } from '@clawboo/adapter-codex'
import { HermesAdapter, type HermesDriver, type HermesNativeEvent } from '@clawboo/adapter-hermes'
import { resolveClawbooDir } from '@clawboo/config'
import {
  claimTask,
  createDb,
  createTask,
  getBudget,
  getComments,
  getTask,
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

import { getDbPath } from '../db'
import { planDegradations } from '../degradation'
import { runTaskOnRuntime } from '../executorRunner'
import { runtimeIdentityHomePath } from '../runtimes/identityHome'
import { getTaskWorkspace } from '../worktrees'

const execFileAsync = promisify(execFile)
async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync('git', args, { cwd, windowsHide: true })
}
async function initRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'clawboo-exec-repo-'))
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

/** Minimal RuntimeAdapter test double: scripts an event stream, records StartOpts. */
class FakeRunnerAdapter implements RuntimeAdapter {
  readonly participantKind = 'agent' as const
  startedOpts: StartOpts | null = null

  constructor(
    readonly id: string,
    private readonly caps: Capabilities,
    private readonly summary: string,
    private readonly reason: 'success' | 'error' | 'aborted' = 'success',
  ) {}

  capabilities(): Capabilities {
    return this.caps
  }
  async health() {
    return { ok: true }
  }
  async start(_t: TaskHandle, opts: StartOpts): Promise<RunHandle> {
    this.startedOpts = opts
    return { adapterId: this.id, sessionKey: opts.sessionKey, runId: null }
  }
  events(run: RunHandle): AsyncIterable<RuntimeEvent> {
    let seq = 0
    const base = () => ({
      runId: run.sessionKey,
      sessionId: run.sessionKey,
      ts: 1,
      seq: (seq += 1),
    })
    const summary = this.summary
    const reason = this.reason
    return (async function* () {
      yield { ...base(), kind: 'text-delta', text: summary, channel: 'assistant' } as RuntimeEvent
      yield { ...base(), kind: 'done', reason, summary } as RuntimeEvent
    })()
  }
  async abort() {}
  async setModel() {}
  async writeContext() {}
}

describe('executor runner (real board + real git worktree)', () => {
  let repo: string
  let home: string
  let prevHome: string | undefined

  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), 'clawboo-exec-home-'))
    await mkdir(path.join(home, '.openclaw', 'clawboo'), { recursive: true })
    prevHome = process.env['HOME']
    process.env['HOME'] = home // → getDbPath() + worktree root land in the sandbox
    repo = await initRepo()
  })

  afterEach(async () => {
    if (prevHome === undefined) delete process.env['HOME']
    else process.env['HOME'] = prevHome
    await rm(home, { recursive: true, force: true })
    await rm(repo, { recursive: true, force: true })
  })

  function newCodeTask(title = 'Implement the thing'): string {
    const db = createDb(getDbPath())
    const task = createTask(db, { title, description: 'do it', status: 'todo', teamId: 'team-1' })
    return task.id
  }

  it('happy path: claims, provisions a worktree, reports up, completes the execution', async () => {
    const taskId = newCodeTask()
    const fake = new FakeRunnerAdapter('claude-code', FULL_CAPS, 'Implemented and verified.')
    const result = await runTaskOnRuntime({
      db: createDb(getDbPath()),
      makeAdapter: () => fake,
      taskId,
      assigneeAgentId: 'claude-1',
      repoPath: repo,
      kind: 'code',
      mcpBaseUrl: 'http://localhost:18790',
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.runtimeId).toBe('claude-code')
    expect(result.usedWorktree).toBe(true)
    expect(result.doneReason).toBe('success')
    // empty diff (only the SoR was written) → done + cleanup.
    expect(['done', 'in_review']).toContain(result.status)
    // The report-up summary is recorded as a board comment + carried on the run.
    expect(result.summary).toContain('Implemented and verified')
    // The runner injected an MCP availability note into the prompt context.
    expect(fake.startedOpts?.context ?? '').toContain('MCP')
  })

  it('refuses a second claim with 409 and never retries', async () => {
    const taskId = newCodeTask()
    // Someone else already owns it (in_progress).
    claimTask(createDb(getDbPath()), taskId, 'other-agent', 'openclaw')
    const fake = new FakeRunnerAdapter('codex', FULL_CAPS, 'should not run')
    const result = await runTaskOnRuntime({
      db: createDb(getDbPath()),
      makeAdapter: () => fake,
      taskId,
      assigneeAgentId: 'codex-1',
      repoPath: repo,
    })
    expect(result).toEqual({ ok: false, reason: 'conflict' })
    expect(fake.startedOpts).toBeNull() // never started the runtime
  })

  it('a runtime error summary carrying a credential is scrubbed before the board comment + the result', async () => {
    const taskId = newCodeTask()
    // A CLI that dumps its env to stderr on a crash: the key must never persist.
    const leak = 'crash: OPENROUTER_API_KEY=sk-or-SECRETKEY1234567890ABCDEF env dump'
    const fake = new FakeRunnerAdapter('hermes', FULL_CAPS, leak, 'error')
    const result = await runTaskOnRuntime({
      db: createDb(getDbPath()),
      makeAdapter: () => fake,
      taskId,
      assigneeAgentId: 'hermes-1',
      repoPath: repo,
      kind: 'code',
      mcpBaseUrl: 'http://localhost:18790',
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.doneReason).toBe('error')
    expect(result.summary).not.toContain('sk-or-SECRETKEY')
    // The durable board comment + execution row carry the redacted text, not the key.
    const comments = getComments(createDb(getDbPath()), taskId)
    expect(JSON.stringify(comments)).not.toContain('sk-or-SECRETKEY')
    expect(JSON.stringify(comments)).toContain('[REDACTED]')
  })

  it('cross-runtime handoff: Claude Code pauses, Codex resumes from the worktree alone', async () => {
    const taskId = newCodeTask('Wire the CLI flag and parser')
    // Run 1 — Claude Code does partial work and PAUSES (keepForResume): writes
    // AGENT_HANDOFF.json, releases the task, keeps the worktree.
    const run1 = new FakeRunnerAdapter(
      'claude-code',
      FULL_CAPS,
      'Wired the --json flag; NEXT: finish the SSE parser.',
    )
    const r1 = await runTaskOnRuntime({
      db: createDb(getDbPath()),
      makeAdapter: () => run1,
      taskId,
      assigneeAgentId: 'claude-1',
      repoPath: repo,
      keepForResume: true,
    })
    expect(r1.ok).toBe(true)
    if (r1.ok) expect(r1.status).toBe('todo') // released for continuation

    // The handoff landed in the worktree (no chat / board needed to read it).
    const ws = await getTaskWorkspace(taskId)
    expect(ws.ok).toBe(true)
    if (ws.ok) expect(ws.handoff?.nextBestStep ?? '').toContain('finish the SSE parser')

    // Run 2 — a DIFFERENT runtime (Codex) claims the same task and resumes. Its
    // prompt context must carry run 1's handoff, reconstructed from the worktree.
    const run2 = new FakeRunnerAdapter('codex', FULL_CAPS, 'Finished the parser. Done.')
    const r2 = await runTaskOnRuntime({
      db: createDb(getDbPath()),
      makeAdapter: () => run2,
      taskId,
      assigneeAgentId: 'codex-1',
      repoPath: repo,
    })
    expect(r2.ok).toBe(true)
    expect(run2.startedOpts?.context ?? '').toContain('finish the SSE parser')
  })

  it('refuses a task nested past MAX_SPAWN_DEPTH', async () => {
    const db = createDb(getDbPath())
    const root = createTask(db, { title: 'root', status: 'todo' })
    const child = createTask(db, { title: 'child', status: 'todo', parentTaskId: root.id })
    const grandchild = createTask(db, {
      title: 'grandchild',
      status: 'todo',
      parentTaskId: child.id,
    })
    const fake = new FakeRunnerAdapter('claude-code', FULL_CAPS, 'nope')
    const result = await runTaskOnRuntime({
      db: createDb(getDbPath()),
      makeAdapter: () => fake,
      taskId: grandchild.id,
      assigneeAgentId: 'claude-1',
      repoPath: repo,
      maxSpawnDepth: 2,
    })
    expect(result).toEqual({ ok: false, reason: 'too_deep' })
    expect(fake.startedOpts).toBeNull()
  })

  it('applies capability degradation for a runtime missing resume + approval + streaming', async () => {
    const taskId = newCodeTask()
    const limited: Capabilities = {
      ...FULL_CAPS,
      resume: false,
      toolApproval: false,
      streaming: false,
    }
    const fake = new FakeRunnerAdapter('hermes', limited, 'done')
    const result = await runTaskOnRuntime({
      db: createDb(getDbPath()),
      makeAdapter: () => fake,
      taskId,
      assigneeAgentId: 'hermes-1',
      repoPath: repo,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.degradations).toEqual(
      expect.arrayContaining([
        expect.stringContaining('resume-via-handoff'),
        expect.stringContaining('approvals-via-clawboo'),
        expect.stringContaining('coarse-streaming'),
      ]),
    )
    expect(fake.startedOpts?.context ?? '').toContain('Degradations applied')
  })
})

describe('planDegradations (pure)', () => {
  it('maps absent capabilities to the right fallbacks', () => {
    expect(
      planDegradations({
        streaming: true,
        mcp: true,
        worktrees: true,
        resume: true,
        toolApproval: true,
        models: [],
      }),
    ).toEqual({
      resumeViaHandoff: false,
      routeApprovalsThroughClawboo: false,
      coarseStreaming: false,
    })
    expect(
      planDegradations({
        streaming: false,
        mcp: false,
        worktrees: false,
        resume: false,
        toolApproval: false,
        models: [],
      }),
    ).toEqual({
      resumeViaHandoff: true,
      routeApprovalsThroughClawboo: true,
      coarseStreaming: true,
    })
  })
})

// ── Circuit breakers ───────────────────────────────────────
// A scripted adapter that yields a fixed RuntimeEvent[] and counts abort() calls,
// so a looping / runaway stream replays deterministically.
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
    cost(inputTokens: number, ts: number) {
      out.push({
        ...base(ts),
        kind: 'cost',
        costUsd: 0,
        usage: { inputTokens, outputTokens: 0 },
        model: 'm',
      } as RuntimeEvent)
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
    /** A NON-fatal error event carrying a typed code (e.g. a broker policy denial).
     *  `message` defaults from the code; pass it to vary the reason prose while
     *  keeping the same typed code. */
    error(code: string, ts = 1, message = `${code} reason`) {
      out.push({ ...base(ts), kind: 'error', code, message, fatal: false } as RuntimeEvent)
    },
    build: () => out,
  }
  return api
}

describe('executor runner — circuit breakers', () => {
  let repo: string
  let home: string
  let prevHome: string | undefined

  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), 'clawboo-brk-home-'))
    await mkdir(path.join(home, '.openclaw', 'clawboo'), { recursive: true })
    prevHome = process.env['HOME']
    process.env['HOME'] = home
    repo = await initRepo()
  })
  afterEach(async () => {
    if (prevHome === undefined) delete process.env['HOME']
    else process.env['HOME'] = prevHome
    await rm(home, { recursive: true, force: true })
    await rm(repo, { recursive: true, force: true })
  })

  function newCodeTask(title = 'Implement the thing'): string {
    return createTask(createDb(getDbPath()), {
      title,
      description: 'do it',
      status: 'todo',
      teamId: 'team-1',
    }).id
  }

  async function run(taskId: string, fake: ScriptedAdapter, agentId = 'claude-1') {
    return runTaskOnRuntime({
      db: createDb(getDbPath()),
      makeAdapter: () => fake,
      taskId,
      assigneeAgentId: agentId,
      repoPath: repo,
      kind: 'code',
    })
  }

  /** Assert the full breaker teardown for a given halt reason. */
  function expectHalted(taskId: string, reason: string) {
    const db = createDb(getDbPath())
    expect(getTask(db, taskId)?.status).toBe('todo') // released — clean resumable state
    expect(listGovernanceAudit(db, { eventType: 'circuit_break' }).length).toBe(1)
    expect(getComments(db, taskId).some((c) => c.body.includes(`[stopped: ${reason}]`))).toBe(true)
    const completed = listEvents(db, { taskId, kinds: ['execution_completed'] })
    expect(
      completed.some(
        (e) => (JSON.parse(e.data) as { error?: string }).error === `circuit_broken:${reason}`,
      ),
    ).toBe(true)
  }

  it('halts on consecutive identical-tool failures, releases the task', async () => {
    const taskId = newCodeTask()
    const b = scriptBuilder()
    for (let i = 0; i < 3; i += 1) b.pair('read', { path: 'x' }, true) // same name+input → same signature
    b.done('success') // safety net — must never be reached
    const fake = new ScriptedAdapter('claude-code', b.build())
    const result = await run(taskId, fake)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.doneReason).toBe('aborted')
    expect(result.status).toBe('todo')
    expect(result.summary).toBe('stopped: repeat-failure')
    expect(fake.aborts).toBe(1)
    expectHalted(taskId, 'repeat-failure')
  })

  it('halts on a no-progress loop (no new successful output)', async () => {
    const taskId = newCodeTask()
    const b = scriptBuilder()
    // 6 failures across alternating tools: repeat-failure never reaches 3.
    for (let i = 0; i < 6; i += 1) b.pair(i % 2 ? 'b' : 'a', { i: i % 2 }, true)
    b.done('success')
    const fake = new ScriptedAdapter('codex', b.build())
    const result = await run(taskId, fake, 'codex-1')
    expect(result.ok && result.summary).toBe('stopped: no-progress')
    expect(fake.aborts).toBe(1)
    expectHalted(taskId, 'no-progress')
  })

  it('halts a runaway at the hard tool-iteration cap', async () => {
    const taskId = newCodeTask()
    const b = scriptBuilder()
    for (let i = 0; i < 31; i += 1) b.toolCall(`t${i}`, { i }) // 31 settled calls > the 30 cap
    b.done('success')
    const fake = new ScriptedAdapter('hermes', b.build())
    const result = await run(taskId, fake, 'hermes-1')
    expect(result.ok && result.summary).toBe('stopped: iteration-cap')
    expectHalted(taskId, 'iteration-cap')
  })

  it('halts on a token-velocity breach', async () => {
    const taskId = newCodeTask()
    const b = scriptBuilder()
    b.cost(100_000, 0)
    b.cost(100_000, 20_000) // 200k tokens / 20s = 600k/min > the 200k ceiling
    b.done('success')
    const fake = new ScriptedAdapter('claude-code', b.build())
    const result = await run(taskId, fake)
    expect(result.ok && result.summary).toBe('stopped: token-velocity')
    expect(fake.aborts).toBe(1)
    expectHalted(taskId, 'token-velocity')
  })

  it('halts on repeated policy denials (reachable via a typed policy_denied error code)', async () => {
    const taskId = newCodeTask()
    const b = scriptBuilder()
    b.error('policy_denied')
    b.error('policy_denied') // 2nd identical denial → trips the default threshold of 2
    b.done('success') // safety net — must never be reached
    const fake = new ScriptedAdapter('clawboo-native', b.build())
    const result = await run(taskId, fake, 'native-1')
    expect(result.ok && result.summary).toBe('stopped: repeat-policy-denied')
    expect(fake.aborts).toBe(1)
    expectHalted(taskId, 'repeat-policy-denied')
  })

  it('repeat-policy-denied trips on two consecutive denials with the SAME code but DIFFERENT reasons (keys on the typed code, not message prose)', async () => {
    // The native harness emits a constant `policy_denied` code for every broker
    // denial, with the specific reason in the message. The breaker signature is the
    // typed code, so two denials of DIFFERENT tools/reasons still trip — the
    // "any N consecutive denials" backstop, by design (the reason is never a control signal).
    const taskId = newCodeTask()
    const b = scriptBuilder()
    b.error('policy_denied', 1, 'tool web_search requires approval')
    b.error('policy_denied', 1, 'tool delete_path is not available')
    b.done('success') // safety net — must never be reached
    const fake = new ScriptedAdapter('clawboo-native', b.build())
    const result = await run(taskId, fake, 'native-1')
    expect(result.ok && result.summary).toBe('stopped: repeat-policy-denied')
    expectHalted(taskId, 'repeat-policy-denied')
  })

  it('a run whose caller already disconnected bails BEFORE claiming or starting the adapter', async () => {
    // A queued waiter whose AbortController fired (the HTTP client disconnected)
    // must release its turn without claiming/spawning. Pre-fix it ran the full path
    // and returned ok:true/doneReason:'aborted'; now it short-circuits to ok:false.
    const taskId = newCodeTask()
    const b = scriptBuilder()
    b.done('success')
    const fake = new ScriptedAdapter('claude-code', b.build())
    const ctl = new AbortController()
    ctl.abort()
    const result = await runTaskOnRuntime({
      db: createDb(getDbPath()),
      makeAdapter: () => fake,
      taskId,
      assigneeAgentId: 'claude-1',
      repoPath: repo,
      kind: 'code',
      abortSignal: ctl.signal,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('conflict')
    expect(fake.startedOpts).toBeNull() // never claimed → adapter never started
    expect(getTask(createDb(getDbPath()), taskId)?.status).toBe('todo') // board untouched
  })

  it('honors a per-run breakerConfig override (a tighter iteration cap trips early)', async () => {
    const taskId = newCodeTask()
    const b = scriptBuilder()
    for (let i = 0; i < 3; i += 1) b.toolCall(`t${i}`, { i }) // 3 settled calls > the override cap of 2
    b.done('success')
    const fake = new ScriptedAdapter('claude-code', b.build())
    const result = await runTaskOnRuntime({
      db: createDb(getDbPath()),
      makeAdapter: () => fake,
      taskId,
      assigneeAgentId: 'claude-1',
      repoPath: repo,
      kind: 'code',
      breakerConfig: { maxToolIterations: 2 },
    })
    expect(result.ok && result.summary).toBe('stopped: iteration-cap')
    expectHalted(taskId, 'iteration-cap')
  })

  it('composes with the budget kill-switch — exactly one abort, budget wins the tie', async () => {
    const taskId = newCodeTask()
    setBudgetLimit(createDb(getDbPath()), {
      scope: 'agent',
      scopeId: 'claude-1',
      limitUsdCents: 1,
      mode: 'cap',
    })
    const b = scriptBuilder()
    b.costUsd(0.5) // 50¢ on the FIRST cost event → budget pauses immediately
    for (let i = 0; i < 5; i += 1) b.pair('read', { path: 'x' }, true) // breaker would also fire, but later
    b.done('success')
    const fake = new ScriptedAdapter('claude-code', b.build())
    const result = await run(taskId, fake)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.summary).toBe('auto-paused (budget)') // budget, not the breaker
    expect(fake.aborts).toBe(1) // exactly one abort — no double-abort
    const db = createDb(getDbPath())
    expect(listGovernanceAudit(db, { eventType: 'circuit_break' }).length).toBe(0) // breaker did NOT fire
    expect(listGovernanceAudit(db, { eventType: 'budget' }).length).toBe(1)
    expect(listEvents(db, { taskId, kinds: ['execution_completed'] }).length).toBe(1) // one terminal
  })
})

function _mockRes(): { res: Response; statusCode: () => number; body: () => unknown } {
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

// ─── Concurrency / cancellation / home-perms (process & state lifecycle) ──────

// A persistent-home runtime (native + wrapped-oneshot like Hermes) shares ONE
// state.db per (runtime, identity), so the runner must serialize its dispatch.
const PERSISTENT_CAPS: Capabilities = {
  streaming: true,
  mcp: false,
  worktrees: false, // no git needed — this exercises the home mutex, not worktrees
  resume: true,
  toolApproval: false,
  models: [],
  runtimeClass: 'native',
  nativeHome: { scope: 'per-identity', persist: true },
}

describe('executor runner — per-identity home serialization + cancellation + 0700', () => {
  let home: string
  let prevHome: string | undefined

  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), 'clawboo-exec-conc-'))
    await mkdir(path.join(home, '.openclaw', 'clawboo'), { recursive: true })
    prevHome = process.env['HOME']
    process.env['HOME'] = home
  })
  afterEach(async () => {
    if (prevHome === undefined) delete process.env['HOME']
    else process.env['HOME'] = prevHome
    await rm(home, { recursive: true, force: true })
  })

  function newTask(title = 'persistent task'): string {
    return createTask(createDb(getDbPath()), {
      title,
      description: 'do it',
      status: 'todo',
      teamId: 'team-1',
    }).id
  }

  /** A persistent-home adapter that records peak concurrency across all instances
   *  via a SHARED counter — so two overlapping runs of one identity are detectable. */
  function makeConcurrencyAdapter(
    id: string,
    tracker: { active: number; max: number },
  ): RuntimeAdapter {
    return {
      id,
      participantKind: 'agent',
      capabilities: () => PERSISTENT_CAPS,
      async health() {
        return { ok: true }
      },
      async start(_t: TaskHandle, opts: StartOpts): Promise<RunHandle> {
        tracker.active += 1
        tracker.max = Math.max(tracker.max, tracker.active)
        return { adapterId: id, sessionKey: opts.sessionKey, runId: null }
      },
      events(run: RunHandle): AsyncIterable<RuntimeEvent> {
        const b = () => ({ runId: run.sessionKey, sessionId: run.sessionKey, ts: 1, seq: 1 })
        return (async function* () {
          try {
            await new Promise((r) => setTimeout(r, 15)) // hold the window open
            yield { ...b(), kind: 'text-delta', text: 'ok', channel: 'assistant' } as RuntimeEvent
            await new Promise((r) => setTimeout(r, 15))
            yield { ...b(), kind: 'done', reason: 'success', summary: 'ok' } as RuntimeEvent
          } finally {
            tracker.active -= 1
          }
        })()
      },
      async abort() {},
      async setModel() {},
      async writeContext() {},
    }
  }

  it('serializes two concurrent dispatches of the SAME identity (one writer per home)', async () => {
    const tracker = { active: 0, max: 0 }
    const t1 = newTask('a')
    const t2 = newTask('b')
    const run = (taskId: string) =>
      runTaskOnRuntime({
        db: createDb(getDbPath()),
        makeAdapter: () => makeConcurrencyAdapter('clawboo-native', tracker),
        taskId,
        assigneeAgentId: 'agent-X', // SAME identity → same persistent home
      })
    const [r1, r2] = await Promise.all([run(t1), run(t2)])
    expect(r1.ok && r2.ok).toBe(true)
    // Never two writers against one state.db: the second run waited its turn.
    expect(tracker.max).toBe(1)
  })

  it('does NOT over-serialize different identities (they run concurrently)', async () => {
    const tracker = { active: 0, max: 0 }
    const t1 = newTask('a')
    const t2 = newTask('b')
    const run = (taskId: string, agentId: string) =>
      runTaskOnRuntime({
        db: createDb(getDbPath()),
        makeAdapter: () => makeConcurrencyAdapter('clawboo-native', tracker),
        taskId,
        assigneeAgentId: agentId,
      })
    const [r1, r2] = await Promise.all([run(t1, 'agent-A'), run(t2, 'agent-B')])
    expect(r1.ok && r2.ok).toBe(true)
    expect(tracker.max).toBe(2) // distinct homes → no serialization
  })

  it('an external abort (client disconnect) aborts the live run and releases the task', async () => {
    const taskId = newTask('hang')
    let aborted = false
    let release: (() => void) | null = null
    const adapter: RuntimeAdapter = {
      id: 'clawboo-native',
      participantKind: 'agent',
      capabilities: () => ({ ...PERSISTENT_CAPS }),
      async health() {
        return { ok: true }
      },
      async start(_t: TaskHandle, opts: StartOpts): Promise<RunHandle> {
        return { adapterId: 'clawboo-native', sessionKey: opts.sessionKey, runId: null }
      },
      events(run: RunHandle): AsyncIterable<RuntimeEvent> {
        const b = () => ({ runId: run.sessionKey, sessionId: run.sessionKey, ts: 1, seq: 1 })
        return (async function* () {
          yield {
            ...b(),
            kind: 'text-delta',
            text: 'working',
            channel: 'assistant',
          } as RuntimeEvent
          await new Promise<void>((res) => {
            release = res
          }) // hang until aborted
          yield {
            ...b(),
            kind: 'done',
            reason: aborted ? 'aborted' : 'success',
            summary: '',
          } as RuntimeEvent
        })()
      },
      async abort() {
        aborted = true
        release?.()
      },
      async setModel() {},
      async writeContext() {},
    }
    const ctl = new AbortController()
    const p = runTaskOnRuntime({
      db: createDb(getDbPath()),
      makeAdapter: () => adapter,
      taskId,
      assigneeAgentId: 'agent-Z',
      abortSignal: ctl.signal,
    })
    await new Promise((r) => setTimeout(r, 30)) // let the run reach the hang
    ctl.abort()
    const result = await p
    expect(aborted).toBe(true) // the live run was aborted
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.doneReason).toBe('aborted')
    expect(result.status).toBe('todo') // released, retryable
    expect(getTask(createDb(getDbPath()), taskId)?.status).toBe('todo')
  })

  it.skipIf(process.platform === 'win32')(
    'materializes the persistent identity home as 0700',
    async () => {
      const taskId = newTask('perms')
      await runTaskOnRuntime({
        db: createDb(getDbPath()),
        makeAdapter: () => makeConcurrencyAdapter('clawboo-native', { active: 0, max: 0 }),
        taskId,
        assigneeAgentId: 'agent-perms',
      })
      const homeDir = runtimeIdentityHomePath('clawboo-native', 'agent-perms')
      expect(resolveClawbooDir()).toContain(home) // sanity: the home is sandboxed
      const st = await stat(homeDir)
      expect(st.mode & 0o777).toBe(0o700)
    },
  )
})

// A CodexDriver / HermesDriver double that REPLAYS its native events the moment the
// adapter subscribes (in `events()`), so the REAL mapper produces the cost event —
// this drives the real adapter, NOT an injected RuntimeEvent.
class ReplayCodexDriver implements CodexDriver {
  constructor(private readonly events: CodexNativeEvent[]) {}
  async start(): Promise<void> {}
  onEvent(handler: (ev: CodexNativeEvent) => void): () => void {
    for (const ev of this.events) handler(ev)
    return () => {}
  }
  async abort(): Promise<void> {}
  async setModel(): Promise<void> {}
  async writeContext(): Promise<void> {}
}
class ReplayHermesDriver implements HermesDriver {
  constructor(private readonly events: HermesNativeEvent[]) {}
  async start(): Promise<void> {}
  onEvent(handler: (ev: HermesNativeEvent) => void): () => void {
    for (const ev of this.events) handler(ev)
    return () => {}
  }
  async abort(): Promise<void> {}
  async setModel(): Promise<void> {}
  async writeContext(): Promise<void> {}
}

describe('executor cost estimation across runtimes (the budget cap engages for every runtime)', () => {
  let repo: string
  let home: string
  let prevHome: string | undefined

  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), 'clawboo-cost-home-'))
    await mkdir(path.join(home, '.openclaw', 'clawboo'), { recursive: true })
    prevHome = process.env['HOME']
    process.env['HOME'] = home
    repo = await initRepo()
  })
  afterEach(async () => {
    if (prevHome === undefined) delete process.env['HOME']
    else process.env['HOME'] = prevHome
    await rm(home, { recursive: true, force: true })
    await rm(repo, { recursive: true, force: true })
  })

  function newTeamTask(title = 'Do the thing'): string {
    return createTask(createDb(getDbPath()), {
      title,
      description: 'do it',
      status: 'todo',
      teamId: 'team-1',
    }).id
  }

  it('estimates a CODEX run from reported usage so the cap engages (real adapter), then blocks the next dispatch', async () => {
    // A 1-cent team cap; Codex reports usage but NO USD → the executor must estimate.
    setBudgetLimit(createDb(getDbPath()), {
      scope: 'team',
      scopeId: 'team-1',
      limitUsdCents: 1,
      mode: 'cap',
    })
    const taskId = newTeamTask()

    const r1 = await runTaskOnRuntime({
      db: createDb(getDbPath()),
      makeAdapter: () =>
        new CodexAdapter(
          () =>
            new ReplayCodexDriver([
              {
                type: 'result',
                ok: true,
                summary: 'did it',
                usage: { inputTokens: 100_000, outputTokens: 100_000 },
                model: 'gpt-5-codex',
              },
            ]),
        ),
      taskId,
      assigneeAgentId: 'codex-1',
      repoPath: repo,
      kind: 'code',
    })
    expect(r1.ok).toBe(true)
    if (!r1.ok) return
    expect(r1.doneReason).toBe('aborted') // the kill-switch fired on the estimated spend
    expect(r1.status).toBe('todo')
    const db = createDb(getDbPath())
    expect(getTask(db, taskId)?.status).toBe('todo') // released, retryable
    const b = getBudget(db, 'team', 'team-1')
    expect(b?.status).toBe('paused') // the cap engaged from estimated usage
    expect(b?.spentUsdCents ?? 0).toBeGreaterThan(0) // spend is no longer invisible

    // The NEXT dispatch on the same (paused) team is refused pre-flight — never claimed.
    const taskId2 = newTeamTask('next')
    const r2 = await runTaskOnRuntime({
      db: createDb(getDbPath()),
      makeAdapter: () =>
        new CodexAdapter(
          () =>
            new ReplayCodexDriver([
              {
                type: 'result',
                ok: true,
                summary: 'should not run',
                usage: { inputTokens: 1, outputTokens: 1 },
                model: 'gpt-5-codex',
              },
            ]),
        ),
      taskId: taskId2,
      assigneeAgentId: 'codex-1',
      repoPath: repo,
      kind: 'code',
    })
    expect(r2.ok).toBe(false)
    if (r2.ok) return
    expect(r2.reason).toBe('budget_paused')
    expect(getTask(createDb(getDbPath()), taskId2)?.status).toBe('todo') // never claimed
  })

  it('estimates a HERMES run from reported usage so the cap engages (real adapter)', async () => {
    setBudgetLimit(createDb(getDbPath()), {
      scope: 'team',
      scopeId: 'team-1',
      limitUsdCents: 1,
      mode: 'cap',
    })
    const taskId = newTeamTask()

    const r = await runTaskOnRuntime({
      db: createDb(getDbPath()),
      makeAdapter: () =>
        new HermesAdapter(
          () =>
            new ReplayHermesDriver([
              {
                type: 'result',
                ok: true,
                summary: 'did it',
                usage: { inputTokens: 100_000, outputTokens: 100_000 },
                model: 'some-hermes-model',
              },
            ]),
        ),
      taskId,
      assigneeAgentId: 'hermes-1',
      repoPath: repo,
      kind: 'code',
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.doneReason).toBe('aborted')
    const db = createDb(getDbPath())
    expect(getTask(db, taskId)?.status).toBe('todo')
    expect(getBudget(db, 'team', 'team-1')?.status).toBe('paused')
  })

  it('records a REAL costUsd exactly — the estimate never fires for an exact-cost runtime (no regression)', async () => {
    // A warn budget with plenty of headroom — it must record the EXACT cost, unpaused.
    setBudgetLimit(createDb(getDbPath()), {
      scope: 'team',
      scopeId: 'team-1',
      limitUsdCents: 100_000,
      mode: 'warn',
    })
    const taskId = newTeamTask()
    const b = scriptBuilder()
    b.costUsd(0.5) // a real reported costUsd (Claude Code / pinned-native shape) → exactly 50¢
    b.done('success')
    const r = await runTaskOnRuntime({
      db: createDb(getDbPath()),
      makeAdapter: () => new ScriptedAdapter('claude-code', b.build()),
      taskId,
      assigneeAgentId: 'claude-1',
      repoPath: repo,
      kind: 'code',
    })
    expect(r.ok).toBe(true)
    const bud = getBudget(createDb(getDbPath()), 'team', 'team-1')
    expect(bud?.spentUsdCents).toBe(50) // exact — the estimate path did not re-price it
    expect(bud?.status).not.toBe('paused') // a warn budget never pauses
  })
})
