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

import { isAgentPoolMode, isAgentUserMode } from '../lib/agentUser/config'
import { isWindows } from '../lib/platform'
import { detectOauthProfileProviders } from '../lib/openclawEnv'
import {
  invalidateCodexAuthCache,
  isAgentCodexLoggedIn,
  isCodexLoggedIn,
  userCodexAuthPath,
} from '../lib/runtimes/codexAuth'
import { hasUsableCodexAuth } from '../lib/runtimes/codexDriver'
import { invalidateCodexModelsCache } from '../lib/runtimes/codexModels'
import { isAgentHermesCodexAuthPresent, isHermesCodexAuthPresent } from '../lib/runtimes/hermesAuth'
import { buildCmdShimPlan, needsCmdShim } from '../lib/runtimes/winSpawn'
import { killProcessTree } from '../lib/runtimes/killTree'
import { spawnAgentProcess } from '../lib/runtimes/spawner'
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
const inFlight = new Map<string, ChildProcess>()

/** Post-run truth: is the tool actually signed in now? Probes the real store
 *  (never trusts the exit code: `script`, for one, can exit 0 around a failed CLI).
 *  `asAgent`: the login ran as the agent user, so its store is that user's. */
async function probeLoggedIn(
  tool: CliLoginTool,
  asAgent: boolean,
  agentId: string | null = null,
): Promise<boolean> {
  if (tool === 'codex') {
    invalidateCodexAuthCache()
    // A new sign-in can be a different ChatGPT plan, with different models.
    invalidateCodexModelsCache()
    return asAgent ? isAgentCodexLoggedIn(agentId) : isCodexLoggedIn()
  }
  if (tool === 'hermes')
    return asAgent ? isAgentHermesCodexAuthPresent(agentId) : isHermesCodexAuthPresent()
  return detectOauthProfileProviders(resolveStateDir()).has('openai-codex')
}

/** The store watcher's tick for a login run as the agent user: its store is in
 *  agent space, read through the agent host, so the check is asynchronous. */
async function agentWatchTickLoggedIn(
  tool: 'codex' | 'hermes',
  agentId: string | null = null,
): Promise<boolean> {
  if (tool === 'hermes') return isAgentHermesCodexAuthPresent(agentId)
  const present = await isAgentCodexLoggedIn(agentId)
  if (present) {
    invalidateCodexAuthCache()
    // A new sign-in can be a different ChatGPT plan, with different models.
    invalidateCodexModelsCache()
  }
  return present
}

/** The cheap per-tick variant for the store watcher — pure file reads (the
 *  codex CLI probe would spawn a process every tick). Invalidates the codex
 *  caches so the host's follow-up re-check sees fresh truth. The watcher usually
 *  ends the stream before the child exits, so probeLoggedIn never runs. */
