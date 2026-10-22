/**
 * apps/web/server/lib/openclawRepair.ts
 *
 * Reads why an OpenClaw Gateway launch failed, and runs the repair OpenClaw
 * asks for when that is `openclaw doctor --fix`.
 *
 * After an OpenClaw upgrade the Gateway can refuse to start until its data is
 * migrated, printing for example:
 *
 *   Gateway failed to start: Legacy workspace setup state requires migration
 *   for ~/.openclaw/workspace; run openclaw doctor --fix..
 *
 * Users start the Gateway from Clawboo, so Clawboo runs that repair for them
 * once and tries again, instead of leaving a Retry button that can never work.
 *
 * The repair is run as `openclaw doctor --fix --non-interactive` with
 * OPENCLAW_SERVICE_REPAIR_POLICY=external:
 *   - `--fix` applies OpenClaw's recommended repairs, including the migration.
 *   - `--non-interactive` skips anything that would need a person (it also
 *     stops doctor offering to add shell completion to a profile).
 *   - the `external` policy tells doctor not to install, load or restart a
 *     launchd/systemd Gateway service. Clawboo runs its own Gateway process,
 *     and a service started behind its back would fight it for the port.
 * Checked against OpenClaw 2026.9.2: from a sandboxed legacy workspace it
 * migrates the state, exits 0 in a few seconds, and the Gateway then starts.
 */
import { spawn } from 'node:child_process'

import { liveCwd } from './cwdGuard'
import { isWindows } from './platform'
import { killProcessTree } from './runtimes/killTree'

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g

/** OpenClaw's own statements that a launch failed, most specific first. */
const FAILURE_PATTERNS: RegExp[] = [
  /Gateway failed to start:\s*(.+)$/,
  /Could not start the CLI\.\s*Reason:\s*(.+)$/,
]

const DOCTOR_FIX = /\bdoctor\s+--fix\b/i

/** How long the repair may run. It took seconds in testing; a large state can be slower. */
export const DOCTOR_TIMEOUT_MS = 5 * 60_000

/**
 * The reason a Gateway launch failed, from the lines it wrote, or null when it
 * wrote no explicit failure. Takes the LAST matching line, since an earlier
 * launch's failure may share the log.
 */
export function gatewayFailureReason(logText: string): string | null {
  const lines = logText.replace(ANSI, '').split(/\r?\n/)
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim()
    for (const pattern of FAILURE_PATTERNS) {
      const m = pattern.exec(line)
      if (m) {
        // OpenClaw appends a generic diagnostics pointer to the reason; keep the reason.
        return m[1]!
          .replace(/\s*Run openclaw gateway status --deep for diagnostics\.?\s*$/i, '')
          .replace(/\.{2,}$/, '.')
          .trim()
      }
    }
  }
  return null
}

/**
 * Whether the failure is one `openclaw doctor --fix` repairs. Only the failure
 * line counts when there is one: a healthy startup can also mention doctor in
 * passing, and that is not a request to run it.
 */
export function needsDoctorFix(logText: string): boolean {
  const reason = gatewayFailureReason(logText)
  return DOCTOR_FIX.test(reason ?? logText.replace(ANSI, ''))
}

export interface DoctorFixResult {
  ok: boolean
  /** The exit code, or null when it was killed or could not start. */
  code: number | null
  /** Why it did not succeed, for the person reading the error. */
  error?: string
}

export interface DoctorFixDeps {
  spawn?: typeof spawn
  timeoutMs?: number
}

/**
 * Run `openclaw doctor --fix --non-interactive`, streaming its output lines.
 * Never throws.
 */
export function runDoctorFix(
  openclawPath: string,
  onLine: (line: string) => void,
  deps: DoctorFixDeps = {},
): Promise<DoctorFixResult> {
  const doSpawn = deps.spawn ?? spawn
  const timeoutMs = deps.timeoutMs ?? DOCTOR_TIMEOUT_MS
  return new Promise((resolve) => {
    let settled = false
    const settle = (result: DoctorFixResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }

    let child: ReturnType<typeof spawn>
    try {
      // `shell: isWindows` + `windowsHide: isWindows`: the path is openclaw.cmd
      // on Windows, which Node refuses to spawn without a shell (CVE-2024-27980).
      // Detached so the timeout can stop doctor and anything it started.
      child = doSpawn(openclawPath, ['doctor', '--fix', '--non-interactive'], {
        cwd: liveCwd(),
        env: { ...process.env, OPENCLAW_SERVICE_REPAIR_POLICY: 'external', NO_COLOR: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: !isWindows,
        shell: isWindows,
        windowsHide: isWindows,
      })
    } catch (err) {
      resolve({ ok: false, code: null, error: err instanceof Error ? err.message : String(err) })
      return
    }

    const timer = setTimeout(() => {
      killProcessTree(child)
      settle({ ok: false, code: null, error: 'openclaw doctor --fix did not finish in time' })
    }, timeoutMs)
    timer.unref?.()

    let lastLine = ''
    const forward = (chunk: Buffer): void => {
      for (const raw of chunk.toString().replace(ANSI, '').split(/\r?\n/)) {
        const line = raw.trimEnd()
        // Doctor draws boxes; a line that is only box edges carries nothing.
        const text = line.replace(/^[\s│├└┌◇╭╰─╮╯]+|[\s│╮╯─]+$/g, '')
        if (!text) continue
        lastLine = text
        onLine(line)
      }
    }
    child.stdout?.on('data', forward)
    child.stderr?.on('data', forward)

    child.on('error', (err) => settle({ ok: false, code: null, error: String(err) }))
    child.on('close', (code) => {
      if (code === 0) settle({ ok: true, code })
      else
        settle({
          ok: false,
          code,
          error: lastLine || `openclaw doctor --fix exited with code ${code}`,
        })
    })
  })
}
