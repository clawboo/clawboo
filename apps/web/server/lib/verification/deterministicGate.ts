// The deterministic gate — the STRONGEST verification signal (an exit code, not a
// judgement). Runs the task's configured verify command (build/test/lint) in its
// isolated worktree and returns a typed result. Evidence (the command + a scrubbed
// output tail) is appended to VERIFICATION.md. No regex-scraping of meaning: we
// read the exit code, period.
//
// The builder works in the same worktree the command is read from, so where the
// command came from is recorded with it (`commandSource`). A check the person set
// for the team is passed in and always wins. Without one, the worktree's command
// counts as clawboo's only while it matches the init.sh of the task's scaffold
// commit, read from the repository itself; anything else is the builder's own.
// This tells a cooperative builder's choice apart from clawboo's, and only a
// `configured` command is a guarantee: a reloaded worktree finds its scaffold
// commit by message (`findScaffoldCommit`), which the builder can also write,
// and an agent running as the same user can change any of these files.

import { spawn } from 'node:child_process'
import { appendFile, readFile } from 'node:fs/promises'
import path from 'node:path'

import { resolveClawbooDir } from '@clawboo/config'
import { scrubResultSummary } from '@clawboo/db'
import { setAwakeTimeout } from '@clawboo/executor'
import {
  deterministicResultSchema,
  parseVerifyCommand,
  parseVerifyCommandFromVerificationMd,
  type DeterministicResult,
  type VerifyCommandSource,
} from '@clawboo/governance'
import { execGit, SOR_FILES } from '@clawboo/worktrees'

import { buildChildEnv } from '../runtimes/childEnv'
import { isWindows } from '../platform'
import { killProcessTree } from '../runtimes/killTree'
import { realPathOf, workDirSpellings } from '../workDir'

const DEFAULT_TIMEOUT_MS = 10 * 60_000
const TAIL_CHARS = 4_000

export interface DeterministicGateInput {
  worktreePath: string
  /** A trusted check (the team's verify command). Wins over the worktree's
   *  files; else the command is parsed from init.sh, then VERIFICATION.md. */
  verifyCommand?: string | null
  /** The task's scaffold commit (`Worktree.baseCommit`), whose init.sh is the
   *  one clawboo wrote. Absent, a worktree command is attributed to the agent. */
  scaffoldCommit?: string | null
  /** The task's repository. The scaffold commit is read from here rather than
   *  through the worktree, whose `.git` pointer the builder can edit. */
  repoPath?: string | null
  timeoutMs?: number
  /** Append the run to VERIFICATION.md in the checkout. Default true; false for a
   *  team folder, whose files are the team's and not a task's record. */
  evidence?: boolean
  /**
   * Injectable env (tests); defaults to a SCRUBBED child env (`buildChildEnv()` —
   * clawboo's own server secrets removed). The verify command is model/worktree-
   * authored (parsed from init.sh), so it is a semi-trusted spawn and must get the
   * same secret-scrub every other runtime child gets — never the raw process.env.
   */
  env?: NodeJS.ProcessEnv
}

async function worktreeVerifyCommand(worktreePath: string): Promise<string | null> {
  try {
    const fromInit = parseVerifyCommand(
      await readFile(path.join(worktreePath, SOR_FILES.init), 'utf8'),
    )
    if (fromInit) return fromInit
  } catch {
    /* no init.sh */
  }
  try {
    return parseVerifyCommandFromVerificationMd(
      await readFile(path.join(worktreePath, SOR_FILES.verification), 'utf8'),
    )
  } catch {
    return null
  }
}

/** The VERIFY_CMD in init.sh as committed at `commit`, or null (none, the
 *  placeholder, or an unreadable commit). `--no-replace-objects` keeps a
 *  `refs/replace/<commit>` the builder created from standing in for it. */
