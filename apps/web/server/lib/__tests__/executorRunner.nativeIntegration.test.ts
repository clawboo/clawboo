// The native runtime through the REAL executor runner — a scripted provider
// client stands in for the SDK, everything else is real: sqlite board, temp
// git worktree, the cwd-jailed file tools mutating it, the verification gate,
// governance budgets, obs, the per-identity home, and AGENT_HANDOFF.json
// carrying the native session id. Plus the budget kill-switch aborting a
// native conversation mid-stream, and a three-runtime coexistence pass on one
// board (native + a hermes-shaped fake + an openclaw chat-path claim).

import { execFile } from 'node:child_process'
import { existsSync, readdirSync, writeFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import {
  chatMessages,
  claimTask,
  createDb,
  createTask,
  getBudget,
  getComments,
  getTask,
  getTaskVerification,
  listEvents,
  listGovernanceAudit,
  setBudgetLimit,
  updateStatus,
} from '@clawboo/db'
import { NativeAdapter } from '@clawboo/adapter-native'
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

import { getDbPath } from '../db'
import { runTaskOnRuntime } from '../executorRunner'
import type { RuntimeRunContext } from '../runtimes'
import { createNativeDriver } from '../runtimes/native'
import type { ProviderStreamEvent } from '../runtimes/native/providers/types'
import type { RoutedProviderClient } from '../runtimes/native/routeCall'
import { getTaskWorkspace } from '../worktrees'

const execFileAsync = promisify(execFile)
async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync('git', args, { cwd, windowsHide: true })
}
async function initRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'clawboo-native-int-repo-'))
  await git(dir, ['init', '-b', 'main'])
  await git(dir, ['config', 'user.name', 'test'])
  await git(dir, ['config', 'user.email', 'test@example.com'])
  await writeFile(path.join(dir, 'README.md'), '# repo\n')
  await git(dir, ['add', '-A'])
  await git(dir, ['commit', '--no-verify', '-m', 'init'])
  return dir
}

/** Scripted RoutedProviderClient — each entry is one turn's stream;
 *  'HANG_UNTIL_ABORT' waits for the abort signal then throws. */
function scriptedClient(
  script: Array<ProviderStreamEvent[] | 'HANG_UNTIL_ABORT'>,
): RoutedProviderClient {
  let turn = 0
  return {
    activeModel: () => 'claude-haiku-4-5',
    activeProvider: () => 'anthropic',
    setModel: () => {},
    async *streamTurn(p) {
      const entry = script[Math.min(turn, script.length - 1)]
      turn += 1
      if (entry === 'HANG_UNTIL_ABORT') {
        await new Promise<void>((resolve) => {
          if (p.signal.aborted) resolve()
          else p.signal.addEventListener('abort', () => resolve(), { once: true })
        })
        throw new Error('aborted by signal')
      }
      for (const ev of entry ?? []) yield ev
    },
  }
}

const usage = (input: number, output: number): ProviderStreamEvent => ({
  type: 'usage',
  inputTokens: input,
  outputTokens: output,
})

/** The native adapter factory the runner consumes — real driver, scripted
 *  provider, no MCP (the bridge has its own test; this one exercises the file
 *  tools against the real worktree). */
function makeNativeFactory(client: RoutedProviderClient) {
  return (ctx: RuntimeRunContext): RuntimeAdapter =>
    new NativeAdapter(
      (opts: StartOpts) =>
        createNativeDriver(opts, ctx, { client, mcp: null, db: createDb(getDbPath()) }),
      async () => ({ ok: true }),
    )
}

