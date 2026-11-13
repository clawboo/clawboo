// serverDeliver's PRODUCTION adapter path (no `makeAdapterForAgent` seam): the run
// context it builds for each runtime. Claude Code, Codex, Hermes and Clawboo Native
// team-chat runs get the team's working folder as `cwd`, and a run that holds a
// task gets that task's own folder inside it, never the server's own working
// directory. The driver factory is mocked (a file-global vi.mock,
// hence its own file) to capture the ctx; the capabilities still come from the
// real adapters, so the home resolution matches production.

import { realpathSync } from 'node:fs'
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { agents, createTask, teams, type ClawbooDb } from '@clawboo/db'
import type { Capabilities, RunHandle, RuntimeAdapter, RuntimeEvent } from '@clawboo/executor'
import { createNudgeQueue, HUMAN_TURN } from '@clawboo/team-orchestration'

import { getDb, resetDb } from '../../db'
import { TASK_FOLDER_NOTE } from '../../runtimes/teamWorkdir'
import type { RuntimeRunContext } from '../../runtimes/types'
import { createServerDeliver } from '../serverDeliver'

const captured = vi.hoisted(() => [] as Array<{ runtime: string; ctx: RuntimeRunContext }>)
const contexts = vi.hoisted(() => [] as string[])

vi.mock('../../runtimes', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../runtimes')>()
  return {
    ...real,
    adapterFactoryFor: (id: Parameters<typeof real.adapterFactoryFor>[0]) => {
      const caps = real.adapterFactoryFor(id)({}).capabilities()
      return (ctx: RuntimeRunContext): RuntimeAdapter => {
        // The empty-ctx call is serverDeliver's capability probe, not the run.
        if (ctx.memoryScope) captured.push({ runtime: id, ctx })
        return doneAdapter(id, caps)
      }
    },
  }
})

function doneAdapter(id: string, caps: Capabilities): RuntimeAdapter {
  return {
    id: id as RuntimeAdapter['id'],
    participantKind: 'agent',
    capabilities: () => caps,
    health: async () => ({ ok: true }),
    start: async (_task, opts): Promise<RunHandle> => {
      contexts.push(opts.context ?? '')
      return { adapterId: id, sessionKey: opts.sessionKey, runId: null }
    },
    events: async function* (run: RunHandle): AsyncIterable<RuntimeEvent> {
      const sk = run.sessionKey
      yield {
        runId: sk,
        sessionId: sk,
        ts: 1,
        seq: 1,
        kind: 'done',
        reason: 'success',
        summary: 'ok',
      } as RuntimeEvent
    },
    abort: async () => {},
    setModel: async () => {},
    writeContext: async () => {},
  }
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))
const isWindows = process.platform === 'win32'