export async function scaffoldVerifyCommand(
  gitDir: string,
  commit: string,
): Promise<string | null> {
  // A commit id only: anything else must never reach git's argv.
  if (!/^[0-9a-f]{7,64}$/i.test(commit)) return null
  try {
    return parseVerifyCommand(
      await execGit(gitDir, ['--no-replace-objects', 'show', `${commit}:${SOR_FILES.init}`]),
    )
  } catch {
    return null
  }
}

export async function resolveVerifyCommand(
  worktreePath: string,
  trusted?: string | null,
  scaffoldCommit?: string | null,
  repoPath?: string | null,
): Promise<{ command: string | null; source: VerifyCommandSource }> {
  if (trusted && trusted.trim()) return { command: trusted.trim(), source: 'configured' }
  const command = await worktreeVerifyCommand(worktreePath)
  if (!command) return { command: null, source: 'none' }
  const scaffolded = scaffoldCommit
    ? await scaffoldVerifyCommand(repoPath ?? worktreePath, scaffoldCommit)
    : null
  return { command, source: scaffolded !== null && scaffolded === command ? 'scaffold' : 'agent' }
}

async function appendEvidence(
  worktreePath: string,
  det: DeterministicResult,
  at: number,
): Promise<void> {
  const block = [
    '',
    `### Gate run — ${new Date(at).toISOString()}`,
    '',
    `- Command: \`${det.command}\`${det.commandSource ? ` (source: ${det.commandSource})` : ''}`,
    `- Result: ${det.passed ? 'PASS' : det.timedOut ? 'TIMED OUT' : 'FAIL'} (exit ${det.exitCode ?? 'null'}, ${det.durationMs}ms)`,
    '',
    '```text',
    (det.stdoutTail + (det.stderrTail ? `\n${det.stderrTail}` : '')).slice(0, TAIL_CHARS),
    '```',
    '',
  ].join('\n')
  try {
    await appendFile(path.join(worktreePath, SOR_FILES.verification), block, 'utf8')
  } catch {
    /* evidence is best-effort; the typed verdict on the task is the source of truth */
  }
}

/**
 * Run the task's verify command in its worktree. A missing/placeholder command is
 * a structured FAIL ("configure VERIFY_CMD") — `done` requires real evidence, not
 * the absence of a check. `shell: true` because the command is a free-form shell
 * string; `windowsHide` suppresses the console popup on win32 (repo convention).
 * The env defaults to `buildChildEnv()` (clawboo's own secrets scrubbed) so a
 * model-authored VERIFY_CMD can't exfiltrate the gateway/access/master-key secrets
 * — the same guarantee the runtime drivers already enforce.
 */
