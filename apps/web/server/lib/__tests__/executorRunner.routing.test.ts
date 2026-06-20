// Native-preservation routing + native session resume, end to end through
// the runner. Real sqlite board + real temp git repo (sandboxed $HOME), fake
// adapters with configurable capabilities — proving the runner routes each
// runtime to its integration depth BY CONSTRUCTION (from capabilities(), never
// a runtime-id switch): a connected-substrate runtime is refused BEFORE the
// claim; a persistent-home runtime gets ONE stable per-identity homeDir; an
// undeclared/ephemeral runtime gets none. And the native-resume thread: a
// successful worktree run persists the codec's session id into
// AGENT_HANDOFF.json, the next SAME-runtime dispatch receives it as ctx.resume,
// a cross-runtime pickup does not, and a rotation successor always starts fresh.

import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createDb, createTask, getTask, listEvents } from '@clawboo/db'
import type {
  Capabilities,
  RunHandle,
  RuntimeAdapter,
  RuntimeEvent,
  SessionCodec,
  StartOpts,
  TaskHandle,
} from '@clawboo/executor'

import { getDbPath } from '../db'
import { runTaskOnRuntime } from '../executorRunner'
import type { RuntimeRunContext } from '../runtimes'
import { getTaskWorkspace } from '../worktrees'

const execFileAsync = promisify(execFile)
async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync('git', args, { cwd, windowsHide: true })
}
async function initRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'clawboo-routing-repo-'))
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

const HERMES_SHAPED: Capabilities = {
  ...FULL_CAPS,
  streaming: false,
  runtimeClass: 'wrapped-oneshot',
  nativeHome: { scope: 'per-identity', persist: true },
  nativeSkills: 'preserve',
  nativeMemory: 'preserve',
  nativeChannels: 'none',
  nativeScheduler: true,
}

type Reason = 'success' | 'max_turns' | 'error'

/** Fake adapter: scripts a terminal reason per start (in order), records the
 *  shared ctx's `resume` AT START TIME, and serializes a configurable native
 *  session id ('mirror-session-key' = return the sessionKey, the contamination
 *  shape the runner must filter out). */
class SeamAdapter implements RuntimeAdapter {
  readonly participantKind = 'agent' as const
  startCount = 0
  startResumes: Array<string | null> = []
  ctx: RuntimeRunContext | null = null
  private readonly reasonBySession = new Map<string, Reason>()

  constructor(
    readonly id: string,
    private readonly caps: Capabilities,
    private readonly reasons: Reason[] = ['success'],
    private readonly nativeId: string | 'mirror-session-key' | null = null,
  ) {}

  readonly sessionCodec: SessionCodec = {
    serialize: async (run: RunHandle): Promise<string> => {
      const sessionId = this.nativeId === 'mirror-session-key' ? run.sessionKey : this.nativeId
      return JSON.stringify({ sessionKey: run.sessionKey, sessionId })
    },
    restore: async (blob: string): Promise<RunHandle> => {
      const p = JSON.parse(blob) as { sessionKey?: string; sessionId?: string | null }
      return { adapterId: this.id, sessionKey: p.sessionKey ?? '', runId: p.sessionId ?? null }
    },
  }

  capabilities(): Capabilities {
    return this.caps
  }
  async health() {
    return { ok: true }
  }
  async start(_t: TaskHandle, opts: StartOpts): Promise<RunHandle> {
    this.startResumes.push(this.ctx?.resume ?? null)
    this.reasonBySession.set(opts.sessionKey, this.reasons[this.startCount] ?? 'success')
    this.startCount += 1
    return { adapterId: this.id, sessionKey: opts.sessionKey, runId: `rid-${this.startCount}` }
  }
  events(run: RunHandle): AsyncIterable<RuntimeEvent> {
    const reason = this.reasonBySession.get(run.sessionKey) ?? 'success'
    let seq = 0
    const base = () => ({
      runId: run.runId ?? run.sessionKey,
      sessionId: run.sessionKey,
      ts: 1,
      seq: (seq += 1),
    })
    return (async function* () {
      yield { ...base(), kind: 'done', reason, summary: `summary:${reason}` } as RuntimeEvent
    })()
  }
  async abort() {}
  async setModel() {}
  async writeContext() {}
}

