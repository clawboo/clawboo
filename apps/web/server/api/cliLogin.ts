// POST /api/auth/cli-login/:tool — UI-driven "Sign in with ChatGPT".
//
// Spawns the OFFICIAL CLI's login command locally and relays its USER-FACING
// output (device code / auth URL) to the UI over SSE. The OAuth exchange stays
// inside the vendor CLI; the human authorizes in their browser; clawboo never
// touches tokens (see cliLoginPlans.ts for the full posture + per-tool ground
// truth). Modeled on `runtimesInstallPOST` (SSE + piped child + kill-on-close =
// the KILLABLE lifetime — Cancel in the UI aborts the fetch, Express fires
// res.on('close'), the child tree dies), upgraded with:
//   - `killProcessTree` + `detached: !isWindows` (login CLIs spawn browser
//     helpers; a bare child.kill() would orphan them),
//   - a hard 16-minute cap (the CLIs' own device windows are 15 minutes),
//   - an in-flight registry: ONE login child per tool — a new POST kills the
//     previous tree first (Retry semantics),
//   - completion driven by RE-PROBING the real auth store (never the exit code
//     alone), mirroring finishInstall's re-probe.
// The stream is never persisted; device codes are ephemeral and user-facing.

import { spawn, type ChildProcess } from 'node:child_process'
import type { Request, Response } from 'express'

import { resolveStateDir } from '@clawboo/config'

import { isWindows } from '../lib/platform'
import { detectOauthProfileProviders } from '../lib/openclawEnv'
import {
  invalidateCodexAuthCache,
  isCodexLoggedIn,
  userCodexAuthPath,
} from '../lib/runtimes/codexAuth'
import { hasUsableCodexAuth } from '../lib/runtimes/codexDriver'
import { isHermesCodexAuthPresent } from '../lib/runtimes/hermesAuth'
import { resolveWindowsSpawn } from '../lib/runtimes/winSpawn'
import { killProcessTree } from '../lib/runtimes/killTree'
import {
  buildCliLoginPlan,
  createCliLoginParser,
  isCliLoginTool,
  stripAnsi,
  type CliLoginTool,
} from '../lib/runtimes/cliLoginPlans'

const LOGIN_TIMEOUT_MS = 16 * 60 * 1000 // the CLIs' own windows are 15 min
const STORE_WATCH_INTERVAL_MS = 3_000

function sendEvent(res: Response, data: Record<string, unknown>): void {
  if (!res.writableEnded) res.write(`data: ${JSON.stringify(data)}\n\n`)
}

/** One login child per tool. A new request REPLACES the old one (kill first) —
 *  Retry semantics; two browsers racing a login would otherwise interleave. */
const inFlight = new Map<CliLoginTool, ChildProcess>()

/** Post-run truth: is the tool actually signed in now? Probes the real store
 *  (never trusts the exit code — e.g. `script` can exit 0 around a failed CLI). */
async function probeLoggedIn(tool: CliLoginTool): Promise<boolean> {
  if (tool === 'codex') {
    invalidateCodexAuthCache()
    return isCodexLoggedIn()
  }
  if (tool === 'hermes') return isHermesCodexAuthPresent()
  return detectOauthProfileProviders(resolveStateDir()).has('openai-codex')
}

/** The cheap per-tick variant for the store watcher — pure file reads (the
 *  codex CLI probe would spawn a process every tick). Invalidates the codex
 *  cache so the host's follow-up re-check sees fresh truth. */
function watchTickLoggedIn(tool: CliLoginTool): boolean {
  try {
    if (tool === 'codex') {
      const present = hasUsableCodexAuth(userCodexAuthPath())
      if (present) invalidateCodexAuthCache()
      return present
    }
    if (tool === 'hermes') return isHermesCodexAuthPresent()
    return detectOauthProfileProviders(resolveStateDir()).has('openai-codex')
  } catch {
    return false
  }
}

