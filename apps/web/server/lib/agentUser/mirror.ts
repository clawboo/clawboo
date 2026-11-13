// Task checkouts under agent isolation (design 4.9): an agent-owned mirror of
// each repository, kept in step with git bundles.
//
// Without isolation a task's checkout is a worktree of the user's repository,
// sharing its `.git`: hooks, config and refs. An agent that can commit there
// could plant a hook that runs as the user the next time anyone runs git. So
// with isolation the agent gets its own bare copy, owned by the agent user, and
// only DATA crosses between the two:
//
// - In: the server bundles the base commit from the user's repository (as
//   itself, in a repository it trusts) and the host fetches the bundle into the
//   mirror. The first sync carries the history; later ones only what is new.
// - Work: the checkout is a worktree of the mirror. Agent hooks run as the agent.
// - Out: the host bundles the task branch from the mirror; the server verifies
//   the bundle and fetches it into the user's repository under the task's
//   branch name. A bundle is data: fetching one runs nothing from it.

import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { StringDecoder } from 'node:string_decoder'

import { resolveClawbooDir } from '@clawboo/config'
import { execGit, GitError } from '@clawboo/worktrees'

import { buildChildEnv } from '../runtimes/childEnv'
import { spawnAgentProcess } from '../runtimes/spawner'
import { repoHash, workDirInUse } from '../workDir'
import {
  agentAppendFile,
  agentMkdir,
  agentReadFile,
  agentRemove,
  agentStat,
  agentWriteFile,
} from './agentFs'

/** How much of a bundle moves per host call. */
const CHUNK = 4 * 1024 * 1024
/** A bundle larger than this is refused rather than copied. */
const MAX_BUNDLE_BYTES = 4 * 1024 * 1024 * 1024
/** How much of git's output an agent-side call keeps. */
export const AGENT_GIT_OUTPUT_CHARS = 1024 * 1024
/** Synced base refs kept in a mirror, newest first, so the next sync has a "have". */
const KEEP_BASE_REFS = 20

export class MirrorError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MirrorError'
  }
}

/** `<work>/mirrors/<repo hash>.git`. */
export function mirrorPathFor(repoPath: string, workDir: string = workDirInUse()): string {
  return path.join(workDir, 'mirrors', `${repoHash(repoPath)}.git`)
}

/** Run git as the agent user. Resolves to stdout; rejects with git's stderr. */
export async function runAgentGit(
  args: string[],
  opts: { cwd?: string; timeoutMs?: number } = {},
): Promise<string> {
  return (await runAgentGitDetailed(args, opts)).out
}

/**
 * Run git as the agent user. `truncated`: stdout went past
 * {@link AGENT_GIT_OUTPUT_CHARS} and the rest was dropped. A character split
 * across two chunks is decoded whole.
 */