/** Factory that records every ctx the runner hands out (probe `{}` first, then
 *  the live ctx) and binds the live ctx onto the adapter for start-time reads. */
function recordingFactory(adapter: SeamAdapter): {
  makeAdapter: (ctx: RuntimeRunContext) => RuntimeAdapter
  liveCtx: () => RuntimeRunContext | null
} {
  const ctxs: RuntimeRunContext[] = []
  return {
    makeAdapter: (ctx: RuntimeRunContext) => {
      ctxs.push(ctx)
      adapter.ctx = ctx
      return adapter
    },
    // The probe call gets `{}`; the live ctx is the one carrying the resolved keys.
    liveCtx: () => ctxs.find((c) => 'homeDir' in c) ?? null,
  }
}

describe('executor runner — native-preservation routing (by construction)', () => {
  let home: string
  let prevHome: string | undefined

  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), 'clawboo-routing-home-'))
    await mkdir(path.join(home, '.openclaw', 'clawboo'), { recursive: true })
    prevHome = process.env['HOME']
    process.env['HOME'] = home
  })
  afterEach(async () => {
    if (prevHome === undefined) delete process.env['HOME']
    else process.env['HOME'] = prevHome
    await rm(home, { recursive: true, force: true })
  })

  function newTask(title = 'Implement the thing'): string {
    return createTask(createDb(getDbPath()), {
      title,
      description: 'do it',
      status: 'todo',
      teamId: 'team-1',
    }).id
  }

  it('refuses a connected-substrate runtime BEFORE claiming (never spawned one-shot)', async () => {
    const taskId = newTask()
    const fake = new SeamAdapter('openclaw', {
      ...FULL_CAPS,
      worktrees: false,
      runtimeClass: 'connected-substrate',
      nativeChannels: 'gateway',
      nativeScheduler: true,
    })
    const result = await runTaskOnRuntime({
      db: createDb(getDbPath()),
      makeAdapter: () => fake,
      taskId,
      assigneeAgentId: 'agent-1',
      disableMemoryAutoInject: true,
    })
    expect(result).toEqual({ ok: false, reason: 'connected_substrate' })
    expect(fake.startCount).toBe(0) // the adapter was never started
    const db = createDb(getDbPath())
    expect(getTask(db, taskId)?.status).toBe('todo') // never claimed
    expect(listEvents(db, { taskId, kinds: ['execution_started'] })).toHaveLength(0) // no exec row opened
  })

  it('materializes ONE stable per-identity homeDir for a persistent-home runtime', async () => {
    const expected = path.join(home, '.clawboo', 'runtimes', 'hermes', 'hermes-1')

    const first = new SeamAdapter('hermes', HERMES_SHAPED)
    const f1 = recordingFactory(first)
    await runTaskOnRuntime({
      db: createDb(getDbPath()),
      makeAdapter: f1.makeAdapter,
      taskId: newTask(),
      assigneeAgentId: 'hermes-1',
      disableMemoryAutoInject: true,
    })
    expect(f1.liveCtx()?.homeDir).toBe(expected)

    // A SECOND run for the same agent resolves the SAME home (stability — this
    // is what lets native skills/memory compound across runs).
    const second = new SeamAdapter('hermes', HERMES_SHAPED)
    const f2 = recordingFactory(second)
    await runTaskOnRuntime({
      db: createDb(getDbPath()),
      makeAdapter: f2.makeAdapter,
      taskId: newTask('Another task'),
      assigneeAgentId: 'hermes-1',
      disableMemoryAutoInject: true,
    })
    expect(f2.liveCtx()?.homeDir).toBe(expected)

    // A different identity gets a different home.
    const third = new SeamAdapter('hermes', HERMES_SHAPED)
    const f3 = recordingFactory(third)
    await runTaskOnRuntime({
      db: createDb(getDbPath()),
      makeAdapter: f3.makeAdapter,
      taskId: newTask('Third task'),
      assigneeAgentId: 'hermes-2',
      disableMemoryAutoInject: true,
    })
    expect(f3.liveCtx()?.homeDir).toBe(
      path.join(home, '.clawboo', 'runtimes', 'hermes', 'hermes-2'),
    )
  })

  it('passes homeDir null for an undeclared (ephemeral one-shot) runtime', async () => {
    const fake = new SeamAdapter('claude-code', FULL_CAPS)
    const f = recordingFactory(fake)
    await runTaskOnRuntime({
      db: createDb(getDbPath()),
      makeAdapter: f.makeAdapter,
      taskId: newTask(),
      assigneeAgentId: 'claude-1',
      disableMemoryAutoInject: true,
    })
    expect(f.liveCtx()).not.toBeNull()
    expect(f.liveCtx()?.homeDir).toBeNull()
  })
})

