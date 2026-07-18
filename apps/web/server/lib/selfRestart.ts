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
 * Only ever called for a `global` install (detectInstallMethod), where the
 * running entry path was replaced in place — so restarting into it runs new code.
 */
import { spawn } from 'node:child_process'

const FLUSH_DELAY_MS = 400

export interface SelfRestartDeps {
  log?: { info: (...a: unknown[]) => void; error: (...a: unknown[]) => void }
  /** Test seam: override the process exit (defaults to process.exit). */
  exit?: (code: number) => void
}

/**
 * Launch a successor server on `port` and exit so it can take over the port.
 * Best-effort: if the launch fails we still exit (the user re-runs `clawboo`).
 */
export function restartIntoLatest(port: number, deps: SelfRestartDeps = {}): void {
  const entry = process.argv[1]
  const doExit = deps.exit ?? ((code: number) => process.exit(code))
  if (!entry) {
    // No resolvable entry to relaunch — leave the current process running so the
    // user isn't dropped; they can restart manually to pick up the update.
    deps.log?.error('self-restart: no process entry to relaunch')
    return
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
    const child = spawn(process.execPath, [entry], {
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
}
