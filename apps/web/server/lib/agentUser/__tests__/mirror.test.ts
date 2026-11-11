// Task checkouts through an agent-owned mirror and git bundles (design 4.9),
// against real repositories, with the git in agent space run by a host served
// in this process.

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { exportTaskBranch, mirrorPathFor, runAgentGit, syncMirror } from '../mirror'
import { setActiveAgentHost } from '../state'
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

describe.runIf(posix)('agent-owned mirror', { timeout: 120_000 }, () => {
  let dir: string
  let repo: string
  let h: InProcessHost
  let spawned: string[][]

  beforeEach(async () => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-mirror-')))
    repo = path.join(dir, 'repo')
    fs.mkdirSync(repo)
    git(repo, 'init', '-q', '-b', 'main')
    fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n')
    git(repo, 'add', '.')
    git(repo, 'commit', '-q', '-m', 'one')
    vi.stubEnv('CLAWBOO_AGENT_USER', 'clawboo-agent')
    vi.stubEnv('CLAWBOO_HOME', path.join(dir, 'data'))
    vi.stubEnv('CLAWBOO_WORK_DIR', path.join(dir, 'work'))
    vi.stubEnv('GIT_AUTHOR_NAME', 't')
    vi.stubEnv('GIT_AUTHOR_EMAIL', 't@example.com')
    vi.stubEnv('GIT_COMMITTER_NAME', 't')
    vi.stubEnv('GIT_COMMITTER_EMAIL', 't@example.com')
    fs.mkdirSync(path.join(dir, 'work'))
    h = startInProcessHost()
    const hello = await h.client.waitForHello()
    setActiveAgentHost({
      client: h.client,
      hello,
      config: { user: 'clawboo-agent', switch: 'sudo', socket: null },
    })
    spawned = []
    const orig = h.client.spawn.bind(h.client)
    vi.spyOn(h.client, 'spawn').mockImplementation((o) => {
      spawned.push([o.command, ...o.args])
      return orig(o)
    })
  })

  afterEach(() => {
    setActiveAgentHost(null)
    h.client.close()
    vi.unstubAllEnvs()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('brings a base commit in, works in a checkout of the mirror, and brings the branch out', async () => {
    const base = git(repo, 'rev-parse', 'HEAD')
    const mirror = await syncMirror(repo, base)
    expect(mirror).toBe(mirrorPathFor(repo))
    expect(git(mirror, 'cat-file', '-t', base)).toBe('commit')
    // The user's repository keeps no sync ref.
    expect(git(repo, 'for-each-ref', 'refs/clawboo-sync/')).toBe('')
    // Every git in the mirror ran through the host.
    expect(spawned.every((a) => a[0] === 'git')).toBe(true)
    expect(spawned.some((a) => a.includes('init'))).toBe(true)

    // The agent's checkout is a worktree of the mirror, not of the user's repository.
    const wt = path.join(dir, 'work', 'worktrees', 'x', 'task-1')
    await runAgentGit([
      '-C',
      mirror,
      'worktree',
      'add',
      '--quiet',
      '-b',
      'clawboo/task-1',
      wt,
      base,
    ])
    expect(git(repo, 'worktree', 'list', '--porcelain')).not.toContain(wt)
    fs.writeFileSync(path.join(wt, 'b.txt'), 'two\n')
    git(wt, 'add', '.')
    git(wt, 'commit', '-q', '-m', 'two')
    const tip = git(wt, 'rev-parse', 'HEAD')

    expect(await exportTaskBranch(repo, 'clawboo/task-1', base)).toBe(tip)
    expect(git(repo, 'rev-parse', 'refs/heads/clawboo/task-1')).toBe(tip)
    expect(git(repo, 'show', `${tip}:b.txt`)).toBe('two')
  })

  it('sends only what is new on the next sync', async () => {
    const first = git(repo, 'rev-parse', 'HEAD')
    const mirror = await syncMirror(repo, first)
    fs.writeFileSync(path.join(repo, 'a.txt'), 'changed\n')
    git(repo, 'commit', '-q', '-am', 'second')
    const second = git(repo, 'rev-parse', 'HEAD')
    await syncMirror(repo, second)
    expect(git(mirror, 'cat-file', '-t', second)).toBe('commit')
    // Already there: nothing moves.
    const before = spawned.length
    await syncMirror(repo, second)
    expect(spawned.length - before).toBe(1) // only the cat-file probe
  })

  it('brings nothing out when the branch has no commits past the base', async () => {
    const base = git(repo, 'rev-parse', 'HEAD')
    const mirror = await syncMirror(repo, base)
    await runAgentGit(['-C', mirror, 'branch', 'clawboo/task-2', base])
    expect(await exportTaskBranch(repo, 'clawboo/task-2', base)).toBeNull()
  })

  it('refuses unsafe branch names and commit ids', async () => {
    await expect(exportTaskBranch(repo, '../../evil', 'a'.repeat(40))).rejects.toThrow(
      /unsafe branch/,
    )
    await expect(syncMirror(repo, 'HEAD')).rejects.toThrow(/not a commit id/)
  })

  it('never runs a hook the agent planted in the mirror as the server', async () => {
    const base = git(repo, 'rev-parse', 'HEAD')
    const mirror = await syncMirror(repo, base)
    const marker = path.join(dir, 'hook-ran')
    const hook = path.join(mirror, 'hooks', 'reference-transaction')
    fs.writeFileSync(hook, `#!/bin/sh\necho "$(id -u)" >> ${marker}\n`, { mode: 0o755 })
    await runAgentGit(['-C', mirror, 'branch', 'clawboo/task-3', base])
    const wt = path.join(dir, 'work', 'worktrees', 'x', 'task-3')
    await runAgentGit(['-C', mirror, 'worktree', 'add', '--quiet', wt, 'clawboo/task-3'])
    fs.writeFileSync(path.join(wt, 'c.txt'), 'c\n')
    git(wt, 'add', '.')
    git(wt, 'commit', '-q', '-m', 'c')
    fs.rmSync(marker, { force: true })
    await exportTaskBranch(repo, 'clawboo/task-3', base)
    // The export ran the mirror's git only through the host (here the same
    // user; in a real install the agent user), and the user's repository has
    // no such hook, so nothing ran as the server.
    const serverSide = spawned.filter((a) => a.includes(repo))
    expect(serverSide).toEqual([])
  })
})
