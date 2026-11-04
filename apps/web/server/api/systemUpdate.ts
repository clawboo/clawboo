/**
 * apps/web/server/api/systemUpdate.ts
 *
 * Self-update surface for the "update available" chip:
 *   - GET  /api/system/self-version  → current vs latest + install method
 *   - POST /api/system/self-update   → SSE: npm install -g clawboo@latest, then
 *                                       restart into the new version.
 *
 * The POST only proceeds for a `global` install this user can write (the
 * running dist/server.js is replaced in place), and never where an
 * administrator turned updates off. Everything else gets an `unsupported`
 * event naming the reason, and the copy-command fallback. The chip hides its
 * "Update now" button in those cases anyway, so this is defense-in-depth.
 *
 * DRAIN FIRST. An update holds the engine (see lib/engineHold) from the start,
 * so no new agent run starts while npm installs, and once the install lands it
 * waits for the runs already going, up to SELF_UPDATE_RUN_WAIT_MS, before it
 * restarts. `{ "force": true }` skips that wait: sent with a new update, it
 * restarts as soon as the install lands; sent while an update is waiting, it
 * makes that update restart now. A failed install releases the hold, and so
 * does an install that runs past UPDATE_INSTALL_HOLD_MS: the hold then lapses
 * and agent work goes on until the install lands.
 */
import { spawn } from 'node:child_process'
import type { Request, Response } from 'express'

import { liveCwd } from '../lib/cwdGuard'
import { summarizeNpmFailure } from '../lib/npmFailure'
import { isWindows, resolveShimName } from '../lib/platform'
import {
  buildUpdateCommand,
  computeSelfVersion,
  readVersionFromDisk,
  selfUpdateRefusal,
} from '../lib/updateCheck'
import { engineHold } from '../lib/engineHold'
import { runSlots, waitForRunsToFinish } from '../lib/runSlots'
import { restartIntoLatest } from '../lib/selfRestart'

function sendEvent(res: Response, data: Record<string, unknown>): void {
  res.write(`data: ${JSON.stringify(data)}\n\n`)
}

/** Enough of npm's output to find its error block, which comes last. */
const MAX_KEPT_OUTPUT = 32_000

const MANUAL_UPDATE = 'npm install -g clawboo@latest'

/** How long an installed update waits for agent runs to finish before it restarts anyway. */
export const SELF_UPDATE_RUN_WAIT_MS = 10 * 60_000
/** The owner id of the hold an update places. */
export const SELF_UPDATE_HOLD_OWNER = 'self-update'
/** The longest an install holds agent work back. A stalled npm must not freeze it. */
export const UPDATE_INSTALL_HOLD_MS = 5 * 60_000
/** The update keeps its hold alive on this beat, with HOLD_TTL so it lapses soon after a crash. */
const HOLD_RENEW_MS = 20_000
const HOLD_TTL_MS = 60_000
const SSE_KEEPALIVE_MS = 15_000

/**
 * The update in progress, if any: one at a time. It stays set once the restart
 * begins, so nothing starts a second install while this process exits.
 */
let inProgress: { force(): void } | null = null

/** TEST-ONLY: forget an update a test left in progress. */
export function resetSelfUpdateForTests(): void {
  inProgress = null
}

function runsText(n: number): string {
  return n === 1 ? '1 agent run' : `${n} agent runs`
}

/**
 * The `error` event for an npm install that exited non-zero, carrying npm's
 * own reason when its output names one. Exported for tests.
 */
export function npmFailureEvent(exitCode: number | null, output: string): Record<string, unknown> {
  const failure = summarizeNpmFailure(output)
  if (failure.permission) {
    return {
      type: 'error',
      code: 'EACCES',
      exitCode,
      detail: failure.detail,
      message:
        'Permission denied. A global install needs elevated permissions. Try: sudo npm install -g clawboo@latest',
    }
  }
  return {
    type: 'error',
    code: failure.code ?? `EXIT_${exitCode}`,
    exitCode,
    detail: failure.detail,
    message: failure.detail
      ? `Update failed: ${failure.detail} Copy the command to retry by hand.`
      : `Update failed with exit code ${exitCode}. Try running it manually: ${MANUAL_UPDATE}`,
  }
}

export async function selfVersionGET(req: Request, res: Response): Promise<void> {
  // `?local=1` — the `clawboo` launcher reads this on every attach to compare the
  // running server against its own version, and only needs `current`. Skipping
  // the registry probe keeps that check local-only and instant; servers that
  // predate the param just return the full payload, which the launcher also
  // accepts.
  const info = await computeSelfVersion({ skipRegistry: req.query['local'] === '1' })
  res.json(info)
}