describe('executor runner — native runtime integration', () => {
  let repo: string
  let home: string
  let prevHome: string | undefined

  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), 'clawboo-native-int-home-'))
    await mkdir(path.join(home, '.clawboo'), { recursive: true })
    prevHome = process.env['HOME']
    process.env['HOME'] = home
    process.env['CLAWBOO_HOME'] = path.join(home, '.clawboo')
    repo = await initRepo()
  })
  afterEach(async () => {
    if (prevHome === undefined) delete process.env['HOME']
    else process.env['HOME'] = prevHome
    delete process.env['CLAWBOO_HOME']
    await rm(home, { recursive: true, force: true }).catch(() => {})
    await rm(repo, { recursive: true, force: true }).catch(() => {})
  })

  function newCodeTask(title = 'Add GREETING.md'): string {
    return createTask(createDb(getDbPath()), {
      title,
      description: 'write it',
      status: 'todo',
      teamId: 'team-n',
    }).id
  }

  it('happy path: claim → file-tool worktree mutation → verify gate → done + handoff nativeSessionId', async () => {
    const taskId = newCodeTask()
    setBudgetLimit(createDb(getDbPath()), {
      scope: 'agent',
      scopeId: 'native-spec-1',
      limitUsdCents: 10_000,
    })

    const client = scriptedClient([
      [
        {
          type: 'tool-call',
          id: 'tc1',
          name: 'write_file',
          input: { path: 'GREETING.md', content: 'hello, team\n' },
        },
        {
          type: 'tool-call',
          id: 'tc2',
          name: 'write_file',
          input: {
            path: 'init.sh',
            content: "#!/usr/bin/env bash\nVERIFY_CMD='test -f GREETING.md'\n",
          },
        },
        usage(20_000, 2_000), // ≈3¢ on haiku pricing — big enough to land ≥1 recorded cent
      ],
      [
        { type: 'text', delta: 'Wrote the greeting file and set the verify command.' },
        usage(25_000, 1_000),
      ],
    ])

    const result = await runTaskOnRuntime({
      db: createDb(getDbPath()),
      makeAdapter: makeNativeFactory(client),
      taskId,
      assigneeAgentId: 'native-spec-1',
      repoPath: repo,
      kind: 'code',
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.runtimeId).toBe('clawboo-native')
    expect(result.usedWorktree).toBe(true)
    expect(result.doneReason).toBe('success')
    expect(result.status).toBe('done')
    expect(result.costUsd).toBeGreaterThan(0) // real priced turns, cumulative

    const db = createDb(getDbPath())
    expect(getTask(db, taskId)?.status).toBe('done')
    expect(getComments(db, taskId).some((c) => c.body.includes('Wrote the greeting'))).toBe(true)
    expect(getTaskVerification(db, taskId)?.status).toBe('pass')
    expect(getBudget(db, 'agent', 'native-spec-1')?.spentUsdCents).toBeGreaterThan(0)

    // The handoff carries the native session id — the same-runtime resume handle.
    const ws = await getTaskWorkspace(taskId)
    expect(ws.ok).toBe(true)
    if (ws.ok) expect(ws.resume?.nativeSessionId).toMatch(/^native-/)

    // The per-identity home holds the persisted conversation transcript.
    const sessionsDir = path.join(
      home,
      '.clawboo',
      'runtimes',
      'clawboo-native',
      'native-spec-1',
      'sessions',
    )
    expect(existsSync(sessionsDir)).toBe(true)
    expect(readdirSync(sessionsDir).some((f) => f.endsWith('.json'))).toBe(true)

    // The leader-chat narration entry landed in chat history.
    const chatRows = db
      .select()
      .from(chatMessages)
      .where(eq(chatMessages.sessionKey, 'agent:native-spec-1:native'))
      .all()
    expect(chatRows.length).toBeGreaterThan(0)

    // Obs: the run's trace carries the tool round + per-turn cost + terminal.
    const trace = listEvents(db, { taskId, limit: 1000 })
    const kinds = trace.map((e) => e.kind)
    for (const k of [
      'execution_started',
      'tool_call',
      'tool_result',
      'cost',
      'execution_completed',
    ]) {
      expect(kinds).toContain(k)
    }
  })

  it('budget kill-switch aborts a native conversation mid-stream and releases the task', async () => {
    const taskId = newCodeTask('Expensive task')
    setBudgetLimit(createDb(getDbPath()), {
      scope: 'agent',
      scopeId: 'native-spend-1',
      limitUsdCents: 1,
      mode: 'cap',
    })

    const client = scriptedClient([
      // One big priced turn (≈ 30¢ on haiku pricing) blows the 1¢ cap…
      [{ type: 'tool-call', id: 'tc1', name: 'list_files', input: {} }, usage(300_000, 1_000)],
      // …then the conversation hangs until the runner's abort lands.
      'HANG_UNTIL_ABORT',
    ])

    const result = await runTaskOnRuntime({
      db: createDb(getDbPath()),
      makeAdapter: makeNativeFactory(client),
      taskId,
      assigneeAgentId: 'native-spend-1',
      repoPath: repo,
      kind: 'code',
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.doneReason).toBe('aborted')
    expect(result.status).toBe('todo') // released — clean resumable state
    expect(result.summary).toBe('auto-paused (budget)')

    const db = createDb(getDbPath())
    expect(getTask(db, taskId)?.status).toBe('todo')
    expect(listGovernanceAudit(db, { eventType: 'budget' })).toHaveLength(1)
    expect(getTaskVerification(db, taskId) ?? null).toBeNull() // verify never ran
  })

  it('coexistence: native + hermes-shaped + openclaw tasks complete on ONE board', async () => {
    const db = createDb(getDbPath())

    // 1) Native (real driver + scripted provider).
    const nativeTask = newCodeTask('Native leg')
    const nativeResult = await runTaskOnRuntime({
      db: createDb(getDbPath()),
      makeAdapter: makeNativeFactory(
        scriptedClient([
          [
            {
              type: 'tool-call',
              id: 'tc1',
              name: 'write_file',
              input: { path: 'native.txt', content: 'native\n' },
            },
            {
              type: 'tool-call',
              id: 'tc2',
              name: 'write_file',
              input: {
                path: 'init.sh',
                content: "#!/usr/bin/env bash\nVERIFY_CMD='test -f native.txt'\n",
              },
            },
            usage(100, 10),
          ],
          [{ type: 'text', delta: 'native leg done' }, usage(120, 5)],
        ]),
      ),
      taskId: nativeTask,
      assigneeAgentId: 'native-coex',
      repoPath: repo,
      kind: 'code',
    })
    expect(nativeResult.ok && nativeResult.status === 'done').toBe(true)

    // 2) A hermes-shaped scripted adapter (one-shot worker) on a second task.
    const hermesTask = newCodeTask('Hermes leg')
    const FULL_CAPS: Capabilities = {
      streaming: false,
      mcp: true,
      worktrees: true,
      resume: true,
      toolApproval: false,
      models: [],
    }
    class HermesShaped implements RuntimeAdapter {
      readonly id = 'hermes'
      readonly participantKind = 'agent' as const
      capabilities(): Capabilities {
        return FULL_CAPS
      }
      async health() {
        return { ok: true }
      }
      async start(_t: TaskHandle, opts: StartOpts): Promise<RunHandle> {
        return { adapterId: this.id, sessionKey: opts.sessionKey, runId: 'h1' }
      }
      events(): AsyncIterable<RuntimeEvent> {
        return (async function* () {
          yield {
            runId: 'h1',
            sessionId: 'h1',
            ts: 1,
            seq: 1,
            kind: 'done',
            reason: 'success',
            summary: 'hermes leg done',
          } as RuntimeEvent
        })()
      }
      async abort() {}
      async setModel() {}
      async writeContext() {}
    }
    const hermesResult = await runTaskOnRuntime({
      db: createDb(getDbPath()),
      makeAdapter: (ctx: RuntimeRunContext) => {
        if (ctx.cwd) {
          writeFileSync(path.join(ctx.cwd, 'hermes.txt'), 'hermes\n', 'utf8')
          writeFileSync(
            path.join(ctx.cwd, 'init.sh'),
            "#!/usr/bin/env bash\nVERIFY_CMD='test -f hermes.txt'\n",
            'utf8',
          )
        }
        return new HermesShaped()
      },
      taskId: hermesTask,
      assigneeAgentId: 'hermes-coex',
      repoPath: repo,
      kind: 'code',
    })
    expect(hermesResult.ok && hermesResult.status === 'done').toBe(true)

    // 3) An OpenClaw agent completes a third task via the board path (the chat
    //    orchestration's effect — OpenClaw runs ride the live Gateway, not the
    //    one-shot runner).
    const ocTask = newCodeTask('OpenClaw leg')
    expect(claimTask(db, ocTask, 'openclaw-coex', 'openclaw').ok).toBe(true)
    updateStatus(db, ocTask, 'done')

    // One board, three runtimes, no cross-contamination.
    const rows = [getTask(db, nativeTask), getTask(db, hermesTask), getTask(db, ocTask)]
    expect(rows.map((t) => t?.status)).toEqual(['done', 'done', 'done'])
    expect(rows.map((t) => t?.assigneeRuntime)).toEqual(['clawboo-native', 'hermes', 'openclaw'])
    expect(rows.map((t) => t?.assigneeAgentId)).toEqual([
      'native-coex',
      'hermes-coex',
      'openclaw-coex',
    ])
  })
})
