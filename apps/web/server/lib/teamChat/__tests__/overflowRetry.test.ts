// Retry rescues a Claude Code board task that outgrew its context. Wires the real
// engine, the real run primitive and the real board as codexLeaderCascade does,
// plus the real Retry route, with a scripted adapter sending the event pair
// Claude Code's mapper sends for an overflow: a non-fatal `context_overflow`
// error, then `done: max_turns`.
//
// Before: `max_turns` counts as a sound end, so the overflowed session's id was
// written back as the task's resume pointer, and every Retry resumed it. Claude
// Code reports an overflow only after its own compaction failed, so the resumed
// run overflowed again, and the task blocked again, on every Retry.

import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { mapClaudeEvent } from '@clawboo/adapter-claude-code'
import { encodeHumanAssignment } from '@clawboo/board-core'
import { agents, createTask, getComments, getSetting, getTask, teams } from '@clawboo/db'
import type {
  Capabilities,
  RunHandle,
  RuntimeAdapter,
  RuntimeEvent,
  StartOpts,
  TaskHandle,
} from '@clawboo/executor'
import {
  agentIdFromSessionKey,
  buildTeamSessionKey,
  createBoardOrchestrator,
  createNudgeQueue,
  type BoardOrchestrator,
} from '@clawboo/team-orchestration'
import type { Request, Response } from 'express'

import { settle } from './settleCascade'

const engineRef = vi.hoisted(() => ({ current: null as BoardOrchestrator | null }))
// The Retry route hands the task to the team's orchestrator; here, the engine
// this test built.
vi.mock('../boardDispatch', () => ({
  requestTaskDispatch: (_teamId: string, taskId: string) => {
    void engineRef.current!.dispatchTask(taskId)
  },
}))

const { getDb, getDbPath, resetDb } = await import('../../db')
const { parseTaskSessionPointer, taskSessionSettingKey } = await import('../nativeTeamSession')
const { createServerBoardClient } = await import('../serverBoardClient')
const { createServerDeliver } = await import('../serverDeliver')
const { boardRetryPOST } = await import('../../../api/board')

const TEAM = 'T'
const LEAD = 'lead'
const WORKER = 'cc-worker'

const CLAUDE_CODE_CAPS: Capabilities = {
  streaming: true,
  mcp: true,
  worktrees: true,
  resume: true,
  toolApproval: true,
  models: [],
  runtimeClass: 'wrapped-oneshot',
}

/** Each start() consumes the next script; the codec reports a new session per run. */
class ScriptedClaudeCode implements RuntimeAdapter {
  readonly participantKind = 'agent' as const
  readonly id = 'claude-code'
  readonly startOpts: StartOpts[] = []
  private turn = 0
  constructor(private readonly scripts: RuntimeEvent[][]) {}
  capabilities(): Capabilities {
    return CLAUDE_CODE_CAPS
  }
  async health(): Promise<{ ok: boolean }> {
    return { ok: true }
  }
  async start(_t: TaskHandle, opts: StartOpts): Promise<RunHandle> {
    this.startOpts.push(opts)
    this.turn += 1
    return { adapterId: this.id, sessionKey: opts.sessionKey, runId: null }
  }
  readonly sessionCodec = {
    serialize: async (): Promise<string> => JSON.stringify({ sessionId: `cc-sid-${this.turn}` }),
    restore: async (): Promise<RunHandle> => ({ adapterId: this.id, sessionKey: '', runId: null }),
  }
  events(run: RunHandle): AsyncIterable<RuntimeEvent> {
    const script = this.scripts.shift() ?? []
    const sk = run.sessionKey
    return (async function* () {
      let seq = 0
      for (const ev of script) {
        seq += 1
        yield { ...ev, runId: sk, sessionId: sk, ts: seq, seq } as RuntimeEvent
      }
    })()
  }
  async abort(): Promise<void> {}
  async setModel(): Promise<void> {}
  async writeContext(): Promise<void> {}
}

/** What Claude Code's own mapper sends for a result whose terminal reason is
 *  `prompt_too_long` (the driver sets `contextFull`): a cost event, a non-fatal
 *  `context_overflow` error, then `done: max_turns` with the reply so far. */
const OVERFLOW: RuntimeEvent[] = mapClaudeEvent(
  {
    type: 'result',
    ok: false,
    contextFull: true,
    summary: 'Prompt is too long',
    errorMessage: 'Prompt is too long',
    costUsd: 0.01,
    usage: { inputTokens: 190_000, outputTokens: 400 },
  },
  { runId: null, sessionId: null },
  () => 0,
  () => 0,
  'Reading the four reader files first.',
)

