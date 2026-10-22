/**
 * apps/web/server/api/systemUpdate.ts
 *
 * Self-update surface for the "update available" chip:
 *   - GET  /api/system/self-version  → current vs latest + install method
 *   - POST /api/system/self-update   → SSE: npm install -g clawboo@latest, then
 *                                       restart into the new version.
 *
 * The POST only proceeds for a `global` install (the running dist/server.js is
 * replaced in place). npx / dev installs get an `unsupported` event and the
 * copy-command fallback — the chip hides its "Update now" button in those cases
 * anyway, so this is defense-in-depth.
 */
import { spawn } from 'node:child_process'
import type { Request, Response } from 'express'

import { liveCwd } from '../lib/cwdGuard'
import { summarizeNpmFailure } from '../lib/npmFailure'
import { isWindows, resolveShimName } from '../lib/platform'
import {
  buildUpdateCommand,
  computeSelfVersion,
  detectInstallMethod,
  readVersionFromDisk,
} from '../lib/updateCheck'
import { restartIntoLatest } from '../lib/selfRestart'

function sendEvent(res: Response, data: Record<string, unknown>): void {
  res.write(`data: ${JSON.stringify(data)}\n\n`)
}

/** Enough of npm's output to find its error block, which comes last. */
const MAX_KEPT_OUTPUT = 32_000

const MANUAL_UPDATE = 'npm install -g clawboo@latest'

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

  const method = detectInstallMethod()
  if (method !== 'global') {
    sendEvent(res, {
      type: 'unsupported',
      method,
      command: buildUpdateCommand(method),
      message:
        method === 'npx'
          ? 'This is an npx run (ephemeral). Install globally to enable in-app updates: npm install -g clawboo@latest'
          : 'In-app update is only available for a global install.',
    })
    res.end()
    return
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
  const finish = (event: Record<string, unknown>): void => {
    if (finished) return
    finished = true
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
    finish({ type: 'restarting', port, version: versionAfter })
    // Launch the successor on the same port and exit so it can bind. The browser
    // is already polling /api/settings and reloads once the successor answers.
    restartIntoLatest(port)
  })

  res.on('close', () => {
    if (!child.killed) child.kill()
  })
}
