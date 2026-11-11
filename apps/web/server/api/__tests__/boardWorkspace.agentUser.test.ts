// The Workspace tab and the artifact preview with agents on their own OS user.
//
// With CLAWBOO_AGENT_USER set, a task's checkout and an agent's team folder are
// the agent user's: the server cannot see into them, and must not open a file
// there as itself anyway. Every listing, read, stat and git call goes to the
// agent host, which runs as that user. The host here is served in this process
// and runs as the test's own user, so files still work; what these tests prove
// is that each request went through it, and that a link an agent planted in
// its checkout is never served, with the setting on and with it off.

import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import express from 'express'
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from 'vitest'

import {
  agents,
  createTask,
  createWorkspace,
  setTaskWorkspaceRefs,
  tasks,
  teams,
} from '@clawboo/db'
import { branchNameForTask } from '@clawboo/worktrees'
import { eq } from 'drizzle-orm'

import type { HostRequest } from '../../lib/agentUser/protocol'
import { setActiveAgentHost } from '../../lib/agentUser/state'
import { startInProcessHost, type InProcessHost } from '../../lib/agentUser/__tests__/inProcessHost'
import { getDb, resetDb } from '../../lib/db'
import { agentTeamFolder, openConfinedFile } from '../../lib/workspaceFs'
import { apiRouter } from '../index'

const posix = process.platform !== 'win32'

const execFileAsync = promisify(execFile)
async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, windowsHide: true })
  return stdout
}

const KEY_CANARY = 'vault-key-canary-8d21e7'
/** The first bytes of every SQLite database file. */
const DB_MARKER = 'SQLite format 3'

let home: string
let repo: string
let wt: string
let teamDir: string
let vaultKey: string
let database: string
let prevHome: string | undefined
let prevClawbooHome: string | undefined
let prevWorkDir: string | undefined
let server: http.Server
let origin: string
let taskId: string

beforeAll(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), 'clawboo-ws-agent-'))
  prevHome = process.env['HOME']
  prevClawbooHome = process.env['CLAWBOO_HOME']
  prevWorkDir = process.env['CLAWBOO_WORK_DIR']
  process.env['HOME'] = home
  process.env['CLAWBOO_HOME'] = path.join(home, '.clawboo')
  process.env['CLAWBOO_WORK_DIR'] = path.join(home, 'work')

  // The two files a planted link would be after: the vault key and the database.
  const secrets = path.join(home, '.clawboo', 'secrets')
  await mkdir(secrets, { recursive: true })
  vaultKey = path.join(secrets, 'master.key')
  await writeFile(vaultKey, KEY_CANARY)
  const db = getDb()
  database = path.join(home, '.clawboo', 'clawboo.db')

  repo = path.join(home, 'repo')
  await mkdir(repo)
  await git(repo, ['init', '-q', '-b', 'main'])
  await git(repo, ['config', 'user.name', 'test'])
  await git(repo, ['config', 'user.email', 'test@example.com'])
  await writeFile(path.join(repo, 'README.md'), '# repo\n')
  await git(repo, ['add', '-A'])
  await git(repo, ['commit', '-q', '--no-verify', '-m', 'init'])

  // A task checkout the way provisioning leaves one: the task branch with a
  // scaffold commit, then the agent's work on top, some of it uncommitted.
  taskId = createTask(db, { title: 'Build the page', status: 'todo' }).id
  const branch = branchNameForTask(taskId)
  wt = path.join(home, 'wt')
  await git(repo, ['worktree', 'add', '-q', '-b', branch, wt])
  await writeFile(path.join(wt, 'TASK.md'), '# Build the page\n')
  await git(wt, ['add', '-A'])
  await git(wt, ['commit', '-q', '--no-verify', '-m', `clawboo: scaffold task ${taskId}`])
  await writeFile(path.join(wt, 'README.md'), '# repo\nchanged by the agent\n')
  await writeFile(path.join(wt, 'index.html'), '<h1>Built</h1>')
  await mkdir(path.join(wt, 'src'))
  await writeFile(path.join(wt, 'src', 'app.css'), 'h1 { color: red }')
  createWorkspace(db, taskId, repo, { branch, worktreePath: wt })

  // An agent with a team folder.
  const now = Date.now()
  db.insert(teams)
    .values({ id: 'T', name: 'T', icon: 'T', color: '#000', createdAt: now, updatedAt: now })
    .run()
  db.insert(agents)
    .values({
      id: 'cx',
      runtime: 'codex',
      teamId: 'T',
      name: 'cx',
      gatewayId: 'cx',
      createdAt: now,
      updatedAt: now,
    })
    .run()
  db.update(tasks).set({ assigneeAgentId: 'cx' }).where(eq(tasks.id, taskId)).run()
  setTaskWorkspaceRefs(db, taskId, { worktreeRef: wt, branchRef: branch })
  teamDir = agentTeamFolder('cx')!.path
  await mkdir(path.join(teamDir, 'docs'), { recursive: true })
  await writeFile(path.join(teamDir, 'docs', 'plan.md'), 'step one')

  const app = express()
  app.set('case sensitive routing', true)
  app.use(apiRouter)
  server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}, 120_000)

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  resetDb()
  const restore = (key: string, value: string | undefined): void => {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  restore('HOME', prevHome)
  restore('CLAWBOO_HOME', prevClawbooHome)
  restore('CLAWBOO_WORK_DIR', prevWorkDir)
  await rm(home, { recursive: true, force: true })
})