export function cliLoginPOST(req: Request, res: Response): void {
  const tool = req.params['tool']
  if (!isCliLoginTool(tool)) {
    res.status(404).json({ error: `unknown login tool: ${String(tool)}` })
    return
  }

  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders()

  const planResult = buildCliLoginPlan(tool)
  if (!planResult.ok) {
    // Typed error the UI uses to degrade to the copy-command fallback.
    sendEvent(res, { type: 'error', code: planResult.code, message: planResult.message })
    res.end()
    return
  }
  const { plan } = planResult

  // Replace any previous in-flight login for this tool.
  const prev = inFlight.get(tool)
  if (prev && !prev.killed) killProcessTree(prev)

  sendEvent(res, {
    type: 'progress',
    step: 'starting',
    message: `Starting ${plan.displayCommand}…`,
  })

  // Windows .cmd/.bat shims (codex/hermes) route through the repo's safe spawn
  // planner — quoted + caret-escaped, NEVER `shell: true` (a bare shell spawn
  // misparses a resolved bin path containing a space, e.g. a spaced Windows
  // username). No-op on POSIX and for .exe targets.
  const winPlan = resolveWindowsSpawn({ command: plan.command, args: plan.args })

  let child: ChildProcess
  try {
    child = spawn(winPlan.command, winPlan.args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: plan.env,
      // Process-group leader so Cancel kills the whole tree (browser helpers,
      // the script-wrapped openclaw). Windows: no process groups; taskkill /T
      // inside killProcessTree covers it.
      detached: !isWindows,
      windowsVerbatimArguments: winPlan.windowsVerbatimArguments,
      windowsHide: isWindows,
    })
  } catch (err) {
    sendEvent(res, {
      type: 'error',
      code: 'SPAWN_THROW',
      message: err instanceof Error ? err.message : String(err),
    })
    res.end()
    return
  }
  inFlight.set(tool, child)

  const parse = createCliLoginParser(tool)
  let buffer = ''
  const onChunk = (chunk: Buffer): void => {
    buffer += chunk.toString('utf8')
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const raw of lines) {
      const line = stripAnsi(raw)
      if (line.trim().length > 0) sendEvent(res, { type: 'output', line })
      const signal = parse(line)
      if (signal?.deviceCode) {
        sendEvent(res, { type: 'device-code', ...signal.deviceCode })
      } else if (signal?.authUrl) {
        sendEvent(res, { type: 'auth-url', url: signal.authUrl })
      }
    }
  }
  child.stdout?.on('data', onChunk)
  child.stderr?.on('data', onChunk)

  // Hard cap: the device windows expire at 15 minutes; never leave a zombie
  // poller. End the response BEFORE killing — the SIGTERM'd child's `close`
  // would otherwise send a second terminal (CANCELLED) that resets the UI's
  // failure state to a bare idle button. A real post-timeout login is already
  // covered by the store watcher, so ending early loses nothing.
  const timeout = setTimeout(() => {
    sendEvent(res, { type: 'error', code: 'TIMEOUT', message: 'Sign-in timed out. Try again.' })
    res.end()
    killProcessTree(child)
  }, LOGIN_TIMEOUT_MS)
  timeout.unref()

  // Store watcher — completion must NOT depend on the child exiting. OpenClaw's
  // browser flow can leave a never-answered paste-prompt holding the process
  // open after a successful (slow) sign-in; the credential landing ON DISK is
  // the real completion signal. The moment it appears: report success, close
  // the stream, reap the child (its work is done).
  const watcher = setInterval(() => {
    if (res.writableEnded) {
      clearInterval(watcher)
      return
    }
    if (!watchTickLoggedIn(tool)) return
    clearInterval(watcher)
    clearTimeout(timeout)
    if (inFlight.get(tool) === child) inFlight.delete(tool)
    sendEvent(res, { type: 'complete', success: true, loggedIn: true })
    res.end()
    killProcessTree(child)
  }, STORE_WATCH_INTERVAL_MS)
  watcher.unref()

  child.on('error', (err) => {
    clearTimeout(timeout)
    clearInterval(watcher)
    // Guarded delete — a late async spawn error (POSIX ENOENT) from a REPLACED
    // child must not evict its replacement's registration.
    if (inFlight.get(tool) === child) inFlight.delete(tool)
    sendEvent(res, { type: 'error', code: 'SPAWN_ERROR', message: err.message })
    res.end()
  })

  child.on('close', (code, signalName) => {
    clearTimeout(timeout)
    clearInterval(watcher)
    if (inFlight.get(tool) === child) inFlight.delete(tool)
    if (res.writableEnded) return
    void (async () => {
      // The PROBE is the truth; the exit code only shapes the failure copy.
      const loggedIn = await probeLoggedIn(tool).catch(() => false)
      if (loggedIn) {
        sendEvent(res, { type: 'complete', success: true, loggedIn: true })
      } else if (signalName || code === 130) {
        sendEvent(res, { type: 'error', code: 'CANCELLED', message: 'Sign-in was cancelled.' })
      } else {
        sendEvent(res, {
          type: 'complete',
          success: false,
          loggedIn: false,
          message: `Sign-in did not complete (exit ${String(code)}). Run \`${plan.displayCommand}\` in your terminal, then re-check.`,
        })
      }
      res.end()
    })()
  })

  // Cancel: the UI aborts the fetch → the connection closes → kill the tree.
  res.on('close', () => {
    clearTimeout(timeout)
    clearInterval(watcher)
    if (!child.killed) killProcessTree(child)
  })
}
