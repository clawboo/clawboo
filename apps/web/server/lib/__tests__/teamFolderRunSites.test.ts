// Every run that starts in a team folder reports that it is working there, from its
// start to its end, so a team-chat work check can wait for it (see
// teamFolderActivity). The team chat's own runs are covered by teamChatCheckHold;
// these are the other three ways a run gets into the folder.

import { execFileSync } from 'node:child_process'
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { agents, createTask, teams, type ClawbooDb } from '@clawboo/db'
import type {
  Capabilities,
  RunHandle,
  RuntimeAdapter,
  RuntimeEvent,
  StartOpts,
  TaskHandle,
} from '@clawboo/executor'

import { driveAgentChat } from '../agentChat/driveAgentChat'
import { getDb, getDbPath, resetDb } from '../db'
import { runTaskOnRuntime } from '../executorRunner'
import { folderRunners } from '../runtimes/teamFolderActivity'
import { teamWorkdirPath } from '../runtimes/teamWorkdir'
import { runTeamExchange } from '../teamChat/runTeamExchange'

const CAPS: Capabilities = {
  streaming: true,
  mcp: true,
  worktrees: true,
  resume: true,
  toolApproval: true,
  models: [],
  contextWindowTokens: 200_000,
  runtimeClass: 'wrapped-oneshot',
}

/** Notes who the folder's record lists as its run starts and as its stream ends. */
class WatchingAdapter implements RuntimeAdapter {
  readonly participantKind = 'agent' as const
  readonly seenAtStart: string[][] = []
  readonly seenInStream: string[][] = []
  constructor(
    readonly id: string,
    private readonly folder: string,
    private readonly failStart = false,
  ) {}
  capabilities(): Capabilities {
    return CAPS
  }
  async health(): Promise<{ ok: boolean }> {
    return { ok: true }
  }
  async start(_t: TaskHandle, opts: StartOpts): Promise<RunHandle> {
    this.seenAtStart.push(folderRunners(this.folder))
    if (this.failStart) throw new Error('driver exploded mid-start')
    return { adapterId: this.id, sessionKey: opts.sessionKey, runId: 'r' }
  }
  events(run: RunHandle): AsyncIterable<RuntimeEvent> {
    const watch = (): void => void this.seenInStream.push(folderRunners(this.folder))
    const sk = run.sessionKey
    return (async function* () {
      watch()
      yield {
        runId: sk,
        sessionId: sk,
        ts: 1,
        seq: 1,
        kind: 'done',
        reason: 'success',
        summary: 'ok',
      } as RuntimeEvent
    })()
  }
  async abort(): Promise<void> {}
  async setModel(): Promise<void> {}
  async writeContext(): Promise<void> {}
}

// Every run gets the team folder from one of these two functions, so a new caller
// is how a new way of starting a run would appear. It must report that it is working
// there, or a team-chat work check will not wait for it.
describe('no way into a team folder goes unreported', () => {
  const SERVER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
  /** Callers that never start a run in the folder, and why. */
  const NOT_A_RUN: Record<string, string> = {
    'api/teams.ts': 'deletes the folder with its team',
    'lib/runtimes/teamWorkdir.ts': 'defines them',
    'lib/teamChat/teamWorkCheck.ts': 'the check itself, which holds its own place',
    'lib/workspaceFs.ts': 'reads the folder for the workspace view',
  }

  function sourcesUnder(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory())
        return entry.name === '__tests__' || entry.name === 'node_modules' ? [] : sourcesUnder(full)
      return entry.name.endsWith('.ts') ? [full] : []
    })
  }

  it('every caller of the team folder lookups reports its run, or is listed as no run', () => {
    const callers = sourcesUnder(SERVER)
      .map((file) => ({ file, text: readFileSync(file, 'utf8') }))
      .filter(({ text }) => /\b(teamWorkdirFor|taskRunWorkdirFor|teamWorkdirPath)\(/.test(text))
      .map(({ file, text }) => ({
        name: path.relative(SERVER, file).replaceAll(path.sep, '/'),
        text,
      }))

    expect(callers.length).toBeGreaterThanOrEqual(4)
    const unreported = callers
      .filter(({ name, text }) => !(name in NOT_A_RUN) && !/\bstartFolderRun\(/.test(text))
      .map(({ name }) => name)
    expect(unreported).toEqual([])
    // A listed file that stopped being a caller should leave the list.
    for (const name of Object.keys(NOT_A_RUN)) expect(callers.map((c) => c.name)).toContain(name)
  })
})