export function runAgentGitDetailed(
  args: string[],
  opts: { cwd?: string; timeoutMs?: number } = {},
): Promise<{ out: string; truncated: boolean }> {
  return new Promise((resolve, reject) => {
    const child = spawnAgentProcess({
      kind: 'git',
      command: 'git',
      args,
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
      env: buildChildEnv({ GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' }),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const outDec = new StringDecoder('utf8')
    const errDec = new StringDecoder('utf8')
    let out = ''
    let err = ''
    let truncated = false
    child.stdout?.on('data', (d: Buffer) => {
      if (truncated) return
      out += outDec.write(d)
      if (out.length > AGENT_GIT_OUTPUT_CHARS) {
        out = out.slice(0, AGENT_GIT_OUTPUT_CHARS)
        truncated = true
      }
    })
    child.stderr?.on('data', (d: Buffer) => {
      if (err.length < AGENT_GIT_OUTPUT_CHARS) err += errDec.write(d)
    })
    const timer = setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs ?? 10 * 60_000)
    timer.unref?.()
    child.on('error', (e) => {
      clearTimeout(timer)
      reject(new MirrorError(`git ${args[0] === '-C' ? args[2] : args[0]}: ${e.message}`))
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (!truncated) out += outDec.end()
      if (code === 0) resolve({ out, truncated })
      else {
        const why = (err + errDec.end()).trim().slice(0, 2000)
        reject(new MirrorError(`git ${args.join(' ')} failed (${code}): ${why}`))
      }
    })
  })
}

async function agentGitOk(args: string[]): Promise<boolean> {
  try {
    await runAgentGit(args)
    return true
  } catch {
    return false
  }
}

/** A private folder of the server's for bundles on their way in or out. */
function serverBundleDir(): string {
  const dir = path.join(resolveClawbooDir(), 'tmp', 'bundles')
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  return dir
}

const SHA_RE = /^[0-9a-f]{40}([0-9a-f]{24})?$/

/** Copy a file of the server's into agent space, in chunks, through the host. */
async function copyToAgent(from: string, to: string): Promise<void> {
  const fd = fs.openSync(from, 'r')
  try {
    const buf = Buffer.alloc(CHUNK)
    let pos = 0
    let first = true
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, pos)
      if (n === 0 && !first) break
      if (first) await agentWriteFile(to, buf.subarray(0, n), { mode: 0o600 })
      else await agentAppendFile(to, buf.subarray(0, n), { mode: 0o600 })
      first = false
      pos += n
      if (n === 0) break
    }
  } finally {
    fs.closeSync(fd)
  }
}

/** Copy a file from agent space to a private file of the server's, bounded. */
async function copyFromAgent(from: string, to: string): Promise<void> {
  const fd = fs.openSync(
    to,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
    0o600,
  )
  try {
    let pos = 0
    for (;;) {
      const chunk = await agentReadFile(from, { maxBytes: CHUNK, offset: pos })
      if (chunk === null) throw new MirrorError(`${from} disappeared while it was being copied`)
      if (chunk.length === 0) break
      fs.writeSync(fd, chunk)
      pos += chunk.length
      if (pos > MAX_BUNDLE_BYTES) throw new MirrorError('the task branch bundle is too large')
      if (chunk.length < CHUNK) break
    }
  } finally {
    fs.closeSync(fd)
  }
}

/** Make the mirror when it is missing. */
export async function ensureMirror(repoPath: string): Promise<string> {
  const mirror = mirrorPathFor(repoPath)
  const st = await agentStat(mirror)
  if (st && st.type !== 'dir') throw new MirrorError(`${mirror} is not a folder`)
  if (!st) {
    await agentMkdir(path.dirname(mirror))
    await runAgentGit(['init', '--bare', '--quiet', mirror])
  }
  return mirror
}

/**
 * Bring `baseSha` into the mirror of `repoPath`. Returns the mirror's path.
 * Incremental: commits the mirror already holds from earlier syncs are left
 * out of the bundle.
 */
export async function syncMirror(repoPath: string, baseSha: string): Promise<string> {
  if (!SHA_RE.test(baseSha)) throw new MirrorError(`not a commit id: ${baseSha}`)
  const mirror = await ensureMirror(repoPath)
  if (await agentGitOk(['-C', mirror, 'cat-file', '-e', `${baseSha}^{commit}`])) return mirror

  // What the mirror holds, as far as the user's repository also knows it.
  const have = (
    await runAgentGit([
      '-C',
      mirror,
      'for-each-ref',
      '--format=%(objectname)',
      'refs/clawboo/base/',
    ])
  )
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => SHA_RE.test(s))
  const excludes: string[] = []
  for (const sha of have) {
    try {
      await execGit(repoPath, ['cat-file', '-e', `${sha}^{commit}`])
      excludes.push(`^${sha}`)
    } catch {
      /* gone from the user's repository: cannot be a prerequisite */
    }
  }

  const tag = randomBytes(8).toString('hex')
  const ref = `refs/clawboo-sync/${tag}`
  const bundle = path.join(serverBundleDir(), `in-${tag}.bundle`)
  const incoming = `${mirror}.in-${tag}.bundle`
  try {
    await execGit(repoPath, ['update-ref', ref, baseSha])
    try {
      await execGit(repoPath, ['bundle', 'create', '--quiet', bundle, ref, ...excludes])
    } finally {
      await execGit(repoPath, ['update-ref', '-d', ref]).catch(() => undefined)
    }
    await copyToAgent(bundle, incoming)
    await runAgentGit(['-C', mirror, 'bundle', 'verify', '--quiet', incoming])
    await runAgentGit([
      '-C',
      mirror,
      'fetch',
      '--quiet',
      incoming,
      `+${ref}:refs/clawboo/base/${baseSha}`,
    ])
  } finally {
    fs.rmSync(bundle, { force: true })
    await agentRemove(incoming).catch(() => undefined)
  }
  await pruneBaseRefs(mirror)
  return mirror
}

async function pruneBaseRefs(mirror: string): Promise<void> {
  const refs = (
    await runAgentGit([
      '-C',
      mirror,
      'for-each-ref',
      '--sort=-creatordate',
      '--format=%(refname)',
      'refs/clawboo/base/',
    ])
  )
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
  for (const ref of refs.slice(KEEP_BASE_REFS)) {
    await runAgentGit(['-C', mirror, 'update-ref', '-d', ref]).catch(() => undefined)
  }
}

