// The worktree io the server installs: with agent isolation on, git and file
// operations on the work folder go to the agent host, and everything else runs
// here. With it off, nothing goes to the host.

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  execGit,
  getWorktreeIo,
  GitError,
  localWorktreeIo,
  readTaskFile,
  replaceTaskFile,
  appendTaskFile,
  setWorktreeIo,
  UnsafeTaskFileError,
} from '@clawboo/worktrees'

import { setActiveAgentHost } from '../state'
import { agentWorktreeIo, installAgentWorktreeIo, isInAgentSpace } from '../worktreeIo'
import { startInProcessHost, type InProcessHost } from './inProcessHost'

const posix = process.platform !== 'win32'

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@example.com',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@example.com',
    },
  }).trim()

let dir: string
let work: string
let outside: string

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-wtio-')))
  work = path.join(dir, 'work')
  outside = path.join(dir, 'outside')
  fs.mkdirSync(work)
  fs.mkdirSync(outside)
  vi.stubEnv('CLAWBOO_HOME', path.join(dir, 'data'))
  vi.stubEnv('CLAWBOO_WORK_DIR', work)
  installAgentWorktreeIo()
})

afterEach(() => {
  setWorktreeIo(null)
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  fs.rmSync(dir, { recursive: true, force: true })
})

describe.runIf(posix)('the agent worktree io with isolation off', () => {
  it('runs git and files in the work folder here: no host is needed', async () => {
    vi.stubEnv('CLAWBOO_AGENT_USER', '')
    const repo = path.join(work, 'repo')
    fs.mkdirSync(repo)
    git(repo, 'init', '-q', '-b', 'main')
    expect((await execGit(repo, ['rev-parse', '--is-inside-work-tree'])).trim()).toBe('true')
    await replaceTaskFile(repo, 'TASK.md', 'here\n')
    expect(fs.readFileSync(path.join(repo, 'TASK.md'), 'utf8')).toBe('here\n')
    expect(await getWorktreeIo().exists(path.join(repo, 'TASK.md'))).toBe(true)
  })

  it('installing it twice keeps one io', () => {
    installAgentWorktreeIo()
    installAgentWorktreeIo()
    expect(getWorktreeIo()).toBe(agentWorktreeIo)
  })
})