export async function selfUpdatePOST(req: Request, res: Response): Promise<void> {
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders()

  const refusal = selfUpdateRefusal()
  if (refusal) {
    sendEvent(res, {
      type: 'unsupported',
      method: refusal.method,
      reason: refusal.reason,
      command: buildUpdateCommand(refusal.method),
      message: refusal.message,
    })
    res.end()
    return
  }

  const force = (req.body as { force?: unknown } | undefined)?.force === true
  if (inProgress) {
    if (force) {
      inProgress.force()
      sendEvent(res, {
        type: 'forced',
        message: 'The update in progress restarts without waiting for agent runs.',
      })
    } else {
      sendEvent(res, {
        type: 'error',
        code: 'IN_PROGRESS',
        message: 'An update is already in progress.',
      })
    }
    res.end()
    return
  }

  // Hold the engine from the start: no new agent run starts while npm installs,
  // so the runs already going have that time to finish too.
  let forced = force
  const forceNow = new AbortController()
  inProgress = {
    force(): void {
      forced = true
      forceNow.abort()
    },
  }
  let installing = true
  const installHoldUntil = Date.now() + UPDATE_INSTALL_HOLD_MS
  const holdEngine = (): void => {
    // Past its bound, an install stops renewing and the hold lapses.
    if (installing && Date.now() > installHoldUntil) return
    engineHold().place(SELF_UPDATE_HOLD_OWNER, { ttlMs: HOLD_TTL_MS, reason: 'update' })
  }
  holdEngine()
  const renew = setInterval(holdEngine, HOLD_RENEW_MS)
  renew.unref?.()
  /** The update ended without a restart: new runs may start again. */
  const giveUp = (): void => {
    clearInterval(renew)
    engineHold().release(SELF_UPDATE_HOLD_OWNER)
    inProgress = null
  }

  const versionBefore = readVersionFromDisk()
  sendEvent(res, {
    type: 'progress',
    step: 'installing',
    message: 'Installing the latest Clawboo…',
  })

  // Mirrors installOpenclawPOST's Windows-safe launch: resolveShimName('npm')
  // (npm.cmd on Windows), shell:isWindows (CVE-2024-27980 guard), windowsHide.
  // Fixed literal args, no user input — no injection surface.
  //
  // An explicit cwd that exists: npm reads its working directory before doing
  // anything else and exits with code 7 when that directory has been deleted,
  // which is where a server left running inside a replaced package folder sits.
  let child
  try {
    child = spawn(resolveShimName('npm'), ['install', '-g', 'clawboo@latest'], {
      cwd: liveCwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: isWindows,
      windowsHide: isWindows,
    })
  } catch (err) {
    giveUp()
    sendEvent(res, {
      type: 'error',
      code: 'SPAWN_THROW',
      message: err instanceof Error ? err.message : String(err),
    })
    res.end()
    return
  }

  // npm's output, kept (bounded) so a failure can say what went wrong.
  let output = ''
  const keep = (text: string): void => {
    output = (output + text).slice(-MAX_KEPT_OUTPUT)
  }
  let finished = false
  /** End the stream. Every end but a restart releases the hold. */
  const finish = (event: Record<string, unknown>): void => {
    if (finished) return
    finished = true
    if (event['type'] !== 'restarting') giveUp()
    sendEvent(res, event)
    res.end()
  }

  child.stdout?.on('data', (chunk: Buffer) => {
    const text = chunk.toString()
    keep(text)
    for (const line of text.split('\n').filter(Boolean)) {
      sendEvent(res, { type: 'output', line })
    }
  })

  child.stderr?.on('data', (chunk: Buffer) => {
    const text = chunk.toString()
    keep(text)
    for (const line of text.split('\n').filter(Boolean)) {
      sendEvent(res, { type: 'output', line })
    }
  })

  child.on('error', (err) => {
    finish({ type: 'error', code: 'SPAWN_ERROR', message: String(err) })
  })

  child.on('close', (code) => {
    if (finished) return
    if (code !== 0) {
      finish(npmFailureEvent(code, output))
      return
    }

    // Confirm the in-place package actually changed before restarting into it.
    // If the global install landed somewhere this running copy doesn't point at
    // (a local checkout mis-detected as global), restarting would re-run stale
    // bytes — so surface a manual-restart note instead of a broken hot-swap.
    const versionAfter = readVersionFromDisk()
    const restartSafe = versionAfter != null && versionAfter !== versionBefore
    if (!restartSafe) {
      finish({
        type: 'installed-elsewhere',
        version: versionAfter,
        message: 'Update installed. Restart Clawboo to use it: clawboo',
      })
      return
    }

    const port = Number(req.app.locals['apiPort']) || Number(process.env['CLAWBOO_API_PORT']) || 0
    if (!port) {
      finish({
        type: 'installed-elsewhere',
        version: versionAfter,
        message: 'Update installed. Restart Clawboo to use it: clawboo',
      })
      return
    }

    sendEvent(res, { type: 'installed', version: versionAfter })
    installing = false
    holdEngine()
    let keepalive: ReturnType<typeof setInterval> | null = null
    const restart = (interruptedRuns: number): void => {
      clearInterval(renew)
      if (keepalive) clearInterval(keepalive)
      finish({ type: 'restarting', port, version: versionAfter, interruptedRuns })
      // Launch the successor on the same port and exit so it can bind. The
      // browser polls /api/system/capabilities and reloads once an engine on the
      // new version answers. The hold, and `inProgress`, stay until this process
      // exits. One that cannot relaunch keeps running: let work start again.
      if (!restartIntoLatest(port)) giveUp()
    }
    if (forced || runSlots().stats().running === 0) {
      restart(forced ? runSlots().stats().running : 0)
      return
    }
    // Agent runs are going. Wait for them, as long as the bound allows, and say
    // how many are left each time the number changes. A browser that closes now
    // does not stop the restart: the new version is already on disk. A comment
    // line now and then keeps a proxy from closing a stream that has gone quiet.
    keepalive = setInterval(() => res.write(': keepalive\n\n'), SSE_KEEPALIVE_MS)
    keepalive.unref?.()
    void waitForRunsToFinish({
      timeoutMs: SELF_UPDATE_RUN_WAIT_MS,
      signal: forceNow.signal,
      onRunning: (running) => {
        if (running === 0) return
        sendEvent(res, {
          type: 'progress',
          step: 'waiting',
          running,
          message: `Waiting for ${runsText(running)} to finish before restarting.`,
        })
      },
    })
      .catch(() => ({ running: runSlots().stats().running }))
      .then(({ running }) => restart(running))
  })

  res.on('close', () => {
    if (!child.killed) child.kill()
  })
}
