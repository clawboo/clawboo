// The deterministic gate — the STRONGEST verification signal (an exit code, not a
// judgement). Runs the task's configured verify command (build/test/lint) in its
// isolated worktree and returns a typed result. Evidence (the command + a scrubbed
// output tail) is appended to VERIFICATION.md. No regex-scraping of meaning: we
// read the exit code, period.

import { spawn } from 'node:child_process'
import { appendFile, readFile } from 'node:fs/promises'
import path from 'node:path'

import { scrubResultSummary } from '@clawboo/db'
import {
  deterministicResultSchema,
  parseVerifyCommand,
  parseVerifyCommandFromVerificationMd,
  type DeterministicResult,
} from '@clawboo/governance'
import { SOR_FILES } from '@clawboo/worktrees'

import { buildChildEnv } from '../runtimes/childEnv'
import { isWindows } from '../platform'
import { killProcessTree } from '../runtimes/killTree'

const DEFAULT_TIMEOUT_MS = 10 * 60_000
const TAIL_CHARS = 4_000

export interface DeterministicGateInput {
  worktreePath: string
  /** Explicit override; else parsed from init.sh → VERIFICATION.md. */
  verifyCommand?: string | null
  timeoutMs?: number
  /**
   * Injectable env (tests); defaults to a SCRUBBED child env (`buildChildEnv()` —
   * clawboo's own server secrets removed). The verify command is model/worktree-
   * authored (parsed from init.sh), so it is a semi-trusted spawn and must get the
   * same secret-scrub every other runtime child gets — never the raw process.env.
   */
  env?: NodeJS.ProcessEnv
}

async function resolveVerifyCommand(
  worktreePath: string,
  override?: string | null,
): Promise<string | null> {
  if (override && override.trim()) return override.trim()
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

async function appendEvidence(
  worktreePath: string,
  det: DeterministicResult,
  at: number,
): Promise<void> {
  const block = [
    '',
    `### Gate run — ${new Date(at).toISOString()}`,
    '',
    `- Command: \`${det.command}\``,
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
  const command = await resolveVerifyCommand(input.worktreePath, input.verifyCommand)
  if (!command) {
    return deterministicResultSchema.parse({
      command: '(none configured)',
      exitCode: null,
      passed: false,
      stdoutTail: '',
      stderrTail:
        'No verify command configured (set VERIFY_CMD in init.sh). Cannot certify "done".',
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
      cwd: input.worktreePath,
      env: input.env ?? buildChildEnv(),
      shell: true,
      windowsHide: isWindows,
      // POSIX: process-group leader so a timeout kills the whole subtree (the
      // shell spawns the real test runner — killing only /bin/sh would orphan it).
      detached: !isWindows,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const timer = setTimeout(() => {
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
      clearTimeout(timer)
      resolve({ exitCode: null, stdout, stderr: `${stderr}\n${String(err)}`, timedOut })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ exitCode: code, stdout, stderr, timedOut })
    })
  })

  const det = deterministicResultSchema.parse({
    command,
    exitCode: run.exitCode,
    passed: run.exitCode === 0 && !run.timedOut,
    stdoutTail: scrubResultSummary(run.stdout, TAIL_CHARS),
    stderrTail: scrubResultSummary(run.stderr, TAIL_CHARS),
    durationMs: Date.now() - startedAt,
    timedOut: run.timedOut,
  })
  await appendEvidence(input.worktreePath, det, startedAt)
  return det
}
