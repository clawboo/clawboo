// Task checkouts with agents on their own OS user (design 4.9), against real
// repositories and a real board, with the agent host served in this process (it
// runs as the test's own user, so what is proven is that the work went through
// the host). A checkout is a worktree of the agent's mirror, never of the user's
// repository; git in the mirror or the checkout runs through the host; pause and
// complete bring the task branch back into the user's repository.

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  claimTask,
  completeExecutionProcess,
  createExecutionProcess,
  createTask,
  getComments,
  getTask,
  getWorkspaceForTask,
  setSetting,
  updateStatus,
} from '@clawboo/db'
import type {
  Capabilities,
  RunHandle,
  RuntimeAdapter,
  RuntimeEvent,
  StartOpts,
  TaskHandle,
} from '@clawboo/executor'
import { localWorktreeIo, setWorktreeIo } from '@clawboo/worktrees'

import { mirrorPathFor, runAgentGit, syncMirror } from '../agentUser/mirror'
import { setActiveAgentHost } from '../agentUser/state'
import { installAgentWorktreeIo } from '../agentUser/worktreeIo'
import { startInProcessHost, type InProcessHost } from '../agentUser/__tests__/inProcessHost'
import { getDb, resetDb } from '../db'
import { repoHash } from '../workDir'
import type { RuntimeRunContext } from '../runtimes'
import { runCritic, verifyTask } from '../verification'
import { teamVerifyCommandSettingKey } from '../verification/teamVerifyCommand'
import {
  actOnTaskWorkspace,
  gcTaskWorkspaces,
  provisionTaskWorkspace,
  readWorktreeDetail,
  recordedCheckoutState,
  resumeTaskWorkspace,
} from '../worktrees'

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

const worktreeList = (repo: string): string => git(repo, 'worktree', 'list', '--porcelain')

const CAPS: Capabilities = {
  streaming: true,
  mcp: true,
  worktrees: true,
  resume: true,
  toolApproval: true,
  models: [],
}

/** A reviewer that answers "no findings". */
class FakeReviewer implements RuntimeAdapter {
  readonly id = 'fake-reviewer'
  readonly participantKind = 'agent' as const
  capabilities(): Capabilities {
    return CAPS
  }
  async health() {
    return { ok: true }
  }
  async start(_t: TaskHandle, opts: StartOpts): Promise<RunHandle> {
    return { adapterId: this.id, sessionKey: opts.sessionKey, runId: null }
  }
  events(run: RunHandle): AsyncIterable<RuntimeEvent> {
    const json = '{"findings":[]}'
    const base = { runId: run.sessionKey, sessionId: run.sessionKey, ts: 1 }
    return (async function* () {
      yield {
        ...base,
        seq: 1,
        kind: 'text-delta',
        text: json,
        channel: 'assistant',
      } as RuntimeEvent
      yield { ...base, seq: 2, kind: 'done', reason: 'success', summary: json } as RuntimeEvent
    })()
  }
  async abort() {}
  async setModel() {}
  async writeContext() {}
}

