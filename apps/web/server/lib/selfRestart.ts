/**
 * apps/web/server/lib/selfRestart.ts
 *
 * The restart-into-the-new-version primitive for an in-app update. After a
 * successful global `npm install -g clawboo@latest`, the NEW bytes are on disk
 * but the running process is still the OLD `dist/server.js` loaded in memory —
 * a process cannot swap its own code. So we launch a successor and exit:
 *
 *   1. Start a fresh `node <this server entry>` DETACHED (survives our exit),
 *      pinned to the same API port and told to WAIT for that port to free
 *      (CLAWBOO_AWAIT_PORT — honored in server/index.ts before it binds).
 *   2. Exit so the OS frees the port; the waiting successor then binds it and
 *      rewrites api-port.txt.
 *   3. The browser (already polling /api/settings on the same origin) reloads
 *      once the successor answers, landing on the freshly-installed UI.
 *
 * CLAWBOO_VERSION is deliberately DROPPED from the successor's env so it reads
 * its (now-updated) version from the on-disk package.json instead of the stale
 * value the CLI injected at first launch.
 *
 * The successor gets this process's node options (`process.execArgv`), so a
 * server started as `node --max-old-space-size=4096 dist/server.js` keeps its
 * heap limit across an update. NODE_OPTIONS rides along in the env already.
 *
 * Only ever called for a `global` install (detectInstallMethod), where the
 * running entry path was replaced in place — so restarting into it runs new code.
 */
import { spawn } from 'node:child_process'

import { liveCwd } from './cwdGuard'

const FLUSH_DELAY_MS = 400

/**
 * Node options for the successor: this process's own, minus the inspector. Its
 * port is still held by this process when the successor starts, and
 * `--inspect-brk` would hold the successor at its first line waiting for a
 * debugger, so the update would never come back up.
 */
export function successorNodeOptions(execArgv: readonly string[]): string[] {
  const out: string[] = []
  for (let i = 0; i < execArgv.length; i++) {
    const arg = execArgv[i]!
    // The two that take their port as a separate argument.
    if (arg === '--inspect-port' || arg === '--debug-port') {
      i += 1
      continue
    }
    if (/^--(inspect|inspect-brk|inspect-wait|inspect-port|debug-port)(=|$)/.test(arg)) continue
    out.push(arg)
  }
  return out
}

export interface SelfRestartDeps {
  log?: { info: (...a: unknown[]) => void; error: (...a: unknown[]) => void }
  /** Test seam: override the process exit (defaults to process.exit). */
  exit?: (code: number) => void
}

/**
 * Launch a successor server on `port` and exit so it can take over the port.
 * Best-effort: if the launch fails we still exit (the user re-runs `clawboo`).
 * Returns whether this process is about to exit: false only when there was no
 * entry to relaunch and it keeps running.
 */
export function restartIntoLatest(port: number, deps: SelfRestartDeps = {}): boolean {
  const entry = process.argv[1]
  const doExit = deps.exit ?? ((code: number) => process.exit(code))
  if (!entry) {
    // No resolvable entry to relaunch — leave the current process running so the
    // user isn't dropped; they can restart manually to pick up the update.
    deps.log?.error('self-restart: no process entry to relaunch')
    return false
  }

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CLAWBOO_API_PORT: String(port),
    CLAWBOO_AWAIT_PORT: String(port),
  }
  // Force the successor to recompute its version from the freshly-installed
  // package.json (the inherited env var is the pre-update version).
  delete env['CLAWBOO_VERSION']

  try {
    const child = spawn(process.execPath, [...successorNodeOptions(process.execArgv), entry], {
      // Never inherit this process's directory: after `npm install -g` it can be
      // inside the package folder that was just replaced, and the successor
      // would die while loading.
      cwd: liveCwd(),
      detached: true,
      stdio: 'ignore',
      env,
    })
    child.unref()
    deps.log?.info(`self-restart: launched successor pid=${child.pid ?? '?'} on port ${port}`)
  } catch (err) {
    deps.log?.error('self-restart: failed to launch successor', err)
    // Fall through to exit anyway — a lingering old process is worse than a
    // clean stop the user can relaunch.
  }

  // Give the SSE 'restarting' frame time to reach the browser, then exit so the
  // port frees and the waiting successor can bind it.
  setTimeout(() => doExit(0), FLUSH_DELAY_MS)
  return true
}