async function get(sub: string): Promise<{ status: number; body: string }> {
  const res = await fetch(`${origin}${sub}`, { redirect: 'manual' })
  return { status: res.status, body: await res.text() }
}

const board = (sub: string): string => `/api/board/${taskId}${sub}`

/** The agent host, its requests, and the processes it was asked to start. */
interface Hosted {
  h: InProcessHost
  ops: Array<{ op: string; path?: string }>
  spawned: string[][]
  request: MockInstance<InProcessHost['client']['request']>
  origRequest: InProcessHost['client']['request']
}

async function startHosted(): Promise<Hosted> {
  vi.stubEnv('CLAWBOO_AGENT_USER', 'clawboo-agent')
  const h = startInProcessHost()
  const hello = await h.client.waitForHello()
  setActiveAgentHost({
    client: h.client,
    hello,
    config: { user: 'clawboo-agent', switch: 'sudo', socket: null },
  })
  const ops: Hosted['ops'] = []
  const spawned: string[][] = []
  const origRequest = h.client.request.bind(h.client) as InProcessHost['client']['request']
  const request = vi.spyOn(h.client, 'request').mockImplementation(((
    req: HostRequest,
    opts?: { timeoutMs?: number },
  ) => {
    ops.push({ op: req.op, ...('path' in req ? { path: req.path } : {}) })
    return origRequest(req, opts)
  }) as InProcessHost['client']['request'])
  const origSpawn = h.client.spawn.bind(h.client)
  vi.spyOn(h.client, 'spawn').mockImplementation((o) => {
    spawned.push([o.command, ...o.args])
    return origSpawn(o)
  })
  return { h, ops, spawned, request, origRequest }
}

function stopHosted(hosted: Hosted | null): void {
  setActiveAgentHost(null)
  hosted?.h.client.close()
  vi.unstubAllEnvs()
}