describe('runs in a team folder report it', () => {
  let home: string
  const prev: Record<string, string | undefined> = {}
  let db: ClawbooDb
  let folder: string

  const seedAgent = (id: string, runtime: string): void => {
    const now = Date.now()
    db.insert(agents)
      .values({
        id,
        name: id,
        gatewayId: id,
        sourceId: runtime,
        sourceAgentId: id,
        runtime,
        teamId: 'T',
        createdAt: now,
        updatedAt: now,
      })
      .run()
  }

  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), 'clawboo-folder-sites-'))
    for (const k of ['HOME', 'CLAWBOO_HOME']) prev[k] = process.env[k]
    process.env['HOME'] = home
    process.env['CLAWBOO_HOME'] = path.join(home, '.clawboo')
    expect(getDbPath().startsWith(home)).toBe(true)
    db = getDb()
    const now = Date.now()
    db.insert(teams)
      .values({ id: 'T', name: 'T', icon: 'T', color: '#000', createdAt: now, updatedAt: now })
      .run()
    folder = teamWorkdirPath('T')
  })
  afterEach(async () => {
    resetDb()
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    await rm(home, { recursive: true, force: true })
  })

  it('a one-to-one chat turn', async () => {
    seedAgent('cc', 'claude-code')
    const adapter = new WatchingAdapter('claude-code', folder)
    await driveAgentChat({
      db,
      agentId: 'cc',
      message: 'q',
      mcpBaseUrl: null,
      makeAdapter: () => adapter,
    })

    expect(adapter.seenAtStart).toEqual([['cc']])
    expect(adapter.seenInStream).toEqual([['cc']])
    expect(folderRunners(folder)).toEqual([])
  })

  it('a peer-exchange turn', async () => {
    seedAgent('cc', 'claude-code')
    const adapter = new WatchingAdapter('claude-code', folder)
    const res = await runTeamExchange({
      db,
      teamId: 'T',
      firstSpeakers: ['cc'],
      makeAdapterFor: () => () => adapter,
    })

    expect(res.ok).toBe(true)
    expect(adapter.seenAtStart[0]).toEqual(['cc'])
    expect(folderRunners(folder)).toEqual([])
  })

  it('a task run with no worktree', async () => {
    seedAgent('cc', 'claude-code')
    const task = createTask(db, { title: 'Research something', status: 'todo', teamId: 'T' })
    const adapter = new WatchingAdapter('claude-code', folder)
    const result = await runTaskOnRuntime({
      db,
      makeAdapter: () => adapter,
      taskId: task.id,
      assigneeAgentId: 'cc',
      disableMemoryAutoInject: true,
      kind: 'research',
    })

    expect(result.ok).toBe(true)
    expect(adapter.seenAtStart).toEqual([['cc']])
    expect(folderRunners(folder)).toEqual([])
  })

  it('a task run that throws as it starts ends its report too', async () => {
    seedAgent('cc', 'claude-code')
    const task = createTask(db, { title: 'Research something', status: 'todo', teamId: 'T' })
    const adapter = new WatchingAdapter('claude-code', folder, true)
    await runTaskOnRuntime({
      db,
      makeAdapter: () => adapter,
      taskId: task.id,
      assigneeAgentId: 'cc',
      disableMemoryAutoInject: true,
      kind: 'research',
    }).catch(() => undefined)

    expect(adapter.seenAtStart).toEqual([['cc']])
    expect(folderRunners(folder)).toEqual([])
  })

  it('a task run in a worktree has its own checkout and reports nothing', async () => {
    seedAgent('cc', 'claude-code')
    const repo = path.join(home, 'repo')
    mkdirSync(repo)
    const git = (...args: string[]): void =>
      void execFileSync('git', args, { cwd: repo, windowsHide: true })
    git('init', '-q')
    git('config', 'user.email', 'test@localhost')
    git('config', 'user.name', 'test')
    writeFileSync(path.join(repo, 'README.md'), 'hi\n')
    git('add', '-A')
    git('commit', '--no-verify', '-q', '-m', 'init')
    const task = createTask(db, { title: 'Change a file', status: 'todo', teamId: 'T' })
    const adapter = new WatchingAdapter('claude-code', folder)
    await runTaskOnRuntime({
      db,
      makeAdapter: () => adapter,
      taskId: task.id,
      assigneeAgentId: 'cc',
      disableMemoryAutoInject: true,
      repoPath: repo,
    })

    expect(adapter.seenAtStart).toEqual([[]])
    expect(folderRunners(folder)).toEqual([])
  })
})