describe('serverDeliver: the team working folder for coding runtimes', () => {
  let home: string
  let prevHome: string | undefined
  let prevClawbooHome: string | undefined
  let db: ClawbooDb

  beforeEach(async () => {
    captured.length = 0
    contexts.length = 0
    home = await mkdtemp(path.join(os.tmpdir(), 'clawboo-deliver-workdir-'))
    prevHome = process.env['HOME']
    prevClawbooHome = process.env['CLAWBOO_HOME']
    process.env['HOME'] = home
    process.env['CLAWBOO_HOME'] = path.join(home, '.clawboo')
    db = getDb()
    const now = Date.now()
    db.insert(teams)
      .values({
        id: 'T',
        name: 'Team T',
        icon: '🚀',
        color: '#000',
        createdAt: now,
        updatedAt: now,
      })
      .run()
  })
  afterEach(async () => {
    resetDb()
    if (prevHome === undefined) delete process.env['HOME']
    else process.env['HOME'] = prevHome
    if (prevClawbooHome === undefined) delete process.env['CLAWBOO_HOME']
    else process.env['CLAWBOO_HOME'] = prevClawbooHome
    await rm(home, { recursive: true, force: true })
  })

  function seedAgent(id: string, runtime: string): void {
    const now = Date.now()
    db.insert(agents)
      .values({ id, name: id, gatewayId: id, runtime, teamId: 'T', createdAt: now, updatedAt: now })
      .run()
  }

  function wire(chatRoomId?: string, taskId: string | null = null) {
    return createServerDeliver({
      db,
      teamId: 'T',
      ...(chatRoomId ? { chatRoomId } : {}),
      mcpBaseUrl: null,
      nudge: createNudgeQueue(),
      abortMap: new Map(),
      onEvent: async () => {},
      onSessionClosed: async () => {},
      taskForSession: () => taskId,
      execForSession: () => null,
      stopGen: () => 0,
      leaderAgentId: () => 'leader',
      persistTurn: () => true,
      persistMeta: () => true,
    })
  }

  // CLAWBOO_HOME's `-work` sibling, by its real path (macOS's temp is a link).
  const workdir = (): string => path.join(realpathSync.native(home), '.clawboo-work', 'teams', 'T')

  for (const runtime of ['claude-code', 'codex', 'hermes', 'clawboo-native'] as const) {
    it(`a ${runtime} team-chat run starts in <work folder>/teams/<teamId>, created 0700`, async () => {
      seedAgent('a1', runtime)
      await wire()('agent:a1:team:T', 'a1', 'hello', HUMAN_TURN)
      await tick()

      expect(captured.map((c) => c.runtime)).toEqual([runtime])
      const { ctx } = captured[0]!
      expect(ctx.cwd).toBe(workdir())
      expect(ctx.cwd).not.toBe(path.join(home, '.clawboo'))
      expect((await stat(workdir())).isDirectory()).toBe(true)
      if (!isWindows) expect((await stat(workdir())).mode & 0o777).toBe(0o700)
    })
  }

  it('every member of a team shares the one folder, rooms included', async () => {
    seedAgent('cc', 'claude-code')
    seedAgent('cx', 'codex')
    seedAgent('nv', 'clawboo-native')
    await wire()('agent:cc:team:T', 'cc', 'hi', HUMAN_TURN)
    await wire('room-2')('agent:cx:team:T', 'cx', 'hi', HUMAN_TURN)
    await wire()('agent:nv:team:T', 'nv', 'hi', HUMAN_TURN)
    await tick()

    expect(captured.map((c) => c.ctx.cwd)).toEqual([workdir(), workdir(), workdir()])
  })

  for (const runtime of ['claude-code', 'codex', 'hermes', 'clawboo-native'] as const) {
    it(`a ${runtime} run that holds a task starts in <team folder>/tasks/<taskId>, created 0700`, async () => {
      seedAgent('a1', runtime)
      const taskId = createTask(db, { title: 'Write the brief', status: 'todo', teamId: 'T' }).id
      await wire(undefined, taskId)('agent:a1:team:T', 'a1', 'do it', {
        kind: 'delegation',
        fromAgentId: 'leader',
      })
      await tick()

      const folder = path.join(workdir(), 'tasks', taskId)
      expect(captured.map((c) => c.ctx.cwd)).toEqual([folder])
      // It may still read the team folder that holds it.
      expect(captured[0]?.ctx.readRoot).toBe(workdir())
      expect((await stat(folder)).isDirectory()).toBe(true)
      if (!isWindows) expect((await stat(folder)).mode & 0o777).toBe(0o700)
      // The run is told the folder is the task's own.
      expect(contexts.join('\n')).toContain(TASK_FOLDER_NOTE)
    })
  }

  it('a person turn and a task run of one agent start in different folders', async () => {
    seedAgent('cc', 'claude-code')
    const taskId = createTask(db, { title: 'Draft notes', status: 'todo', teamId: 'T' }).id
    await wire()('agent:cc:team:T', 'cc', 'hi', HUMAN_TURN)
    await wire(undefined, taskId)('agent:cc:team:T', 'cc', 'go', {
      kind: 'delegation',
      fromAgentId: 'leader',
    })
    await tick()

    expect(captured.map((c) => c.ctx.cwd)).toEqual([
      workdir(),
      path.join(workdir(), 'tasks', taskId),
    ])
    // Only the task run hears about a task folder, or gets a wider read folder.
    expect(captured[0]?.ctx.readRoot).toBeUndefined()
    expect(contexts[0]).not.toContain(TASK_FOLDER_NOTE)
    expect(contexts[1]).toContain(TASK_FOLDER_NOTE)
  })

  it('fails the start, rather than running in the server folder, when the folder cannot be created', async () => {
    seedAgent('a1', 'codex')
    // A file where the work folder should be: mkdir fails underneath it.
    await writeFile(path.join(home, '.clawboo-work'), 'not a folder')

    await expect(wire()('agent:a1:team:T', 'a1', 'hello', HUMAN_TURN)).rejects.toThrow(
      'could not create the working folder',
    )
  })
})