describe.runIf(posix)('the Workspace tab with agent isolation on', { timeout: 120_000 }, () => {
  let hosted: Hosted | null = null

  beforeEach(async () => {
    hosted = await startHosted()
  })

  afterEach(() => {
    stopHosted(hosted)
    hosted = null
  })

  it('lists the checkout through the host', async () => {
    const r = await get(board('/workspace/tree?dir=src'))
    expect(r.status).toBe(200)
    expect(JSON.parse(r.body)).toMatchObject({
      ok: true,
      dir: 'src',
      entries: [{ name: 'app.css', kind: 'file', size: 17 }],
      truncated: false,
    })
    expect(hosted!.ops).toContainEqual({ op: 'fs.list', path: path.join(wt, 'src') })

    const root = JSON.parse((await get(board('/workspace/tree'))).body) as {
      entries: Array<{ name: string }>
    }
    // Folders first, and the checkout's `.git` pointer file left out.
    expect(root.entries.map((e) => e.name)).toEqual(['src', 'index.html', 'README.md', 'TASK.md'])
  })

  it('reads a file through the host', async () => {
    const r = await get(board('/workspace/file?path=README.md'))
    expect(r.status).toBe(200)
    expect(JSON.parse(r.body)).toMatchObject({
      ok: true,
      path: 'README.md',
      binary: false,
      content: '# repo\nchanged by the agent\n',
      truncated: false,
    })
    expect(hosted!.ops).toContainEqual({ op: 'fs.read', path: path.join(wt, 'README.md') })
  })

  it('runs git status as the agent user', async () => {
    const r = await get(board('/workspace/status'))
    expect(r.status).toBe(200)
    const body = JSON.parse(r.body) as { entries: Array<{ path: string; x: string; y: string }> }
    expect(body.entries).toEqual(
      expect.arrayContaining([
        { path: 'README.md', x: ' ', y: 'M' },
        { path: 'index.html', x: '?', y: '?' },
        { path: 'src/app.css', x: '?', y: '?' },
      ]),
    )
    expect(hosted!.spawned).toContainEqual([
      'git',
      'status',
      '--porcelain',
      '-z',
      '--untracked-files=all',
    ])
  })

  it("runs a file's diff against the scaffold commit as the agent user", async () => {
    const r = await get(board('/workspace/file-diff?path=README.md'))
    expect(r.status).toBe(200)
    const body = JSON.parse(r.body) as { diff: string; truncated: boolean }
    expect(body.diff).toContain('+changed by the agent')
    // The scaffold commit is the baseline, so the task file it added is no change.
    expect(body.diff).not.toContain('TASK.md')
    expect(body.truncated).toBe(false)
    const gitArgs = hosted!.spawned.filter((a) => a[0] === 'git').map((a) => a[1])
    expect(gitArgs).toEqual(['log', 'diff'])
  })

  it('refuses a folder for a per-file diff', async () => {
    const r = await get(board('/workspace/file-diff?path=src'))
    expect(r.status).toBe(400)
    expect(hosted!.ops).toContainEqual({ op: 'fs.stat', path: path.join(wt, 'src') })
  })

  it('serves a preview from a host read, and a folder from its index', async () => {
    for (const sub of ['/preview/index.html', '/preview/']) {
      const r = await get(board(sub))
      expect(r.status, sub).toBe(200)
      expect(r.body, sub).toBe('<h1>Built</h1>')
    }
    const css = await get(board('/preview/src/app.css'))
    expect(css.body).toBe('h1 { color: red }')
    const reads = hosted!.ops.filter((o) => o.op === 'fs.read').map((o) => o.path)
    expect(reads).toContain(path.join(wt, 'index.html'))
    expect(reads).toContain(path.join(wt, 'src', 'app.css'))
  })

  it('says the checkout and the team folder are on disk, and reads the team folder, through the host', async () => {
    const ws = JSON.parse((await get('/api/agents/cx/workspaces')).body) as {
      workspaces: Array<{ taskId: string; onDisk: boolean }>
      teamFolder: { path: string; onDisk: boolean }
    }
    expect(ws.workspaces).toEqual([expect.objectContaining({ taskId, onDisk: true })])
    expect(ws.teamFolder).toMatchObject({ path: teamDir, onDisk: true })
    expect(hosted!.ops).toContainEqual({ op: 'fs.stat', path: wt })
    expect(hosted!.ops).toContainEqual({ op: 'fs.stat', path: teamDir })

    const tree = await get('/api/agents/cx/team-folder/tree?dir=docs')
    expect(JSON.parse(tree.body)).toMatchObject({
      ok: true,
      entries: [{ name: 'plan.md', kind: 'file' }],
    })
    const file = await get('/api/agents/cx/team-folder/file?path=docs/plan.md')
    expect(JSON.parse(file.body)).toMatchObject({ ok: true, content: 'step one' })
    expect(hosted!.ops).toContainEqual({ op: 'fs.list', path: path.join(teamDir, 'docs') })
    expect(hosted!.ops).toContainEqual({
      op: 'fs.read',
      path: path.join(teamDir, 'docs', 'plan.md'),
    })
  })

  it('treats a listing of the wrong shape as an error, not as files', async () => {
    const { request, origRequest } = hosted!
    request.mockImplementation(((req: HostRequest, opts?: { timeoutMs?: number }) => {
      if (req.op === 'fs.list') {
        return Promise.resolve({
          entries: [{ name: '../../.clawboo/secrets/master.key', type: 'file', size: 1 }],
          truncated: false,
        })
      }
      return origRequest(req, opts)
    }) as InProcessHost['client']['request'])
    const r = await get(board('/workspace/tree'))
    expect(r.status).toBe(500)
    expect(r.body).not.toContain('master.key')
  })

  it('never opens a file as the server', async () => {
    await expect(openConfinedFile(wt, path.join(wt, 'README.md'))).rejects.toThrow(
      /agent isolation/,
    )
  })
})

