// What a person reads in team chat when a turn outgrew the model's context window. The
// real delivery, with an adapter scripted to send what each runtime's own driver and
// mapper send. Two things can go wrong here: the CLI's own words ("use /clear", which
// Clawboo does not have) committed as the agent's reply, and a session dropped with no
// word to the person.

import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { mapClaudeEvent } from '@clawboo/adapter-claude-code'
import {
  agents,
  claimTask,
  createExecutionProcess,
  createTask,
  getSetting,
  setSetting,
  teams,
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
import { createNudgeQueue } from '@clawboo/team-orchestration'

const dbFault = vi.hoisted(() => ({ failClear: false }))

vi.mock('@clawboo/db', async (importActual) => {
  const actual = await importActual<typeof import('@clawboo/db')>()
  return {
    ...actual,
    setSetting: (...args: Parameters<typeof actual.setSetting>) => {
      if (dbFault.failClear && args[2] === '') throw new Error('SQLITE_BUSY: database is locked')
      return actual.setSetting(...args)
    },
  }
})

/** What the next run sends, and the session id its codec reports. */
const scripted = vi.hoisted(() => ({ events: [] as unknown[], sid: 'sid-new' }))

vi.mock('../../runtimes', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../runtimes')>()
  return {
    ...real,
    adapterFactoryFor: (id: Parameters<typeof real.adapterFactoryFor>[0]) => {
      const caps = real.adapterFactoryFor(id)({}).capabilities()
      return (): RuntimeAdapter =>
        new ScriptedAdapter(id, caps, scripted.events as RuntimeEvent[], scripted.sid)
    },
  }
})

const { getDb, getDbPath, resetDb } = await import('../../db')
const { translateClaudeMessage } = await import('../../runtimes/claudeCodeDriver')
const { nativeTeamSessionSettingKey, taskSessionSettingKey } = await import('../nativeTeamSession')
const { createServerDeliver } = await import('../serverDeliver')

const TEAM = 'T'
const THRASHING =
  'Autocompact is thrashing: the context refilled to the limit within 3 turns of the previous compact, 3 times in a row. A file being read or a tool output is likely too large for the context window. Try reading in smaller chunks, or use /clear to start fresh.'
const DROPPED = /outgrew the model's context window, so it starts fresh on its next turn/
const TOO_LARGE = /turn did not fit in the model's context window/