describe.runIf(posix)('the agent worktree io with isolation on', { timeout: 120_000 }, () => {
  let h: InProcessHost
  let spawned: {
    command: string
    args: readonly string[]
    cwd?: string
    env: Record<string, string>
  }[]
  let requests: string[]

  beforeEach(async () => {
    vi.stubEnv('CLAWBOO_AGENT_USER', 'clawboo-agent')
    h = startInProcessHost()
    const hello = await h.client.waitForHello()
    setActiveAgentHost({
      client: h.client,
      hello,
      config: { user: 'clawboo-agent', switch: 'sudo', socket: null },
    })
    spawned = []
    requests = []
    const spawn = h.client.spawn.bind(h.client)
    vi.spyOn(h.client, 'spawn').mockImplementation((o) => {
      spawned.push({ command: o.command, args: o.args, cwd: o.cwd, env: o.env })
      return spawn(o)
    })
    const request = h.client.request.bind(h.client)
    vi.spyOn(h.client, 'request').mockImplementation((req, opts) => {
      requests.push(req.op)
      return request(req, opts)
    })
  })

  afterEach(() => {
    setActiveAgentHost(null)
    h.client.close()
  })

  it('knows the work folder by its spelling and by a link into it', () => {
    expect(isInAgentSpace(path.join(work, 'worktrees', 'x', 'task-1'))).toBe(true)
    expect(isInAgentSpace(work)).toBe(true)
    expect(isInAgentSpace(`${work}-old/x`)).toBe(false)
    expect(isInAgentSpace(outside)).toBe(false)
    const link = path.join(outside, 'into-work')
    fs.symlinkSync(work, link)
    expect(isInAgentSpace(path.join(link, 'worktrees'))).toBe(true)
  })

  it('runs git in the work folder through the host, with the agent env, and git elsewhere here', async () => {
    const local = vi.spyOn(localWorktreeIo, 'git')
    const repo = path.join(work, 'repo')
    fs.mkdirSync(repo)
    git(repo, 'init', '-q', '-b', 'main')
    expect((await execGit(repo, ['rev-parse', '--is-inside-work-tree'])).trim()).toBe('true')
    expect(spawned).toHaveLength(1)
    expect(spawned[0]).toMatchObject({
      command: 'git',
      args: ['rev-parse', '--is-inside-work-tree'],
      cwd: repo,
    })
    expect(spawned[0]!.env['GIT_TERMINAL_PROMPT']).toBe('0')
    // The server's identity and data folder are not handed to the agent.
    expect(spawned[0]!.env['CLAWBOO_HOME']).toBeUndefined()
    expect(local).not.toHaveBeenCalled()

    // The user's repository is the server's: its git runs here.
    const mine = path.join(outside, 'mine')
    fs.mkdirSync(mine)
    git(mine, 'init', '-q', '-b', 'main')
    await execGit(mine, ['status', '--porcelain'])
    expect(spawned).toHaveLength(1)
    expect(local).toHaveBeenCalledTimes(1)

    // A git call that names the work folder (a `-C`, an absolute path) goes to the host.
    await execGit(outside, ['-C', repo, 'status', '--porcelain'])
    await execGit(mine, ['--git-dir', path.join(repo, '.git'), 'rev-parse', '--git-dir'])
    await execGit(mine, ['worktree', 'add', '--detach', path.join(work, 'x'), 'HEAD']).catch(
      () => undefined,
    )
    expect(spawned).toHaveLength(4)
    expect(local).toHaveBeenCalledTimes(1)
  })

  it('runs git through the host on the repository at its folder, whatever GIT_DIR the server has', async () => {
    const repo = path.join(work, 'repo')
    fs.mkdirSync(repo)
    git(repo, 'init', '-q', '-b', 'main')
    const elsewhere = path.join(outside, 'elsewhere')
    fs.mkdirSync(elsewhere)
    git(elsewhere, 'init', '-q', '-b', 'main')
    // A server started from a git hook inherits these.
    vi.stubEnv('GIT_DIR', path.join(elsewhere, '.git'))
    vi.stubEnv('GIT_WORK_TREE', elsewhere)
    vi.stubEnv('GIT_INDEX_FILE', path.join(elsewhere, '.git', 'index'))

    const gitDir = (await execGit(repo, ['rev-parse', '--absolute-git-dir'])).trim()
    expect(fs.realpathSync(gitDir)).toBe(fs.realpathSync(path.join(repo, '.git')))
    for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) {
      expect(spawned.at(-1)!.env[name]).toBeUndefined()
    }
    expect(spawned.at(-1)!.env['GIT_TERMINAL_PROMPT']).toBe('0')
  })

  it('a failed git through the host is a GitError carrying git stderr', async () => {
    const notRepo = path.join(work, 'plain')
    fs.mkdirSync(notRepo)
    const err = await execGit(notRepo, ['rev-parse', 'HEAD']).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(GitError)
    expect((err as GitError).args).toEqual(['rev-parse', 'HEAD'])
    expect((err as GitError).stderr).toMatch(/not a git repository/i)
    expect((err as GitError).message).toMatch(/^git rev-parse HEAD failed: /)
    expect((err as GitError).exitCode).toBe(128)
    // A missing ref: exit 1 and nothing said, which tells "not there" from a failure.
    git(notRepo, 'init', '-q', '-b', 'main')
    const quiet = await execGit(notRepo, ['rev-parse', '--verify', '--quiet', 'refs/heads/nope'])
      .then(() => null)
      .catch((e: unknown) => e as GitError)
    expect(quiet).toMatchObject({ exitCode: 1, stderr: '' })
    // A folder that is not there: the host cannot start git in it.
    const gone = await execGit(path.join(work, 'gone'), ['status']).catch((e: unknown) => e)
    expect(gone).toBeInstanceOf(GitError)
    expect((gone as GitError).exitCode).toBeNull()
  })

  it('does file work in the work folder through the host, and nowhere else', async () => {
    const io = getWorktreeIo()
    const root = path.join(work, 'worktrees', 'abc')
    await io.mkdir(root)
    expect((fs.statSync(root).mode & 0o777).toString(8)).toBe('700')
    await io.writeFile(path.join(root, 'init.sh'), '#!/bin/sh\n', 0o755)
    expect(fs.statSync(path.join(root, 'init.sh')).mode & 0o777).toBe(0o755)
    expect(await io.exists(path.join(root, 'init.sh'))).toBe(true)
    expect(await io.exists(path.join(root, 'nope'))).toBe(false)
    expect((await io.readdir(work)).find((e) => e.name === 'worktrees')).toEqual({
      name: 'worktrees',
      isDirectory: true,
    })
    expect((await io.stat(root)).isDirectory).toBe(true)
    await expect(io.stat(path.join(root, 'nope'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await io.realpath(root)).toBe(root)
    // A link in the work folder is resolved by the host, as git resolves it.
    const linked = path.join(work, 'linked')
    fs.symlinkSync(root, linked)
    const before = requests.length
    expect(await io.realpath(linked)).toBe(root)
    expect(requests.slice(before)).toEqual(['fs.realpath'])
    await expect(io.realpath(path.join(root, 'nope'))).rejects.toMatchObject({ code: 'ENOENT' })
    await io.rename(path.join(root, 'init.sh'), path.join(root, 'run.sh'))
    await io.rm(root)
    expect(fs.existsSync(root)).toBe(false)
    expect(requests).toEqual(
      expect.arrayContaining(['fs.mkdir', 'fs.write', 'fs.stat', 'fs.list', 'fs.rename', 'fs.rm']),
    )

    requests.length = 0
    await io.mkdir(path.join(outside, 'a', 'b'))
    await io.writeFile(path.join(outside, 'a', 'f'), 'x')
    expect(await io.exists(path.join(outside, 'a', 'f'))).toBe(true)
    await io.rm(path.join(outside, 'a'))
    expect(requests).toEqual([])
  })

  it('reads and writes task files through the host, refusing a link at the name', async () => {
    const wt = path.join(work, 'worktrees', 'abc', 'task-1')
    fs.mkdirSync(wt, { recursive: true })
    await replaceTaskFile(wt, 'AGENT_HANDOFF.json', '{"a":1}\n')
    await appendTaskFile(wt, 'VERIFICATION.md', 'one\n')
    await appendTaskFile(wt, 'VERIFICATION.md', 'two\n')
    expect(await readTaskFile(wt, 'AGENT_HANDOFF.json')).toBe('{"a":1}\n')
    expect(await readTaskFile(wt, 'VERIFICATION.md')).toBe('one\ntwo\n')
    expect(requests).toEqual(['fs.write', 'fs.append', 'fs.append', 'fs.read', 'fs.read'])

    await expect(readTaskFile(wt, 'TASK.md')).rejects.toMatchObject({ code: 'ENOENT' })
    const secret = path.join(outside, 'secret')
    fs.writeFileSync(secret, 'vault key')
    fs.symlinkSync(secret, path.join(wt, 'task-progress.md'))
    await expect(readTaskFile(wt, 'task-progress.md')).rejects.toBeInstanceOf(UnsafeTaskFileError)
    await expect(appendTaskFile(wt, 'task-progress.md', 'x')).rejects.toBeInstanceOf(
      UnsafeTaskFileError,
    )
    expect(fs.readFileSync(secret, 'utf8')).toBe('vault key')
    fs.writeFileSync(path.join(wt, 'big.md'), 'x'.repeat(20))
    await expect(readTaskFile(wt, 'big.md', 10)).rejects.toBeInstanceOf(UnsafeTaskFileError)
  })
})