// The design's planted-link test (4.14): an agent links `secret.txt` in its
// checkout to the vault key, then to the database. Neither the preview nor the
// Workspace tab may answer with a byte of either, with the setting on or off.
describe.runIf(posix)('a link planted in the checkout', { timeout: 120_000 }, () => {
  const secret = (): string => path.join(wt, 'secret.txt')
  const targets = (): Array<[string, string, string]> => [
    ['the vault key', vaultKey, KEY_CANARY],
    ['the database', database, DB_MARKER],
  ]

  async function plant(target: string): Promise<void> {
    await rm(secret(), { force: true })
    await symlink(target, secret())
  }

  async function expectRefused(subs: string[], marker: string): Promise<void> {
    for (const sub of subs) {
      const r = await get(board(sub))
      expect(r.status, sub).toBe(400)
      expect(r.body, sub).not.toContain(marker)
    }
  }

  const SECRET_ROUTES = ['/preview/secret.txt', '/workspace/file?path=secret.txt']

  afterAll(async () => {
    await rm(secret(), { force: true })
    await rm(path.join(wt, 'site'), { force: true })
  })

  describe('with agent isolation off', () => {
    it('refuses it as a link to the vault key and as a link to the database', async () => {
      for (const [, target, marker] of targets()) {
        await plant(target)
        await expectRefused(SECRET_ROUTES, marker)
      }
    })

    it('refuses a file reached through a linked folder', async () => {
      await rm(path.join(wt, 'site'), { force: true })
      await symlink(path.dirname(vaultKey), path.join(wt, 'site'))
      await expectRefused(
        ['/preview/site/master.key', '/workspace/file?path=site/master.key'],
        KEY_CANARY,
      )
    })
  })

  describe('with agent isolation on', () => {
    let hosted: Hosted | null = null

    beforeEach(async () => {
      hosted = await startHosted()
    })

    afterEach(() => {
      stopHosted(hosted)
      hosted = null
    })

    it('refuses it as a link to the vault key and as a link to the database, asking the host', async () => {
      for (const [what, target, marker] of targets()) {
        await plant(target)
        hosted!.ops.length = 0
        await expectRefused(SECRET_ROUTES, marker)
        // Refused from what the host saw, not from a look the server took itself.
        expect(hosted!.ops, what).toContainEqual({ op: 'fs.stat', path: secret() })
      }
    })

    it('refuses a file reached through a linked folder', async () => {
      await rm(path.join(wt, 'site'), { force: true })
      await symlink(path.dirname(vaultKey), path.join(wt, 'site'))
      await expectRefused(
        ['/preview/site/master.key', '/workspace/file?path=site/master.key'],
        KEY_CANARY,
      )
      expect(hosted!.ops).toContainEqual({ op: 'fs.stat', path: path.join(wt, 'site') })
      expect(hosted!.ops.filter((o) => o.op === 'fs.read')).toEqual([])
    })

    it('refuses it at the read when the host said it was a file (swapped after the check)', async () => {
      await plant(vaultKey)
      const { request, origRequest } = hosted!
      // The stat answers for the regular file that was there when it was asked;
      // the link is what the read meets. The host opens with O_NOFOLLOW.
      request.mockImplementation(((req: HostRequest, opts?: { timeoutMs?: number }) => {
        hosted!.ops.push({ op: req.op, ...('path' in req ? { path: req.path } : {}) })
        if (req.op === 'fs.stat' && req.path === secret()) {
          return Promise.resolve({
            stat: { type: 'file', size: 10, mtimeMs: 0, mode: 0o644, uid: 0, nlink: 1 },
          })
        }
        return origRequest(req, opts)
      }) as InProcessHost['client']['request'])
      await expectRefused(SECRET_ROUTES, KEY_CANARY)
      expect(hosted!.ops).toContainEqual({ op: 'fs.read', path: secret() })
    })
  })
})