/** The branch's commit in `repoPath`, or null when there is no such branch. */
async function userBranchTip(repoPath: string, ref: string): Promise<string | null> {
  try {
    const sha = (
      await execGit(repoPath, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])
    ).trim()
    if (!SHA_RE.test(sha)) throw new MirrorError(`${ref} in ${repoPath} is not a commit`)
    return sha
  } catch (err) {
    if (err instanceof GitError && err.exitCode === 1 && !err.stderr.trim()) return null
    throw err
  }
}

/** Throw unless no checkout of `repoPath` has `ref` checked out. A fetch into a
 *  checked-out branch is refused by git; `update-ref` is not, and moving the
 *  branch under someone's working tree would make their files look changed. */
async function refuseCheckedOut(repoPath: string, ref: string): Promise<void> {
  let at: string | null = null
  for (const line of (await execGit(repoPath, ['worktree', 'list', '--porcelain'])).split('\n')) {
    if (line.startsWith('worktree ')) at = line.slice('worktree '.length)
    else if (line === `branch ${ref}`) {
      throw new MirrorError(`${ref} is checked out at ${at ?? 'a checkout'} of ${repoPath}`)
    }
  }
}

/**
 * Bring a task branch out of the mirror into the user's repository, under the
 * same name. `baseSha` is where the task started: only commits after it travel.
 * Returns the branch tip now in the user's repository, or null when the branch
 * has nothing past the base (nothing to bring).
 *
 * `expected` is the branch's commit in the user's repository that the caller
 * decided may be replaced (null: there must be no such branch); absent, the one
 * it is at now. The branch moves only from that commit (compare-and-swap), so a
 * commit someone made to it meanwhile is never overwritten.
 */
export async function exportTaskBranch(
  repoPath: string,
  branch: string,
  baseSha: string,
  expected?: string | null,
): Promise<string | null> {
  if (!/^[A-Za-z0-9._/-]{1,200}$/.test(branch) || branch.includes('..')) {
    throw new MirrorError(`unsafe branch name: ${branch}`)
  }
  if (!SHA_RE.test(baseSha)) throw new MirrorError(`not a commit id: ${baseSha}`)
  if (expected != null && !SHA_RE.test(expected)) {
    throw new MirrorError(`not a commit id: ${expected}`)
  }
  const mirror = mirrorPathFor(repoPath)
  const tip = (
    await runAgentGit(['-C', mirror, 'rev-parse', '--verify', `refs/heads/${branch}^{commit}`])
  ).trim()
  if (!SHA_RE.test(tip)) throw new MirrorError(`the mirror has no branch ${branch}`)
  if (tip === baseSha) return null

  const want = `refs/heads/${branch}`
  const theirs = expected !== undefined ? expected : await userBranchTip(repoPath, want)
  await refuseCheckedOut(repoPath, want)

  const tag = randomBytes(8).toString('hex')
  const outgoing = `${mirror}.out-${tag}.bundle`
  const bundle = path.join(serverBundleDir(), `out-${tag}.bundle`)
  // Fetched under a name of its own first, so the branch itself moves in one
  // compare-and-swap below.
  const staged = `refs/clawboo-export/${tag}`
  try {
    await runAgentGit([
      '-C',
      mirror,
      'bundle',
      'create',
      '--quiet',
      outgoing,
      `refs/heads/${branch}`,
      `^${baseSha}`,
    ])
    await copyFromAgent(outgoing, bundle)
    // Checked by the server, in its own repository: the bundle must apply on
    // top of what the user's repository has, and carry exactly the branch.
    await execGit(repoPath, ['bundle', 'verify', '--quiet', bundle])
    const heads = (await execGit(repoPath, ['bundle', 'list-heads', bundle])).trim().split('\n')
    if (heads.length !== 1 || !heads[0]!.endsWith(` ${want}`) || heads[0]!.split(' ')[0] !== tip) {
      throw new MirrorError(`the bundle from the mirror does not hold exactly ${want}`)
    }
    // Every object the agent's commits bring is checked as it arrives: a
    // malformed one is refused, never stored in the user's repository.
    await execGit(repoPath, [
      '-c',
      'transfer.fsckObjects=true',
      '-c',
      'fetch.fsckObjects=true',
      'fetch',
      '--quiet',
      '--no-tags',
      bundle,
      `+${want}:${staged}`,
    ])
    try {
      // An empty old value: the branch must not exist yet.
      await execGit(repoPath, ['update-ref', want, tip, theirs ?? ''])
    } catch (err) {
      throw new MirrorError(
        `${want} in ${repoPath} changed while the task's work was being brought over, so it was left as it is (${err instanceof Error ? err.message : String(err)})`,
      )
    }
  } finally {
    await execGit(repoPath, ['update-ref', '-d', staged]).catch(() => undefined)
    fs.rmSync(bundle, { force: true })
    await agentRemove(outgoing).catch(() => undefined)
  }
  return tip
}