describe.runIf(posix)('task checkouts under agent isolation', { timeout: 120_000 }, () => {
  let dir: string
  let repo: string
  let work: string
  let h: InProcessHost
  /** Every process started through the host: [command, ...args], and its folder. */
  let spawned: { argv: string[]; cwd: string | undefined }[]
  /** Git run here, by the server: its folder and arguments. */
  let localGit: { cwd: string; args: string[] }[]
  /** When set and true for a git call's argv, the host fails to start it. */
  let failWhen: ((argv: string[]) => boolean) | null

  beforeEach(async () => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-worktrees-')))
    repo = path.join(dir, 'repo')
    work = path.join(dir, 'work')
    fs.mkdirSync(repo)
    fs.mkdirSync(work)
    git(repo, 'init', '-q', '-b', 'main')
    fs.writeFileSync(path.join(repo, 'README.md'), '# repo\n')
    git(repo, 'add', '.')
    git(repo, 'commit', '-q', '-m', 'init')
    vi.stubEnv('HOME', dir)
    vi.stubEnv('CLAWBOO_HOME', path.join(dir, 'data'))
    vi.stubEnv('CLAWBOO_WORK_DIR', work)
    vi.stubEnv('CLAWBOO_AGENT_USER', 'clawboo-agent')
    for (const [k, v] of Object.entries(gitEnv)) vi.stubEnv(k, v)
    h = startInProcessHost()
    const hello = await h.client.waitForHello()
    setActiveAgentHost({
      client: h.client,
      hello,
      config: { user: 'clawboo-agent', switch: 'sudo', socket: null },
    })
    // As boot does once the host is up.
    installAgentWorktreeIo()
    spawned = []
    localGit = []
    failWhen = null
    const spawn = h.client.spawn.bind(h.client)
    vi.spyOn(h.client, 'spawn').mockImplementation((o) => {
      const argv = [o.command, ...o.args]
      spawned.push({ argv, cwd: o.cwd })
      if (failWhen?.(argv)) throw new Error('the agent host did not answer')
      return spawn(o)
    })
    const local = localWorktreeIo.git.bind(localWorktreeIo)
    vi.spyOn(localWorktreeIo, 'git').mockImplementation((cwd, args) => {
      localGit.push({ cwd, args })
      return local(cwd, args)
    })
  })

  afterEach(() => {
    resetDb()
    setWorktreeIo(null)
    setActiveAgentHost(null)
    h.client.close()
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  const inWork = (p: string | undefined): boolean =>
    !!p && (p === work || p.startsWith(work + path.sep))

  /** No git the server ran itself touched the work folder. */
  function expectNoServerGitInAgentSpace(): void {
    const offenders = localGit.filter(
      (c) => inWork(c.cwd) || c.args.some((a) => path.isAbsolute(a) && inWork(a)),
    )
    expect(offenders).toEqual([])
  }

  function newTask(title = 'Implement feature X'): string {
    const db = getDb()
    const task = createTask(db, { title, description: 'Do it.', teamId: 'team1', status: 'todo' })
    expect(claimTask(db, task.id, 'agent1', 'claude-code').ok).toBe(true)
    return task.id
  }

  it('provisions the checkout as a worktree of the mirror, never of the user repository', async () => {
    const taskId = newTask()
    const prov = await provisionTaskWorkspace(taskId, { repoPath: repo, kind: 'code' })
    expect(prov.ok).toBe(true)
    if (!prov.ok) return
    const wt = prov.worktree.worktreePath
    const mirror = mirrorPathFor(repo)

    expect(inWork(wt)).toBe(true)
    expect(worktreeList(repo)).not.toContain(wt)
    expect(worktreeList(mirror)).toContain(`worktree ${wt}`)
    // The scaffold is in the checkout, committed on the task branch in the mirror only.
    expect(fs.existsSync(path.join(wt, 'TASK.md'))).toBe(true)
    expect(git(mirror, 'rev-parse', '--verify', prov.worktree.branch)).toBe(
      prov.worktree.baseCommit,
    )
    expect(() => git(repo, 'rev-parse', '--verify', `refs/heads/${prov.worktree.branch}`)).toThrow()

    // The row keeps the user's repository.
    expect(getWorkspaceForTask(getDb(), taskId)?.repoPath).toBe(repo)

    // Git in the mirror and the checkout ran through the host, and only there.
    const hostGit = spawned.filter((s) => s.argv[0] === 'git')
    expect(hostGit.some((s) => s.argv.includes('worktree') && s.argv.includes('add'))).toBe(true)
    expect(hostGit.some((s) => s.cwd === wt && s.argv.includes('commit'))).toBe(true)
    expectNoServerGitInAgentSpace()

    // A repeat provision hands back the checkout git lists in the mirror.
    const again = await provisionTaskWorkspace(taskId, { repoPath: repo, kind: 'code' })
    expect(again.ok && again.worktree.worktreePath).toBe(wt)
    expect(await recordedCheckoutState(repo, wt)).toEqual({
      onDisk: true,
      registration: 'registered',
    })
  })

  it('pause brings the committed work into the user repository, and resume rebuilds from the mirror', async () => {
    const taskId = newTask()
    const prov = await provisionTaskWorkspace(taskId, { repoPath: repo, kind: 'code' })
    if (!prov.ok) throw new Error(prov.reason)
    const { worktreePath: wt, branch } = prov.worktree
    fs.writeFileSync(path.join(wt, 'feature.txt'), 'paused work\n')

    const paused = await actOnTaskWorkspace(taskId, 'pause')
    expect(paused.ok && paused.action === 'pause' && paused.pause.committed).toBe(true)
    expect(fs.existsSync(wt)).toBe(false)
    const tip = git(mirrorPathFor(repo), 'rev-parse', `refs/heads/${branch}`)
    expect(git(repo, 'rev-parse', `refs/heads/${branch}`)).toBe(tip)
    expect(git(repo, 'show', `${tip}:feature.txt`)).toBe('paused work')
    expect(worktreeList(repo)).not.toContain(wt)

    const resumed = await resumeTaskWorkspace(taskId, { repoPath: repo })
    expect(resumed.ok).toBe(true)
    expect(fs.readFileSync(path.join(wt, 'feature.txt'), 'utf8')).toBe('paused work\n')
    expect(worktreeList(mirrorPathFor(repo))).toContain(`worktree ${wt}`)
    expect(worktreeList(repo)).not.toContain(wt)
    expectNoServerGitInAgentSpace()
  })

  it('complete commits the work, brings the branch into the user repository, and checks it there', async () => {
    const taskId = newTask()
    setSetting(getDb(), teamVerifyCommandSettingKey('team1'), JSON.stringify({ command: 'exit 0' }))
    const prov = await provisionTaskWorkspace(taskId, { repoPath: repo, kind: 'code' })
    if (!prov.ok) throw new Error(prov.reason)
    const { worktreePath: wt, branch } = prov.worktree
    fs.writeFileSync(path.join(wt, 'feature.txt'), 'finished work\n')

    // The drawer's diff is read from the agent's checkout, against its scaffold commit.
    const detail = await readWorktreeDetail(taskId)
    expect(detail.diffStat).toMatchObject({ dirty: true, filesChanged: 1 })

    const done = await actOnTaskWorkspace(taskId, 'complete')
    expect(done.ok && done.action === 'complete' && done.complete.dirty).toBe(true)
    expect(done.ok && done.action === 'complete' && done.verified).toBe('pass')
    expect(getTask(getDb(), taskId)?.status).toBe('done')

    const tip = git(mirrorPathFor(repo), 'rev-parse', `refs/heads/${branch}`)
    expect(git(repo, 'rev-parse', `refs/heads/${branch}`)).toBe(tip)
    expect(git(repo, 'show', `refs/heads/${branch}:feature.txt`)).toBe('finished work')
    // The gate's command ran as an agent process, in the checkout.
    expect(spawned.some((s) => s.cwd === wt && s.argv[0] !== 'git')).toBe(true)
    expectNoServerGitInAgentSpace()
  })

  it('an empty completion removes the checkout and the branch, in the mirror and the user repository', async () => {
    const taskId = newTask()
    const prov = await provisionTaskWorkspace(taskId, { repoPath: repo, kind: 'code' })
    if (!prov.ok) throw new Error(prov.reason)
    const { worktreePath: wt, branch } = prov.worktree
    // An earlier pause brought the branch over.
    await actOnTaskWorkspace(taskId, 'pause')
    expect(git(repo, 'branch', '--list', branch)).toContain(branch)
    expect((await resumeTaskWorkspace(taskId, { repoPath: repo })).ok).toBe(true)

    const done = await actOnTaskWorkspace(taskId, 'complete')
    expect(done.ok && done.action === 'complete' && done.complete.cleaned).toBe(true)
    expect(fs.existsSync(wt)).toBe(false)
    expect(git(mirrorPathFor(repo), 'branch', '--list', branch)).toBe('')
    expect(git(repo, 'branch', '--list', branch)).toBe('')
  })

  it('never overwrites a user branch that has commits the mirror does not', async () => {
    const taskId = newTask()
    const prov = await provisionTaskWorkspace(taskId, { repoPath: repo, kind: 'code' })
    if (!prov.ok) throw new Error(prov.reason)
    const { worktreePath: wt, branch } = prov.worktree
    // Someone made the task's branch in their own repository, with a commit of theirs.
    git(repo, 'checkout', '-q', '-b', branch)
    fs.writeFileSync(path.join(repo, 'theirs.txt'), 'theirs\n')
    git(repo, 'add', '.')
    git(repo, 'commit', '-q', '-m', 'theirs')
    git(repo, 'checkout', '-q', 'main')
    const theirs = git(repo, 'rev-parse', branch)

    fs.writeFileSync(path.join(wt, 'feature.txt'), 'agent work\n')
    await actOnTaskWorkspace(taskId, 'pause')
    expect(git(repo, 'rev-parse', branch)).toBe(theirs)
    const notes = getComments(getDb(), taskId).map((c) => c.body)
    expect(notes.some((b) => b.includes('could not be brought into'))).toBe(true)
  })

  it('refuses a repository that uses Git LFS or submodules, with the reason', async () => {
    fs.writeFileSync(
      path.join(repo, '.gitattributes'),
      '*.psd filter=lfs diff=lfs merge=lfs -text\n',
    )
    git(repo, 'add', '.')
    git(repo, 'commit', '-q', '-m', 'lfs')
    const lfs = await provisionTaskWorkspace(newTask(), { repoPath: repo, kind: 'code' })
    expect(lfs).toMatchObject({ ok: false, reason: 'not_supported' })
    expect(!lfs.ok && 'why' in lfs && lfs.why).toMatch(/Git LFS/)

    fs.rmSync(path.join(repo, '.gitattributes'))
    fs.writeFileSync(path.join(repo, '.gitmodules'), '[submodule "x"]\n\tpath = x\n\turl = ../x\n')
    git(repo, 'add', '-A')
    git(repo, 'commit', '-q', '-m', 'submodule')
    const sub = await provisionTaskWorkspace(newTask(), { repoPath: repo, kind: 'code' })
    expect(sub).toMatchObject({ ok: false, reason: 'not_supported' })
    expect(!sub.ok && 'why' in sub && sub.why).toMatch(/submodules/)
    expect(fs.existsSync(path.join(work, 'worktrees'))).toBe(false)
  })

  it('rebuilds a task begun before isolation from the branch in the user repository', async () => {
    // The task branch exists only in the user's repository (no mirror yet).
    const taskId = newTask()
    const branch = `clawboo/task-${taskId}`
    const prov = await provisionTaskWorkspace(taskId, { repoPath: repo, kind: 'code' })
    if (!prov.ok) throw new Error(prov.reason)
    fs.writeFileSync(path.join(prov.worktree.worktreePath, 'early.txt'), 'early\n')
    await actOnTaskWorkspace(taskId, 'pause')
    fs.rmSync(mirrorPathFor(repo), { recursive: true, force: true })

    const resumed = await resumeTaskWorkspace(taskId, { repoPath: repo })
    expect(resumed.ok).toBe(true)
    if (!resumed.ok) return
    expect(fs.readFileSync(path.join(resumed.worktree.worktreePath, 'early.txt'), 'utf8')).toBe(
      'early\n',
    )
    expect(git(mirrorPathFor(repo), 'rev-parse', branch)).toBe(git(repo, 'rev-parse', branch))
    expect(worktreeList(repo)).not.toContain(resumed.worktree.worktreePath)
  })

  it('GC sweeps checkouts through the mirror and brings an autosave over', async () => {
    const taskId = newTask()
    const prov = await provisionTaskWorkspace(taskId, { repoPath: repo, kind: 'code' })
    if (!prov.ok) throw new Error(prov.reason)
    const { worktreePath: wt, branch } = prov.worktree
    fs.writeFileSync(path.join(wt, 'feature.txt'), 'unsaved\n')
    // Not active, so the sweep may reap it.
    updateStatus(getDb(), taskId, 'blocked')

    const r = await gcTaskWorkspaces({ maxCount: 0 })
    expect(r.reaped).toContain(taskId)
    expect(fs.existsSync(wt)).toBe(false)
    // Removed as a worktree of the mirror, by the agent host.
    expect(
      spawned.some(
        (s) =>
          s.cwd === mirrorPathFor(repo) &&
          s.argv.join(' ').includes(`worktree remove --force ${wt}`),
      ),
    ).toBe(true)
    expect(getWorkspaceForTask(getDb(), taskId)?.status).toBe('stale')
    expect(git(repo, 'show', `refs/heads/${branch}:feature.txt`)).toBe('unsaved')
    expectNoServerGitInAgentSpace()
  })

  it('the reviewer gets a detached checkout made from the mirror', async () => {
    const taskId = newTask()
    const prov = await provisionTaskWorkspace(taskId, { repoPath: repo, kind: 'code' })
    if (!prov.ok) throw new Error(prov.reason)
    fs.writeFileSync(path.join(prov.worktree.worktreePath, 'feature.txt'), 'review me\n')
    const mirror = mirrorPathFor(repo)
    let reviewedIn: string | null = null
    let listedInMirror = false
    const verdict = await verifyTask({
      db: getDb(),
      taskId,
      repoPath: repo,
      checkoutRepoPath: mirror,
      worktree: prov.worktree,
      diffStat: { filesChanged: 1, insertions: 1, deletions: 0, dirty: true },
      verifyCommand: 'exit 0',
      reviewRootDir: path.join(work, 'reviews', 'x'),
      riskFlag: true,
      makeReviewerAdapter: (ctx: RuntimeRunContext) => {
        reviewedIn = ctx.cwd ?? null
        listedInMirror = worktreeList(mirror).includes(`worktree ${ctx.cwd}`)
        return new FakeReviewer()
      },
    })
    expect(verdict.attempts.at(-1)?.critic).toMatchObject({ ran: true, outcome: 'reviewed' })
    expect(inWork(reviewedIn ?? '')).toBe(true)
    expect(listedInMirror).toBe(true)
    expect(spawned.some((s) => s.argv.includes('--detach'))).toBe(true)
    expectNoServerGitInAgentSpace()
  })

  it('reviews nothing but a commit id', async () => {
    let started = false
    const critic = await runCritic({
      repoPath: mirrorPathFor(repo),
      reviewSha: `--output=${path.join(dir, 'victim')}`,
      diffStat: { filesChanged: 1, insertions: 1, deletions: 0 },
      hasParent: false,
      riskFlag: true,
      reviewRootDir: path.join(work, 'reviews', 'z'),
      makeReviewerAdapter: () => {
        started = true
        return new FakeReviewer()
      },
    })
    expect(critic).toMatchObject({ ran: true, outcome: 'errored' })
    expect(critic.findings[0]?.body).toMatch(/not a commit id/)
    expect(started).toBe(false)
  })

  it('refuses to make a review checkout from a repository outside the work folder', async () => {
    const sha = git(repo, 'rev-parse', 'HEAD')
    let started = false
    const critic = await runCritic({
      repoPath: repo,
      reviewSha: sha,
      diffStat: { filesChanged: 1, insertions: 1, deletions: 0 },
      hasParent: false,
      riskFlag: true,
      reviewRootDir: path.join(work, 'reviews', 'y'),
      makeReviewerAdapter: () => {
        started = true
        return new FakeReviewer()
      },
    })
    expect(critic).toMatchObject({ ran: true, outcome: 'errored' })
    expect(critic.findings[0]?.body).toMatch(/not one/)
    expect(started).toBe(false)
    expect(worktreeList(repo)).not.toContain('reviews')
  })

  /** A task provisioned with isolation off, under another work folder, as
   *  before isolation was turned on. Isolation is on again on return. */
  async function taskFromBeforeIsolation(): Promise<{
    taskId: string
    old: string
    branch: string
  }> {
    vi.stubEnv('CLAWBOO_AGENT_USER', '')
    vi.stubEnv('CLAWBOO_WORK_DIR', path.join(dir, 'old-work'))
    const taskId = newTask()
    const prov = await provisionTaskWorkspace(taskId, { repoPath: repo, kind: 'code' })
    if (!prov.ok) throw new Error(prov.reason)
    vi.stubEnv('CLAWBOO_WORK_DIR', work)
    vi.stubEnv('CLAWBOO_AGENT_USER', 'clawboo-agent')
    return { taskId, old: prov.worktree.worktreePath, branch: prov.worktree.branch }
  }

  it('a rebuild that fails with the branch there is not read as a missing branch', async () => {
    const taskId = newTask()
    const prov = await provisionTaskWorkspace(taskId, { repoPath: repo, kind: 'code' })
    if (!prov.ok) throw new Error(prov.reason)
    const { worktreePath: wt, branch } = prov.worktree
    fs.writeFileSync(path.join(wt, 'feature.txt'), 'committed by the pause\n')
    await actOnTaskWorkspace(taskId, 'pause')
    const tip = git(mirrorPathFor(repo), 'rev-parse', branch)

    failWhen = (argv) => argv.includes('worktree') && argv.includes('add')
    const resumed = await resumeTaskWorkspace(taskId, { repoPath: repo })
    expect(resumed).toMatchObject({ ok: false, reason: 'rebuild_failed', worktreePath: wt })
    expect(!resumed.ok && 'why' in resumed && resumed.why).toMatch(/did not answer/)
    expect(git(mirrorPathFor(repo), 'rev-parse', branch)).toBe(tip)
    expect(git(repo, 'rev-parse', branch)).toBe(tip)
  })

  it('only a branch in neither repository lets the task start over', async () => {
    const taskId = newTask()
    const prov = await provisionTaskWorkspace(taskId, { repoPath: repo, kind: 'code' })
    if (!prov.ok) throw new Error(prov.reason)
    await actOnTaskWorkspace(taskId, 'pause')
    git(repo, 'branch', '-D', prov.worktree.branch)
    git(mirrorPathFor(repo), 'branch', '-D', prov.worktree.branch)
    expect(await resumeTaskWorkspace(taskId, { repoPath: repo })).toEqual({
      ok: false,
      reason: 'not_found',
    })
  })

  it('a fresh provision never resets the mirror branch past its own commits', async () => {
    const taskId = newTask()
    const prov = await provisionTaskWorkspace(taskId, { repoPath: repo, kind: 'code' })
    if (!prov.ok) throw new Error(prov.reason)
    const { worktreePath: wt, branch } = prov.worktree
    fs.writeFileSync(path.join(wt, 'feature.txt'), 'work\n')
    await actOnTaskWorkspace(taskId, 'pause')
    const tip = git(mirrorPathFor(repo), 'rev-parse', branch)

    const again = await provisionTaskWorkspace(taskId, { repoPath: repo, kind: 'code' })
    expect(again).toMatchObject({ ok: false, reason: 'unsafe_to_rebuild' })
    expect(!again.ok && 'why' in again && again.why).toMatch(/commits after the commit/)
    expect(git(mirrorPathFor(repo), 'rev-parse', branch)).toBe(tip)
  })

  it('turning isolation on saves and releases a checkout the server made before', async () => {
    const t = await taskFromBeforeIsolation()
    fs.writeFileSync(path.join(t.old, 'wip.txt'), 'uncommitted before isolation\n')
    expect(worktreeList(repo)).toContain(t.old)

    const resumed = await resumeTaskWorkspace(t.taskId, { repoPath: repo })
    expect(resumed.ok).toBe(true)
    if (!resumed.ok) return
    // The old checkout's work is on the branch and in the new checkout, and the
    // old checkout no longer holds the branch in the user's repository.
    expect(fs.existsSync(t.old)).toBe(false)
    expect(worktreeList(repo)).not.toContain(t.old)
    expect(inWork(resumed.worktree.worktreePath)).toBe(true)
    expect(fs.readFileSync(path.join(resumed.worktree.worktreePath, 'wip.txt'), 'utf8')).toBe(
      'uncommitted before isolation\n',
    )
    // So the work can come back.
    fs.writeFileSync(path.join(resumed.worktree.worktreePath, 'more.txt'), 'more\n')
    await actOnTaskWorkspace(t.taskId, 'pause')
    expect(git(repo, 'show', `${t.branch}:more.txt`)).toBe('more')
    expect(
      getComments(getDb(), t.taskId)
        .map((c) => c.body)
        .join('\n'),
    ).not.toMatch(/could not be brought/)
  })

  it('a server-made checkout that cannot be saved is refused, and kept', async () => {
    const t = await taskFromBeforeIsolation()
    git(t.old, 'checkout', '-q', '--detach')
    fs.writeFileSync(path.join(t.old, 'wip.txt'), 'only copy\n')
    const resumed = await resumeTaskWorkspace(t.taskId, { repoPath: repo })
    expect(resumed).toMatchObject({ ok: false, reason: 'unsafe_to_rebuild', worktreePath: t.old })
    expect(fs.readFileSync(path.join(t.old, 'wip.txt'), 'utf8')).toBe('only copy\n')
  })

  it('the drawer takes no diff in a server-made checkout outside the work folder', async () => {
    const t = await taskFromBeforeIsolation()
    fs.writeFileSync(path.join(t.old, 'feature.txt'), 'old work\n')
    // The branch reached the mirror (a rebuild began), but the row still names
    // the old checkout.
    const tip = git(repo, 'rev-parse', t.branch)
    await syncMirror(repo, tip)
    await runAgentGit(['-C', mirrorPathFor(repo), 'branch', t.branch, tip])
    localGit.length = 0

    const detail = await readWorktreeDetail(t.taskId)
    expect(detail.ok).toBe(true)
    expect(detail.diff).toBe('')
    expect(detail.diffStat).toBeNull()
    expect(localGit.filter((c) => c.cwd === t.old)).toEqual([])
  })

  it('a failed export on completion blocks the task instead of letting it land', async () => {
    const taskId = newTask()
    setSetting(getDb(), teamVerifyCommandSettingKey('team1'), JSON.stringify({ command: 'exit 0' }))
    const prov = await provisionTaskWorkspace(taskId, { repoPath: repo, kind: 'code' })
    if (!prov.ok) throw new Error(prov.reason)
    const { worktreePath: wt, branch } = prov.worktree
    fs.writeFileSync(path.join(wt, 'feature.txt'), 'agent work\n')
    // Someone committed to the task branch in their own repository.
    git(repo, 'checkout', '-q', '-b', branch)
    fs.writeFileSync(path.join(repo, 'theirs.txt'), 'theirs\n')
    git(repo, 'add', '.')
    git(repo, 'commit', '-q', '-m', 'theirs')
    git(repo, 'checkout', '-q', 'main')
    const theirs = git(repo, 'rev-parse', branch)

    const done = await actOnTaskWorkspace(taskId, 'complete')
    expect(done).toMatchObject({ ok: true, action: 'complete', taskStatus: 'blocked' })
    expect(done.ok && done.action === 'complete' && done.verified).toBeUndefined()
    expect(getTask(getDb(), taskId)?.status).toBe('blocked')
    expect(git(repo, 'rev-parse', branch)).toBe(theirs)
    const notes = getComments(getDb(), taskId).map((c) => c.body)
    expect(notes.some((b) => b.includes('blocked until a person'))).toBe(true)
  })

  it('resume carries commits made to the branch in the user repository past the agent copy', async () => {
    const taskId = newTask()
    const prov = await provisionTaskWorkspace(taskId, { repoPath: repo, kind: 'code' })
    if (!prov.ok) throw new Error(prov.reason)
    const { worktreePath: wt, branch } = prov.worktree
    fs.writeFileSync(path.join(wt, 'agent.txt'), 'agent\n')
    await actOnTaskWorkspace(taskId, 'pause')
    // Work committed on the branch in the user's repository afterwards, as the
    // save of a checkout the server made while agents ran as its user does.
    git(repo, 'checkout', '-q', branch)
    fs.writeFileSync(path.join(repo, 'theirs.txt'), 'theirs\n')
    git(repo, 'add', '.')
    git(repo, 'commit', '-q', '-m', 'theirs')
    git(repo, 'checkout', '-q', 'main')

    const resumed = await resumeTaskWorkspace(taskId, { repoPath: repo })
    expect(resumed.ok).toBe(true)
    if (!resumed.ok) return
    const at = resumed.worktree.worktreePath
    expect(fs.readFileSync(path.join(at, 'theirs.txt'), 'utf8')).toBe('theirs\n')
    expect(fs.readFileSync(path.join(at, 'agent.txt'), 'utf8')).toBe('agent\n')
    expect(git(mirrorPathFor(repo), 'rev-parse', branch)).toBe(git(repo, 'rev-parse', branch))
  })

  it('resume carries those commits in past a stale registration of the checkout', async () => {
    const taskId = newTask()
    const prov = await provisionTaskWorkspace(taskId, { repoPath: repo, kind: 'code' })
    if (!prov.ok) throw new Error(prov.reason)
    const { worktreePath: wt, branch } = prov.worktree
    fs.writeFileSync(path.join(wt, 'agent.txt'), 'agent\n')
    await actOnTaskWorkspace(taskId, 'pause')
    // The mirror still lists a checkout of the branch whose folder is gone.
    if (!fs.existsSync(wt)) git(mirrorPathFor(repo), 'worktree', 'add', '-q', wt, branch)
    fs.rmSync(wt, { recursive: true, force: true })
    git(repo, 'checkout', '-q', branch)
    fs.writeFileSync(path.join(repo, 'theirs.txt'), 'theirs\n')
    git(repo, 'add', '.')
    git(repo, 'commit', '-q', '-m', 'theirs')
    git(repo, 'checkout', '-q', 'main')

    const resumed = await resumeTaskWorkspace(taskId, { repoPath: repo })
    expect(resumed).toMatchObject({ ok: true })
    if (!resumed.ok) return
    expect(fs.readFileSync(path.join(resumed.worktree.worktreePath, 'theirs.txt'), 'utf8')).toBe(
      'theirs\n',
    )
  })

  it('resume keeps a branch the agent rewrote after an export', async () => {
    const taskId = newTask()
    const prov = await provisionTaskWorkspace(taskId, { repoPath: repo, kind: 'code' })
    if (!prov.ok) throw new Error(prov.reason)
    const { branch } = prov.worktree
    fs.writeFileSync(path.join(prov.worktree.worktreePath, 'agent.txt'), 'agent\n')
    await actOnTaskWorkspace(taskId, 'pause')
    const exported = git(repo, 'rev-parse', branch)
    const first = await resumeTaskWorkspace(taskId, { repoPath: repo })
    if (!first.ok) throw new Error('resume failed')
    // The agent rewrites the commit the export brought over.
    git(first.worktree.worktreePath, 'commit', '-q', '--amend', '-m', 'rewritten')
    const rewritten = git(mirrorPathFor(repo), 'rev-parse', branch)
    expect(rewritten).not.toBe(exported)

    // The user's branch is still where the export put it: the task's own.
    const again = await resumeTaskWorkspace(taskId, { repoPath: repo })
    expect(again).toMatchObject({ ok: true })
    expect(git(mirrorPathFor(repo), 'rev-parse', branch)).toBe(rewritten)
  })

  /** A commit on main in the user's repository that the mirror has as the base
   *  of another task, but that is no part of `taskId`'s branch. */
  async function anotherTasksBase(): Promise<string> {
    fs.writeFileSync(path.join(repo, 'later.txt'), 'later\n')
    git(repo, 'add', '.')
    git(repo, 'commit', '-q', '-m', 'later on main')
    const later = git(repo, 'rev-parse', 'HEAD')
    const other = await provisionTaskWorkspace(newTask('Another task'), {
      repoPath: repo,
      kind: 'code',
    })
    if (!other.ok) throw new Error(other.reason)
    expect(git(mirrorPathFor(repo), 'cat-file', '-t', later)).toBe('commit')
    return later
  }

  it("never replaces a user branch moved to a commit only another task's branch has", async () => {
    const taskId = newTask()
    const prov = await provisionTaskWorkspace(taskId, { repoPath: repo, kind: 'code' })
    if (!prov.ok) throw new Error(prov.reason)
    const { worktreePath: wt, branch } = prov.worktree
    fs.writeFileSync(path.join(wt, 'feature.txt'), 'agent work\n')
    const later = await anotherTasksBase()
    git(repo, 'branch', branch, later)

    await actOnTaskWorkspace(taskId, 'pause')
    expect(git(repo, 'rev-parse', branch)).toBe(later)
    const notes = getComments(getDb(), taskId).map((c) => c.body)
    expect(notes.some((b) => b.includes('could not be brought into'))).toBe(true)
  })

  it('an empty completion keeps a user branch moved to a commit the task did not put there', async () => {
    const taskId = newTask()
    const prov = await provisionTaskWorkspace(taskId, { repoPath: repo, kind: 'code' })
    if (!prov.ok) throw new Error(prov.reason)
    const { branch } = prov.worktree
    await actOnTaskWorkspace(taskId, 'pause')
    expect((await resumeTaskWorkspace(taskId, { repoPath: repo })).ok).toBe(true)
    const later = await anotherTasksBase()
    git(repo, 'branch', '-f', branch, later)

    const done = await actOnTaskWorkspace(taskId, 'complete')
    expect(done.ok && done.action === 'complete' && done.complete.cleaned).toBe(true)
    expect(git(repo, 'rev-parse', branch)).toBe(later)
  })

  it("never replaces a user branch the agent's copy says it exported", async () => {
    const taskId = newTask()
    const prov = await provisionTaskWorkspace(taskId, { repoPath: repo, kind: 'code' })
    if (!prov.ok) throw new Error(prov.reason)
    const { worktreePath: wt, branch } = prov.worktree
    fs.writeFileSync(path.join(wt, 'feature.txt'), 'agent work\n')
    const later = await anotherTasksBase()
    git(repo, 'branch', branch, later)
    // The agent can write its own copy: it says the last export put the
    // user's branch where it is now.
    git(mirrorPathFor(repo), 'update-ref', `refs/clawboo-exported/${branch}`, later)

    await actOnTaskWorkspace(taskId, 'pause')
    expect(git(repo, 'rev-parse', branch)).toBe(later)
    const notes = getComments(getDb(), taskId).map((c) => c.body)
    expect(notes.some((b) => b.includes('could not be brought into'))).toBe(true)
  })

  it("an empty completion keeps a user branch the agent's copy says it exported", async () => {
    const taskId = newTask()
    const prov = await provisionTaskWorkspace(taskId, { repoPath: repo, kind: 'code' })
    if (!prov.ok) throw new Error(prov.reason)
    const { branch } = prov.worktree
    await actOnTaskWorkspace(taskId, 'pause')
    expect((await resumeTaskWorkspace(taskId, { repoPath: repo })).ok).toBe(true)
    const later = await anotherTasksBase()
    git(repo, 'branch', '-f', branch, later)
    git(mirrorPathFor(repo), 'update-ref', `refs/clawboo-exported/${branch}`, later)

    const done = await actOnTaskWorkspace(taskId, 'complete')
    expect(done.ok && done.action === 'complete' && done.complete.cleaned).toBe(true)
    expect(git(repo, 'rev-parse', branch)).toBe(later)
  })

  it("an empty completion keeps a user commit that the agent's checkout reverted", async () => {
    const taskId = newTask()
    const prov = await provisionTaskWorkspace(taskId, { repoPath: repo, kind: 'code' })
    if (!prov.ok) throw new Error(prov.reason)
    const { branch } = prov.worktree
    await actOnTaskWorkspace(taskId, 'pause')
    // The user commits on top of the exported branch, and resume carries it in.
    git(repo, 'checkout', '-q', branch)
    fs.writeFileSync(path.join(repo, 'theirs.txt'), 'theirs\n')
    git(repo, 'add', '.')
    git(repo, 'commit', '-q', '-m', 'theirs')
    git(repo, 'checkout', '-q', 'main')
    const theirs = git(repo, 'rev-parse', branch)
    const resumed = await resumeTaskWorkspace(taskId, { repoPath: repo })
    if (!resumed.ok) throw new Error('resume failed')
    expect(git(mirrorPathFor(repo), 'rev-parse', branch)).toBe(theirs)
    // The agent's checkout drops the file, so the task has nothing to land.
    fs.rmSync(path.join(resumed.worktree.worktreePath, 'theirs.txt'))

    const done = await actOnTaskWorkspace(taskId, 'complete')
    expect(done.ok && done.action === 'complete' && done.complete.cleaned).toBe(true)
    expect(git(repo, 'rev-parse', branch)).toBe(theirs)
  })

  it('resume never runs git as the server in a checkout the mirror names outside the work folder', async () => {
    const taskId = newTask()
    const prov = await provisionTaskWorkspace(taskId, { repoPath: repo, kind: 'code' })
    if (!prov.ok) throw new Error(prov.reason)
    const { worktreePath: wt, branch } = prov.worktree
    fs.writeFileSync(path.join(wt, 'agent.txt'), 'agent\n')
    await actOnTaskWorkspace(taskId, 'pause')
    git(repo, 'checkout', '-q', branch)
    fs.writeFileSync(path.join(repo, 'theirs.txt'), 'theirs\n')
    git(repo, 'add', '.')
    git(repo, 'commit', '-q', '-m', 'theirs')
    git(repo, 'checkout', '-q', 'main')
    // The agent registers a checkout of the branch in a folder outside the
    // work folder, one that exists.
    const outside = path.join(dir, 'outside')
    git(mirrorPathFor(repo), 'worktree', 'add', '-q', outside, branch)
    localGit = []

    // The rebuild then refuses, as the branch is checked out there.
    expect(await resumeTaskWorkspace(taskId, { repoPath: repo })).toMatchObject({ ok: false })
    // Nothing ran there as the server, and nothing in it moved.
    expect(localGit.filter((c) => c.cwd === outside)).toEqual([])
    expect(fs.existsSync(path.join(outside, 'theirs.txt'))).toBe(false)
    expect(git(mirrorPathFor(repo), 'rev-parse', branch)).toBe(git(repo, 'rev-parse', branch))
  })

  it('a completion whose run lost the task while its work was brought over leaves the task be', async () => {
    const taskId = newTask()
    setSetting(getDb(), teamVerifyCommandSettingKey('team1'), JSON.stringify({ command: 'exit 0' }))
    const run = createExecutionProcess(getDb(), { taskId, executorType: 'claude-code' })
    const prov = await provisionTaskWorkspace(taskId, { repoPath: repo, kind: 'code' })
    if (!prov.ok) throw new Error(prov.reason)
    fs.writeFileSync(path.join(prov.worktree.worktreePath, 'feature.txt'), 'agent work\n')
    // While the bundle is read from agent space, a person retries the task and
    // a newer run takes it.
    const request = h.client.request.bind(h.client)
    let taken = false
    vi.spyOn(h.client, 'request').mockImplementation((req, o) => {
      const p = (req as { path?: string }).path ?? ''
      if (req.op === 'fs.read' && p.endsWith('.bundle') && !taken) {
        taken = true
        completeExecutionProcess(getDb(), run.id, { status: 'cancelled' })
        createExecutionProcess(getDb(), { taskId, executorType: 'claude-code' })
      }
      return request(req, o)
    })

    const done = await actOnTaskWorkspace(taskId, 'complete', { runId: run.id })
    expect(taken).toBe(true)
    expect(done).toMatchObject({ ok: true, action: 'complete', superseded: true })
    expect(done.ok && done.action === 'complete' && done.verified).toBeUndefined()
    expect(getTask(getDb(), taskId)?.status).toBe('in_progress')
  })

  it('GC never prunes the user repository', async () => {
    const taskId = newTask()
    const prov = await provisionTaskWorkspace(taskId, { repoPath: repo, kind: 'code' })
    if (!prov.ok) throw new Error(prov.reason)
    // A checkout of the user's repository the server cannot see right now.
    const hidden = path.join(dir, 'elsewhere')
    git(repo, 'worktree', 'add', '-q', '-b', 'elsewhere', hidden)
    fs.rmSync(hidden, { recursive: true, force: true })
    // The server's own old root for this repository is swept too.
    fs.mkdirSync(path.join(dir, 'data', 'worktrees', repoHash(repo)), { recursive: true })

    await gcTaskWorkspaces({})
    expect(worktreeList(repo)).toContain(hidden)
  })
})