describe('executor runner — native session resume across dispatches', () => {
  let home: string
  let repo: string
  let prevHome: string | undefined

  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), 'clawboo-resume-home-'))
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

  function newTask(): string {
    return createTask(createDb(getDbPath()), {
      title: 'Long task',
      description: 'spans dispatches',
      status: 'todo',
      teamId: 'team-1',
    }).id
  }

  /** Dispatch 1: pause-for-handoff so the worktree (and its handoff) survives. */
  async function pauseRun(taskId: string, adapter: SeamAdapter): Promise<void> {
    const result = await runTaskOnRuntime({
      db: createDb(getDbPath()),
      makeAdapter: recordingFactory(adapter).makeAdapter,
      taskId,
      assigneeAgentId: 'hermes-1',
      repoPath: repo,
      kind: 'code',
      keepForResume: true,
      disableMemoryAutoInject: true,
    })
    expect(result.ok && result.status).toBe('todo') // released for the next dispatch
  }

  it('persists the codec session id into AGENT_HANDOFF.json and threads it into the next same-runtime dispatch', async () => {
    const taskId = newTask()
    await pauseRun(taskId, new SeamAdapter('hermes', HERMES_SHAPED, ['success'], 'hsess-A'))

    // The worktree's handoff carries the native id.
    const ws = await getTaskWorkspace(taskId)
    expect(ws.ok && ws.resume?.nativeSessionId).toBe('hsess-A')
    expect(ws.ok && ws.resume?.lastRuntime).toBe('hermes')

    // Dispatch 2, SAME runtime → ctx.resume is the persisted native id.
    const second = new SeamAdapter('hermes', HERMES_SHAPED, ['success'], 'hsess-B')
    const f2 = recordingFactory(second)
    const result = await runTaskOnRuntime({
      db: createDb(getDbPath()),
      makeAdapter: f2.makeAdapter,
      taskId,
      assigneeAgentId: 'hermes-1',
      repoPath: repo,
      kind: 'code',
      disableMemoryAutoInject: true,
    })
    expect(result.ok).toBe(true)
    expect(f2.liveCtx()?.resume).toBe('hsess-A')
    expect(second.startResumes[0]).toBe('hsess-A')
  })

  it('a handoff from a DIFFERENT runtime yields ctx.resume = null (cross-runtime rides the prose handoff)', async () => {
    const taskId = newTask()
    await pauseRun(taskId, new SeamAdapter('hermes', HERMES_SHAPED, ['success'], 'hsess-A'))

    const codexShaped: Capabilities = { ...FULL_CAPS, runtimeClass: 'wrapped-oneshot' }
    const other = new SeamAdapter('codex', codexShaped, ['success'], 'thread-X')
    const f = recordingFactory(other)
    await runTaskOnRuntime({
      db: createDb(getDbPath()),
      makeAdapter: f.makeAdapter,
      taskId,
      assigneeAgentId: 'codex-1',
      repoPath: repo,
      kind: 'code',
      disableMemoryAutoInject: true,
    })
    expect(f.liveCtx()?.resume).toBeNull()
    expect(other.startResumes[0]).toBeNull()
  })

  it('a rotation successor starts FRESH: the second start sees ctx.resume = null', async () => {
    const taskId = newTask()
    await pauseRun(taskId, new SeamAdapter('hermes', HERMES_SHAPED, ['success'], 'hsess-A'))

    // Dispatch 2 rotates once (max_turns → success): start #1 resumes the
    // persisted session, the successor must NOT (continuity rides the note).
    const rotating = new SeamAdapter('hermes', HERMES_SHAPED, ['max_turns', 'success'], 'hsess-B')
    const f = recordingFactory(rotating)
    const result = await runTaskOnRuntime({
      db: createDb(getDbPath()),
      makeAdapter: f.makeAdapter,
      taskId,
      assigneeAgentId: 'hermes-1',
      repoPath: repo,
      kind: 'code',
      disableMemoryAutoInject: true,
    })
    expect(result.ok).toBe(true)
    expect(rotating.startCount).toBe(2)
    expect(rotating.startResumes).toEqual(['hsess-A', null])
  })

  it('a codec id equal to the sessionKey is NOT persisted (late-bind contamination filter)', async () => {
    const taskId = newTask()
    await pauseRun(
      taskId,
      new SeamAdapter('hermes', HERMES_SHAPED, ['success'], 'mirror-session-key'),
    )

    const ws = await getTaskWorkspace(taskId)
    expect(ws.ok).toBe(true)
    expect(ws.ok && ws.resume?.nativeSessionId).toBeNull()
  })

  it('a FAILED resume attempt clears the persisted id (no stale-id retry loop) but keeps the prose handoff', async () => {
    const taskId = newTask()
    await pauseRun(taskId, new SeamAdapter('hermes', HERMES_SHAPED, ['success'], 'hsess-stale'))

    // Dispatch 2 attempts the native resume and the run FAILS (e.g. the runtime
    // rejects a pruned/unknown session id with a hard error).
    const failing = new SeamAdapter('hermes', HERMES_SHAPED, ['error'], null)
    const f = recordingFactory(failing)
    const result = await runTaskOnRuntime({
      db: createDb(getDbPath()),
      makeAdapter: f.makeAdapter,
      taskId,
      assigneeAgentId: 'hermes-1',
      repoPath: repo,
      kind: 'code',
      disableMemoryAutoInject: true,
    })
    expect(result.ok && result.status).toBe('todo') // released, retryable
    expect(failing.startResumes[0]).toBe('hsess-stale') // the resume WAS attempted

    // The stale id is cleared; the structured handoff content survives.
    const ws = await getTaskWorkspace(taskId)
    expect(ws.ok && ws.resume?.nativeSessionId).toBeNull()
    expect(ws.ok && ws.resume?.next).toContain('summary:success') // prose state preserved
    expect(ws.ok && (ws.resume?.warnings ?? []).join(' ')).toContain('native session resume failed')

    // Dispatch 3 starts FRESH (no resume) and completes.
    const third = new SeamAdapter('hermes', HERMES_SHAPED, ['success'], 'hsess-new')
    const f3 = recordingFactory(third)
    const ok = await runTaskOnRuntime({
      db: createDb(getDbPath()),
      makeAdapter: f3.makeAdapter,
      taskId,
      assigneeAgentId: 'hermes-1',
      repoPath: repo,
      kind: 'code',
      disableMemoryAutoInject: true,
    })
    expect(ok.ok).toBe(true)
    expect(third.startResumes[0]).toBeNull()
  })
})