function watchTickLoggedIn(tool: CliLoginTool): boolean {
  try {
    if (tool === 'codex') {
      const present = hasUsableCodexAuth(userCodexAuthPath())
      if (present) {
        invalidateCodexAuthCache()
        // A new sign-in can be a different ChatGPT plan, with different models.
        invalidateCodexModelsCache()
      }
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
  // With a user per agent (CLAWBOO_AGENT_USERS) each agent signs in as its own
  // user, so the request names the agent; its login is that agent's alone.
  const rawAgent = req.query['agentId']
  const poolAgent =
    isAgentPoolMode() && tool !== 'openclaw'
      ? typeof rawAgent === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(rawAgent)
        ? rawAgent
        : ''
      : null
  if (poolAgent === '') {
    res.status(400).json({
      error:
        'Each agent runs as its own user (CLAWBOO_AGENT_USERS), so each signs in on its own: name the agent (?agentId=).',
    })
    return
  }
  const flight = poolAgent ? `${tool}:${poolAgent}` : tool

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
  const prev = inFlight.get(flight)
  if (prev && !prev.killed) killProcessTree(prev)

  sendEvent(res, {
    type: 'progress',
    step: 'starting',
    message: `Starting ${plan.displayCommand}…`,
  })

  // Two DISTINCT spawn modes, each its own call so a spawn is exactly what it
  // says. A Windows .cmd/.bat shim (codex/hermes) routes through the repo's safe
  // cmd.exe planner, quoted + caret-escaped, NEVER `shell: true` (a bare shell
  // spawn misparses a resolved bin path containing a space, e.g. a spaced
  // Windows username). Everything else is a plain argv spawn that no shell ever
  // parses.
  //
  // With agents on their own OS user, the Codex and Hermes sign-ins run as that
  // user, so the login they make is the agents' own. OpenClaw's stays a server
  // spawn: its agents run in its Gateway as the server's user (agent isolation
  // does not cover OpenClaw), so its login must land in that user's store.
  const asAgent = tool !== 'openclaw' && isAgentUserMode()
  let child: ChildProcess
  try {
    if (tool === 'openclaw') {
      // POSIX only (Windows has no plan for it): plain argv, never a shell.
      child = spawn(plan.command, plan.args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: plan.env,
        detached: !isWindows,
        windowsHide: isWindows,
      })
    } else if (needsCmdShim(plan.command)) {
      const shim = buildCmdShimPlan({ command: plan.command, args: plan.args })
      child = spawnAgentProcess({
        kind: 'login',
        agentId: poolAgent,
        command: shim.command,
        args: shim.args,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: plan.env,
        // Windows: no process groups; taskkill /T inside killProcessTree covers
        // tree cleanup.
        detached: false,
        windowsVerbatimArguments: shim.windowsVerbatimArguments,
        windowsHide: true,
      })
    } else {
      child = spawnAgentProcess({
        kind: 'login',
        agentId: poolAgent,
        command: plan.command,
        args: plan.args,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: plan.env,
        // Process-group leader so Cancel kills the whole tree (browser helpers).
        detached: !isWindows,
        windowsHide: isWindows,
      })
    }
  } catch (err) {
    sendEvent(res, {
      type: 'error',
      code: 'SPAWN_THROW',
      message: err instanceof Error ? err.message : String(err),
    })
    res.end()
    return
  }
  inFlight.set(flight, child)

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
  const signedIn = (): void => {
    clearInterval(watcher)
    clearTimeout(timeout)
    if (inFlight.get(flight) === child) inFlight.delete(flight)
    sendEvent(res, { type: 'complete', success: true, loggedIn: true })
    res.end()
    killProcessTree(child)
  }
  // A check of the agent user's store is asynchronous: one at a time.
  let checking = false
  const watcher = setInterval(() => {
    if (res.writableEnded) {
      clearInterval(watcher)
      return
    }
    if (!asAgent) {
      if (watchTickLoggedIn(tool)) signedIn()
      return
    }
    if (checking) return
    checking = true
    void agentWatchTickLoggedIn(tool, poolAgent).then((present) => {
      checking = false
      if (present && !res.writableEnded) signedIn()
    })
  }, STORE_WATCH_INTERVAL_MS)
  watcher.unref()

  child.on('error', (err) => {
    clearTimeout(timeout)
    clearInterval(watcher)
    // Guarded delete — a late async spawn error (POSIX ENOENT) from a REPLACED
    // child must not evict its replacement's registration.
    if (inFlight.get(flight) === child) inFlight.delete(flight)
    sendEvent(res, { type: 'error', code: 'SPAWN_ERROR', message: err.message })
    res.end()
  })

  child.on('close', (code, signalName) => {
    clearTimeout(timeout)
    clearInterval(watcher)
    if (inFlight.get(flight) === child) inFlight.delete(flight)
    if (res.writableEnded) return
    void (async () => {
      // The PROBE is the truth; the exit code only shapes the failure copy.
      const loggedIn = await probeLoggedIn(tool, asAgent, poolAgent).catch(() => false)
      if (loggedIn) {
        sendEvent(res, { type: 'complete', success: true, loggedIn: true })
      } else if (signalName || code === 130) {
        sendEvent(res, { type: 'error', code: 'CANCELLED', message: 'Sign-in was cancelled.' })
      } else {
        sendEvent(res, {
          type: 'complete',
          success: false,
          loggedIn: false,
          // With agents on their own OS user the login has to be the agent user's:
          // the command in the person's own terminal would sign the person in.
          message: asAgent
            ? `Sign-in did not complete (exit ${String(code)}). Sign in again from here: agents run as their own user, so a sign-in in your own terminal does not reach them.`
            : `Sign-in did not complete (exit ${String(code)}). Run \`${plan.displayCommand}\` in your terminal, then re-check.`,
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