// The dashboard's own page: a person's Retry.
const req = (over: Partial<Request> = {}): Request =>
  ({
    params: {},
    query: {},
    body: {},
    headers: { 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors' },
    app: { locals: {} },
    ...over,
  }) as Request
function mockRes(): { res: Response; statusCode: () => number } {
  let code = 200
  const res = {
    status(c: number) {
      code = c
      return this
    },
    json() {
      return this
    },
  } as unknown as Response
  return { res, statusCode: () => code }
}

describe('Retry after a Claude Code context overflow', () => {
  let home: string
  let prevHome: string | undefined
  let prevClawbooHome: string | undefined

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval'] })
    home = await mkdtemp(path.join(os.tmpdir(), 'clawboo-overflow-retry-'))
    await mkdir(path.join(home, '.clawboo'), { recursive: true })
    prevHome = process.env['HOME']
    prevClawbooHome = process.env['CLAWBOO_HOME']
    process.env['HOME'] = home
    // `getDb()` follows CLAWBOO_HOME before $HOME: sandbox both.
    process.env['CLAWBOO_HOME'] = path.join(home, '.clawboo')
    expect(getDbPath().startsWith(home)).toBe(true)
    const db = getDb()
    const now = Date.now()
    db.insert(teams)
      .values({
        id: TEAM,
        name: 'Team T',
        icon: 'T',
        color: '#000',
        leaderAgentId: LEAD,
        createdAt: now,
        updatedAt: now,
      })
      .run()
    db.insert(agents)
      .values(
        [
          { id: LEAD, name: 'Lead', gatewayId: LEAD, runtime: 'claude-code', teamId: TEAM },
          { id: WORKER, name: 'Worker', gatewayId: WORKER, runtime: 'claude-code', teamId: TEAM },
        ].map((a) => ({ ...a, createdAt: now, updatedAt: now })),
      )
      .run()
  })
  afterEach(async () => {
    engineRef.current = null
    // Close BEFORE removing the dir: Windows refuses to remove a directory that
    // still holds an open file.
    resetDb()
    vi.useRealTimers()
    if (prevHome === undefined) delete process.env['HOME']
    else process.env['HOME'] = prevHome
    if (prevClawbooHome === undefined) delete process.env['CLAWBOO_HOME']
    else process.env['CLAWBOO_HOME'] = prevClawbooHome
    await rm(home, { recursive: true, force: true })
  })

  it('the task blocks with no resume pointer left, and Retry runs it in a new session with a first run’s ticket block', async () => {
    expect(OVERFLOW.map((e) => e.kind)).toEqual(['cost', 'error', 'done'])
    const db = getDb()
    const worker = new ScriptedClaudeCode([
      OVERFLOW,
      [{ kind: 'done', reason: 'success', summary: 'parser written' } as RuntimeEvent],
    ])
    const deliver = createServerDeliver({
      db,
      teamId: TEAM,
      mcpBaseUrl: null,
      nudge: createNudgeQueue(),
      abortMap: new Map(),
      onEvent: (sk, ev, run) => engineRef.current!.onEvent(sk, ev, run),
      onSessionClosed: (sk, run) => engineRef.current!.onSessionClosed(sk, run),
      taskForSession: (sk) => engineRef.current!.taskForSession(sk),
      execForSession: (sk) => engineRef.current!.execForSession(sk),
      stopGen: () => 0,
      leaderAgentId: () => LEAD,
      makeAdapterForAgent: (agentId) => (agentId === WORKER ? worker : null),
    })
    engineRef.current = createBoardOrchestrator({
      teamId: TEAM,
      board: createServerBoardClient(db),
      known: () => [
        { id: LEAD, name: 'Lead' },
        { id: WORKER, name: 'Worker' },
      ],
      leaderAgentId: () => LEAD,
      sessionKeyForAgent: (id) => buildTeamSessionKey(id, TEAM),
      agentIdForSession: (sk) => agentIdFromSessionKey(sk),
      deliver,
      stopGen: () => 0,
    })

    const task = createTask(db, {
      title: 'Port the parser',
      description: 'Move the CSV parser to the new reader.',
      teamId: TEAM,
      sourceDelegationId: encodeHumanAssignment(WORKER, 'n1'),
    })
    const pointerKey = taskSessionSettingKey(WORKER, TEAM, task.id)

    // The first run overflows: the engine blocks the task as out of room.
    await engineRef.current.dispatchTask(task.id)
    await settle(() => getTask(db, task.id)?.status === 'blocked', 'the overflow block')
    expect(
      getComments(db, task.id)
        .map((c) => c.body)
        .join('\n'),
    ).toContain('Ran out of room before finishing')
    // The overflowed session is not left for the next run to resume.
    expect(parseTaskSessionPointer(getSetting(db, pointerKey))).toBeNull()

    // A person presses Retry.
    const r = mockRes()
    boardRetryPOST(req({ params: { taskId: task.id } }), r.res)
    expect(r.statusCode()).toBe(202)
    await settle(() => getTask(db, task.id)?.status === 'done', 'the retried run')

    expect(worker.startOpts).toHaveLength(2)
    const retried = worker.startOpts[1]!
    expect(retried.message).toContain('Move the CSV parser to the new reader.')
    // A fresh run's block: the newest comments on the task, not only the ones
    // since a last run.
    const block = retried.context ?? ''
    expect(block).toContain('[Your task on the board]')
    expect(block).toContain('Retry requested.')
    expect(block).not.toContain('You are continuing this task in the same session')
    expect(block).not.toContain('since your last run')
  })
})
