// Bringing a task branch out of the agent's mirror: the user's branch moves only
// from the commit the caller checked (compare-and-swap), every object that
// arrives is checked, and a branch someone has checked out is never moved.

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { exportTaskBranch, mirrorPathFor, MirrorError, runAgentGit, syncMirror } from '../mirror'
import { setActiveAgentHost } from '../state'
import { startInProcessHost, type InProcessHost } from './inProcessHost'

const posix = process.platform !== 'win32'

const gitEnv = {
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@example.com',
}
/** The environment without variables that would point git at another
 *  repository or index than the fixture's. */
const fixtureEnv = (): NodeJS.ProcessEnv => ({
  ...Object.fromEntries(
    Object.entries(process.env).filter(
      ([k]) =>
        !/^GIT_(DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|COMMON_DIR)$/.test(
          k,
        ),
    ),
  ),
  ...gitEnv,
})
const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', env: fixtureEnv() }).trim()

describe.runIf(posix)('bringing a task branch out of the mirror', { timeout: 120_000 }, () => {
  let dir: string
  let repo: string
  let base: string
  let mirror: string
  let h: InProcessHost
  const branch = 'clawboo/task-x1'

  beforeEach(async () => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-export-')))
    repo = path.join(dir, 'repo')
    fs.mkdirSync(repo)
    git(repo, 'init', '-q', '-b', 'main')
    fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n')
    git(repo, 'add', '.')
    git(repo, 'commit', '-q', '-m', 'one')
    base = git(repo, 'rev-parse', 'HEAD')
    vi.stubEnv('CLAWBOO_AGENT_USER', 'clawboo-agent')
    vi.stubEnv('CLAWBOO_HOME', path.join(dir, 'data'))
    vi.stubEnv('CLAWBOO_WORK_DIR', path.join(dir, 'work'))
    for (const [k, v] of Object.entries(gitEnv)) vi.stubEnv(k, v)
    fs.mkdirSync(path.join(dir, 'work'))
    h = startInProcessHost()
    const hello = await h.client.waitForHello()
    setActiveAgentHost({
      client: h.client,
      hello,
      config: { user: 'clawboo-agent', switch: 'sudo', socket: null },
    })
    mirror = await syncMirror(repo, base)
  })

  afterEach(() => {
    setActiveAgentHost(null)
    h.client.close()
    vi.unstubAllEnvs()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  /** A commit on the task branch in the mirror, past the base. */
  async function agentCommit(name: string): Promise<string> {
    const wt = path.join(dir, 'work', 'worktrees', 'x', name)
    await runAgentGit(['-C', mirror, 'worktree', 'add', '--quiet', '-B', branch, wt, base])
    fs.writeFileSync(path.join(wt, `${name}.txt`), `${name}\n`)
    git(wt, 'add', '.')
    git(wt, 'commit', '-q', '-m', name)
    const tip = git(wt, 'rev-parse', 'HEAD')
    await runAgentGit(['-C', mirror, 'worktree', 'remove', '--force', wt])
    return tip
  }

  it('moves the branch only from the commit the caller checked', async () => {
    const tip = await agentCommit('first')
    // Someone made the branch in their own repository after the caller looked.
    git(repo, 'branch', branch, base)
    const err = await exportTaskBranch(repo, branch, base, null).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(MirrorError)
    expect((err as Error).message).toMatch(/changed while/)
    expect(git(repo, 'rev-parse', branch)).toBe(base)
    // Expecting the commit that is there, it moves.
    expect(await exportTaskBranch(repo, branch, base, base)).toBe(tip)
    expect(git(repo, 'rev-parse', branch)).toBe(tip)
    // Nothing is left under the staging name.
    expect(git(repo, 'for-each-ref', 'refs/clawboo-export/')).toBe('')
  })

  it('refuses work that does not contain the commit the caller requires, checked in the user repository', async () => {
    await agentCommit('first')
    // A commit of someone's on the branch in their own repository, which the
    // task's work does not have.
    git(repo, 'branch', branch, base)
    git(repo, 'checkout', '-q', branch)
    fs.writeFileSync(path.join(repo, 'theirs.txt'), 'theirs\n')
    git(repo, 'add', '.')
    git(repo, 'commit', '-q', '-m', 'theirs')
    git(repo, 'checkout', '-q', 'main')
    const theirs = git(repo, 'rev-parse', branch)

    const err = await exportTaskBranch(repo, branch, base, theirs, { mustContain: theirs }).catch(
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(MirrorError)
    expect((err as Error).message).toMatch(/has commits the task's branch does not/)
    expect(git(repo, 'rev-parse', branch)).toBe(theirs)
    expect(git(repo, 'for-each-ref', 'refs/clawboo-export/')).toBe('')
  })

  it('brings work over that contains the commit the caller requires', async () => {
    const tip = await agentCommit('first')
    git(repo, 'branch', branch, base)
    expect(await exportTaskBranch(repo, branch, base, base, { mustContain: base })).toBe(tip)
    expect(git(repo, 'rev-parse', branch)).toBe(tip)
  })

  it('refuses a malformed object from the mirror, and stores none of it', async () => {
    const tree = git(repo, 'rev-parse', `${base}^{tree}`)
    // A commit whose author line git's own checks refuse, made in the mirror.
    const body = `tree ${tree}\nparent ${base}\nauthor bad <t@example.com 1 +0000\ncommitter t <t@example.com> 1 +0000\n\nbad\n`
    const bad = execFileSync(
      'git',
      ['-C', mirror, 'hash-object', '-t', 'commit', '-w', '--literally', '--stdin'],
      { input: body, encoding: 'utf8', env: fixtureEnv() },
    ).trim()
    git(mirror, 'update-ref', `refs/heads/${branch}`, bad)

    await expect(exportTaskBranch(repo, branch, base, null)).rejects.toThrow(/fsck/)
    expect(() => git(repo, 'rev-parse', '--verify', `refs/heads/${branch}`)).toThrow()
    expect(() => git(repo, 'cat-file', '-e', bad)).toThrow()
  })

  it('never moves a branch someone has checked out', async () => {
    await agentCommit('second')
    git(repo, 'checkout', '-q', '-b', branch)
    await expect(exportTaskBranch(repo, branch, base, base)).rejects.toThrow(/checked out/)
    expect(git(repo, 'rev-parse', branch)).toBe(base)
  })

  it('never moves a branch checked out while its work was being brought over', async () => {
    await agentCommit('fourth')
    git(repo, 'branch', branch, base)
    const checkout = path.join(dir, 'user-checkout')
    // The bundle is read from the agent's space after the first check: the
    // person checks the branch out then, at the commit the caller expects.
    const request = h.client.request.bind(h.client)
    let once = false
    vi.spyOn(h.client, 'request').mockImplementation((req, opts) => {
      if (req.op === 'fs.read' && !once) {
        once = true
        git(repo, 'worktree', 'add', '-q', checkout, branch)
      }
      return request(req, opts)
    })
    await expect(exportTaskBranch(repo, branch, base, base)).rejects.toThrow(/checked out/)
    expect(git(repo, 'rev-parse', branch)).toBe(base)
    expect(git(checkout, 'status', '--porcelain')).toBe('')
  })

  it('still brings the branch over when nothing is in the way', async () => {
    const tip = await agentCommit('third')
    expect(await exportTaskBranch(repo, branch, base)).toBe(tip)
    expect(git(repo, 'show', `${branch}:third.txt`)).toBe('third')
    expect(mirrorPathFor(repo)).toBe(mirror)
  })
})