class ScriptedAdapter implements RuntimeAdapter {
  readonly participantKind = 'agent' as const
  constructor(
    readonly id: string,
    private readonly caps: Capabilities,
    private readonly script: RuntimeEvent[],
    private readonly sid: string,
  ) {}
  capabilities(): Capabilities {
    return this.caps
  }
  async health(): Promise<{ ok: boolean }> {
    return { ok: true }
  }
  async start(_t: TaskHandle, opts: StartOpts): Promise<RunHandle> {
    return { adapterId: this.id, sessionKey: opts.sessionKey, runId: null }
  }
  readonly sessionCodec = {
    serialize: async (): Promise<string> => JSON.stringify({ sessionId: this.sid }),
    restore: async (): Promise<RunHandle> => ({ adapterId: this.id, sessionKey: '', runId: null }),
  }
  events(run: RunHandle): AsyncIterable<RuntimeEvent> {
    const script = this.script
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

/** The real path of a Claude Code result: its driver's translation, then its mapper. */
function claudeEnding(terminalReason: string, result: string, streamed = ''): RuntimeEvent[] {
  const [native] = translateClaudeMessage(
    { type: 'result', subtype: 'success', is_error: true, terminal_reason: terminalReason, result },
    { apiError: 'invalid_request' },
  )
  const zero = (): number => 0
  const mapped = mapClaudeEvent(native!, { runId: null, sessionId: null }, zero, zero, streamed)
  return streamed
    ? [{ kind: 'text-delta', text: streamed, channel: 'assistant' } as RuntimeEvent, ...mapped]
    : mapped
}

const FATAL_OVERFLOW: RuntimeEvent[] = [
  {
    kind: 'error',
    code: 'context_overflow',
    message: 'ran out of room',
    fatal: true,
  } as RuntimeEvent,
  { kind: 'done', reason: 'error', summary: '' } as RuntimeEvent,
]

describe('team chat: a turn that outgrew the context window', () => {
  let home: string
  let prevHome: string | undefined
  let prevClawbooHome: string | undefined
  let db: ClawbooDb
  let turns: string[]
  let metas: string[]
  /** What the engine was handed, which is where the board's failure detail comes from. */
  let engineEvents: RuntimeEvent[]

  beforeEach(async () => {
    dbFault.failClear = false
    engineEvents = []
    home = await mkdtemp(path.join(os.tmpdir(), 'clawboo-team-overflow-'))
    await mkdir(path.join(home, '.clawboo'), { recursive: true })
    prevHome = process.env['HOME']
    prevClawbooHome = process.env['CLAWBOO_HOME']
    process.env['HOME'] = home
    // `getDb()` follows CLAWBOO_HOME before $HOME: sandbox both.
    process.env['CLAWBOO_HOME'] = path.join(home, '.clawboo')
    expect(getDbPath().startsWith(home)).toBe(true)
    db = getDb()
    turns = []
    metas = []
    const now = Date.now()
    db.insert(teams)
      .values({ id: TEAM, name: TEAM, icon: 'T', color: '#000', createdAt: now, updatedAt: now })
      .run()
  })
  afterEach(async () => {
    resetDb()
    if (prevHome === undefined) delete process.env['HOME']
    else process.env['HOME'] = prevHome
    if (prevClawbooHome === undefined) delete process.env['CLAWBOO_HOME']
    else process.env['CLAWBOO_HOME'] = prevClawbooHome
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })

  async function leaderTurn(
    runtime: string,
    script: RuntimeEvent[],
    sid = 'sid-new',
  ): Promise<void> {
    const now = Date.now()
    db.insert(agents)
      .values({
        id: 'lead',
        name: 'Ada',
        gatewayId: 'lead',
        runtime,
        teamId: TEAM,
        createdAt: now,
        updatedAt: now,
      })
      .run()
    scripted.events = script
    scripted.sid = sid
    let ended = false
    const deliver = createServerDeliver({
      db,
      teamId: TEAM,
      mcpBaseUrl: 'http://127.0.0.1:1',
      nudge: createNudgeQueue(),
      abortMap: new Map(),
      onEvent: async (_sk, ev) => {
        engineEvents.push(ev)
        if (ev.kind === 'done' || (ev.kind === 'error' && ev.fatal)) ended = true
      },
      onSessionClosed: async () => {
        ended = true
      },
      taskForSession: () => null,
      execForSession: () => null,
      stopGen: () => 0,
      leaderAgentId: () => 'lead',
      persistTurn: (_sk, text) => {
        turns.push(text)
        return true
      },
      persistMeta: (_sk, text) => {
        metas.push(text)
        return true
      },
    })
    await deliver(`agent:lead:team:${TEAM}`, 'lead', 'Summarize everything.', { kind: 'human' })
    await vi.waitFor(() => expect(ended).toBe(true), { timeout: 5000 })
  }

  it.each([
    ['rapid_refill_breaker', THRASHING],
    ['blocking_limit', 'Prompt is too long'],
    ['prompt_too_long', 'Prompt is too long'],
  ])("%s: never commits the CLI's own words as the agent's reply", async (reason, text) => {
    await leaderTurn('claude-code', claudeEnding(reason, text))
    expect(turns).toEqual([])
    expect(metas).toHaveLength(1)
    // This leader starts every turn without the earlier conversation: it lost nothing.
    expect(metas[0]).toMatch(TOO_LARGE)
    expect(metas[0]).toContain('Ada')
    expect(metas[0]).not.toContain('/clear')
  })

  it('keeps what the agent really wrote, and the notice follows it', async () => {
    await leaderTurn(
      'claude-code',
      claudeEnding('rapid_refill_breaker', THRASHING, 'Reading the four files first.'),
    )
    expect(turns).toEqual(['Reading the four files first.'])
    expect(metas).toHaveLength(1)
    expect(metas[0]).toMatch(TOO_LARGE)
  })

  it('a fatal overflow says the session is gone, once, instead of a failure notice', async () => {
    setSetting(db, nativeTeamSessionSettingKey('lead', TEAM), 'sid-old')
    await leaderTurn('codex', FATAL_OVERFLOW)
    expect(getSetting(db, nativeTeamSessionSettingKey('lead', TEAM)) || null).toBeNull()
    expect(turns).toEqual([])
    expect(metas).toHaveLength(1)
    expect(metas[0]).toMatch(DROPPED)
    expect(metas[0]).not.toMatch(/context-window setting/)
  })

  it('a first turn that overflows does not say it lost a session', async () => {
    await leaderTurn('codex', FATAL_OVERFLOW)
    expect(metas).toHaveLength(1)
    expect(metas[0]).toMatch(TOO_LARGE)
    expect(metas[0]).not.toMatch(DROPPED)
  })

  it("a failed clear is said plainly: the room is not told it starts fresh when it won't", async () => {
    const key = nativeTeamSessionSettingKey('lead', TEAM)
    setSetting(db, key, 'sid-old')
    dbFault.failClear = true
    await leaderTurn('codex', FATAL_OVERFLOW)
    dbFault.failClear = false
    expect(getSetting(db, key)).toBe('sid-old')
    expect(metas).toHaveLength(1)
    expect(metas[0]).toMatch(/could not clear its session/)
    expect(metas[0]).not.toMatch(DROPPED)
  })

  it.each([
    ['rate_limit', 'Rate limit: too many tokens'],
    ['overloaded', 'the model is overloaded'],
  ])('a resumed leader turn that hit %s keeps its session', async (code, message) => {
    const key = nativeTeamSessionSettingKey('lead', TEAM)
    setSetting(db, key, 'sid-old')
    await leaderTurn(
      'codex',
      [
        { kind: 'error', code, message, fatal: true } as RuntimeEvent,
        { kind: 'done', reason: 'error', summary: '' } as RuntimeEvent,
      ],
      'sid-old',
    )
    expect(getSetting(db, key)).toBe('sid-old')
    expect(metas).toEqual([`The run failed: ${message}`])
  })

  it('a resumed leader turn that failed any other way still clears', async () => {
    const key = nativeTeamSessionSettingKey('lead', TEAM)
    setSetting(db, key, 'sid-old')
    await leaderTurn(
      'codex',
      [
        { kind: 'error', code: null, message: 'no such thread', fatal: true } as RuntimeEvent,
        { kind: 'done', reason: 'error', summary: '' } as RuntimeEvent,
      ],
      'sid-old',
    )
    expect(getSetting(db, key) || null).toBeNull()
  })

  it("a resumed task run that hit a rate limit keeps its task's session", async () => {
    const now = Date.now()
    db.insert(agents)
      .values({
        id: 'worker',
        name: 'Wes',
        gatewayId: 'worker',
        runtime: 'codex',
        teamId: TEAM,
        createdAt: now,
        updatedAt: now,
      })
      .run()
    const task = createTask(db, { title: 'Port it', description: 'Port it.', teamId: TEAM })
    expect(claimTask(db, task.id, 'worker').ok).toBe(true)
    const key = taskSessionSettingKey('worker', TEAM, task.id)
    const run = async (events: RuntimeEvent[], sid: string): Promise<void> => {
      scripted.events = events
      scripted.sid = sid
      const exec = createExecutionProcess(db, { taskId: task.id, executorType: 'codex' })
      let ended = false
      const deliver = createServerDeliver({
        db,
        teamId: TEAM,
        mcpBaseUrl: 'http://127.0.0.1:1',
        nudge: createNudgeQueue(),
        abortMap: new Map(),
        onEvent: async (_sk, ev) => {
          if (ev.kind === 'done' || (ev.kind === 'error' && ev.fatal)) ended = true
        },
        onSessionClosed: async () => {
          ended = true
        },
        taskForSession: () => task.id,
        execForSession: () => exec.id,
        stopGen: () => 0,
        leaderAgentId: () => 'lead',
        persistTurn: () => true,
        persistMeta: () => true,
      })
      await deliver(`agent:worker:team:${TEAM}`, 'worker', 'Port it.', {
        kind: 'delegation',
        fromAgentId: 'lead',
      })
      await vi.waitFor(() => expect(ended).toBe(true), { timeout: 5000 })
    }
    await run([{ kind: 'done', reason: 'success', summary: 'ok' } as RuntimeEvent], 'sid-1')
    expect(getSetting(db, key)).toContain('sid-1')
    await run(
      [
        { kind: 'error', code: 'rate_limit', message: 'slow down', fatal: true } as RuntimeEvent,
        { kind: 'done', reason: 'error', summary: '' } as RuntimeEvent,
      ],
      'sid-1',
    )
    expect(getSetting(db, key)).toContain('sid-1')
  })

  it("the board gets Claude Code's reason as failure detail, and the chat does not", async () => {
    await leaderTurn(
      'claude-code',
      claudeEnding('rapid_refill_breaker', THRASHING, 'Reading the four files first.'),
    )
    const done = engineEvents.find((e) => e.kind === 'done') as { summary?: string }
    expect(done.summary).toContain('A file being read or a tool output is likely too large')
    expect(done.summary).toContain('Reading the four files first.')
    expect(turns).toEqual(['Reading the four files first.'])
  })

  it('a plain turn limit gives the board nothing new', async () => {
    await leaderTurn('claude-code', [
      { kind: 'done', reason: 'max_turns', summary: 'so far' } as RuntimeEvent,
    ])
    expect(engineEvents.find((e) => e.kind === 'done')).toMatchObject({ summary: 'so far' })
  })

  it('a run that reported an overflow and then finished keeps its session and says nothing', async () => {
    await leaderTurn(
      'codex',
      [
        { kind: 'error', code: 'context_overflow', message: 'x', fatal: false } as RuntimeEvent,
        { kind: 'done', reason: 'success', summary: 'all done' } as RuntimeEvent,
      ],
      'sid-kept',
    )
    expect(getSetting(db, nativeTeamSessionSettingKey('lead', TEAM))).toBe('sid-kept')
    expect(turns).toEqual(['all done'])
    expect(metas).toEqual([])
  })
})
