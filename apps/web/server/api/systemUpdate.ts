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

export async function selfVersionGET(_req: Request, res: Response): Promise<void> {
  const info = await computeSelfVersion()
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
  let child
  try {
    child = spawn(resolveShimName('npm'), ['install', '-g', 'clawboo@latest'], {
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

  child.stdout?.on('data', (chunk: Buffer) => {
    for (const line of chunk.toString().split('\n').filter(Boolean)) {
      sendEvent(res, { type: 'output', line })
    }
  })

  child.stderr?.on('data', (chunk: Buffer) => {
    const text = chunk.toString()
    if (text.includes('EACCES') || text.toLowerCase().includes('permission denied')) {
      sendEvent(res, {
        type: 'error',
        code: 'EACCES',
        message:
          'Permission denied. A global install needs elevated permissions. Try: sudo npm install -g clawboo@latest',
      })
    }
    for (const line of text.split('\n').filter(Boolean)) {
      sendEvent(res, { type: 'output', line })
    }
  })

  child.on('error', (err) => {
    sendEvent(res, { type: 'error', code: 'SPAWN_ERROR', message: String(err) })
    res.end()
  })

  child.on('close', (code) => {
    if (code !== 0) {
      sendEvent(res, {
        type: 'error',
        code: `EXIT_${code}`,
        message: `Update failed with exit code ${code}. Try running it manually: npm install -g clawboo@latest`,
      })
      res.end()
      return
    }

    // Confirm the in-place package actually changed before restarting into it.
    // If the global install landed somewhere this running copy doesn't point at
    // (a local checkout mis-detected as global), restarting would re-run stale
    // bytes — so surface a manual-restart note instead of a broken hot-swap.
    const versionAfter = readVersionFromDisk()
    const restartSafe = versionAfter != null && versionAfter !== versionBefore
    if (!restartSafe) {
      sendEvent(res, {
        type: 'installed-elsewhere',
        version: versionAfter,
        message: 'Update installed. Restart Clawboo to use it: clawboo',
      })
      res.end()
      return
    }

    const port = Number(req.app.locals['apiPort']) || Number(process.env['CLAWBOO_API_PORT']) || 0
    if (!port) {
      sendEvent(res, {
        type: 'installed-elsewhere',
        version: versionAfter,
        message: 'Update installed. Restart Clawboo to use it: clawboo',
      })
      res.end()
      return
    }

    sendEvent(res, { type: 'installed', version: versionAfter })
    sendEvent(res, { type: 'restarting', port, version: versionAfter })
    res.end()
    // Launch the successor on the same port and exit so it can bind. The browser
    // is already polling /api/settings and reloads once the successor answers.
    restartIntoLatest(port)
  })

  res.on('close', () => {
    if (!child.killed) child.kill()
  })
}