export async function runDeterministicGate(
  input: DeterministicGateInput,
): Promise<DeterministicResult> {
  // Every task and review checkout clawboo provisions lives inside its own state
  // directory, or, in the newer layout, under the work folder's `worktrees/` or
  // `reviews/`. The verify command is worktree-authored and runs through a
  // shell, so the directory it runs in, reads its command from, and appends
  // evidence to is confirmed to be in one of those first: a path that resolves
  // anywhere else is a broken record, not a place to run commands. The work
  // folder's team folders are not checkouts, so the rest of it does not count.
  //
  // The check is written out here rather than shared from a helper on purpose.
  // A helper that validates and then RETURNS the path hands the caller a value
  // that reads as unchecked, both to a reviewer skimming the call site and to
  // static analysis; keeping the test and the use in one place means the thing
  // being spawned into is visibly the thing that was just tested.
  //
  // Containment is a prefix test: the resolved path has to start with one of
  // the roots plus a trailing separator. The separator is what stops a sibling
  // that merely shares a root's spelling (`~/.clawboo-old` against
  // `~/.clawboo`) from reading as something inside it. A root itself does not
  // pass either, which is right: every checkout clawboo provisions lands below
  // one (`worktrees/<repo-hash>/<task-id>`), so a path arriving equal to a root
  // is the same broken record as one pointing outside, and earns the same
  // answer. The work folder counts in each of its spellings, so a checkout
  // recorded by the real path of a linked work folder passes too.
  //
  // The spelling is not the whole answer: a checkout folder that is a link to a
  // repository elsewhere passes that test, and the command would then run, and
  // the evidence land, in that repository. So when the folder exists, its real
  // path (every link resolved) has to be inside a root's real path too, and the
  // real path is what everything below uses. A missing folder keeps its
  // spelling, so the spawn fails and the attempt is recorded as a failure, as
  // it always was.
  const roots = [
    path.resolve(resolveClawbooDir()),
    ...workDirSpellings().flatMap((dir) => [
      path.join(dir, 'worktrees'),
      path.join(dir, 'reviews'),
    ]),
  ]
  const asPrefix = (root: string): string => (root.endsWith(path.sep) ? root : root + path.sep)
  const recordedPath = path.resolve(input.worktreePath)
  if (!roots.some((root) => recordedPath.startsWith(asPrefix(root)))) {
    throw new Error(
      `worktree path is outside the clawboo state directory and work folder: ${recordedPath}`,
    )
  }
  const realPath = realPathOf(recordedPath)
  if (realPath !== null) {
    const realRoots = roots.map(realPathOf).filter((root): root is string => root !== null)
    if (!realRoots.some((root) => realPath.startsWith(asPrefix(root)))) {
      throw new Error(
        `worktree path resolves outside the clawboo state directory and work folder: ${recordedPath} is ${realPath}`,
      )
    }
  }
  const worktreePath = realPath ?? recordedPath
  const { command, source: commandSource } = await resolveVerifyCommand(
    worktreePath,
    input.verifyCommand,
    input.scaffoldCommit,
    input.repoPath,
  )
  if (!command) {
    return deterministicResultSchema.parse({
      command: '(none configured)',
      commandSource,
      exitCode: null,
      passed: false,
      stdoutTail: '',
      stderrTail:
        'No verify command configured (set the team\'s verify command, or VERIFY_CMD in init.sh). Cannot certify "done".',
      durationMs: 0,
      timedOut: false,
    })
  }

  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const startedAt = Date.now()
  const run = await new Promise<{
    exitCode: number | null
    stdout: string
    stderr: string
    timedOut: boolean
  }>((resolve) => {
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const child = spawn(command, [], {
      cwd: worktreePath,
      env: input.env ?? buildChildEnv(),
      shell: true,
      windowsHide: isWindows,
      // POSIX: process-group leader so a timeout kills the whole subtree (the
      // shell spawns the real test runner — killing only /bin/sh would orphan it).
      detached: !isWindows,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    // Awake time: a sleep with the verify running is not the verify hanging, and a
    // plain timer would kill it on wake, fail the verdict and spend a fix attempt.
    const timer = setAwakeTimeout(() => {
      timedOut = true
      // Kill the whole tree (SIGTERM → SIGKILL), not just the shell wrapper.
      killProcessTree(child)
    }, timeoutMs)
    child.stdout?.on('data', (d) => {
      stdout += String(d)
    })
    child.stderr?.on('data', (d) => {
      stderr += String(d)
    })
    child.on('error', (err) => {
      timer.clear()
      resolve({ exitCode: null, stdout, stderr: `${stderr}\n${String(err)}`, timedOut })
    })
    child.on('close', (code) => {
      timer.clear()
      resolve({ exitCode: code, stdout, stderr, timedOut })
    })
  })

  const det = deterministicResultSchema.parse({
    command,
    commandSource,
    exitCode: run.exitCode,
    passed: run.exitCode === 0 && !run.timedOut,
    stdoutTail: scrubResultSummary(run.stdout, TAIL_CHARS),
    stderrTail: scrubResultSummary(run.stderr, TAIL_CHARS),
    durationMs: Date.now() - startedAt,
    timedOut: run.timedOut,
  })
  if (input.evidence !== false) await appendEvidence(worktreePath, det, startedAt)
  return det
}
