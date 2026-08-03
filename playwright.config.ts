import { defineConfig, devices } from '@playwright/test'
import { existsSync, mkdirSync, mkdtempSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'

// E2E tests pin the API port to a known value via CLAWBOO_API_PORT so they
// can talk to it directly (no port discovery needed). 19999 is well outside
// the regular auto-fallback window (18790-18809) so it never collides with
// a developer's running `pnpm dev` instance.
const API_PORT = parseInt(process.env.CLAWBOO_API_PORT ?? '19999', 10)
const API_BASE = `http://127.0.0.1:${API_PORT}`

// ─── Sandbox HOME + state dir ────────────────────────────────────────────────
//
// E2E runs would otherwise wipe the developer's real teams / agents because
// the server's SQLite path is hardcoded:
//
//   apps/web/server/lib/db.ts → os.homedir() + '/.openclaw/clawboo/clawboo.db'
//   @clawboo/config           → resolveStateDir() reads OPENCLAW_STATE_DIR
//
// We mkdtemp a per-run sandbox dir and override BOTH env vars on the
// spawned server (via `webServer.env` below). The fixture `connectToMockGateway`
// does a DELETE-loop over /api/teams to clean stale state — without isolation,
// that loop hits the developer's actual ~/.openclaw/clawboo/clawboo.db. A real
// user lost 5 production teams to one `pnpm e2e` run before this landed.
//
// `globalTeardown` cleans the sandbox after the run completes (or fails).
// The fixture also has a belt-and-suspenders guard rail — it reads
// `CLAWBOO_E2E_SANDBOX_HOME` from the test runner's env and refuses to
// delete anything if it's not set or doesn't live under the OS temp dir.

const SANDBOX_HOME = mkdtempSync(path.join(os.tmpdir(), 'clawboo-e2e-'))
const SANDBOX_STATE_DIR = path.join(SANDBOX_HOME, '.openclaw')
// clawboo now owns its OWN state dir (~/.clawboo by default); CLAWBOO_HOME
// overrides it. Sandbox it under the same temp root so the run can't touch the
// developer's real ~/.clawboo (DB / settings / secrets vault / worktrees).
const SANDBOX_CLAWBOO_DIR = path.join(SANDBOX_HOME, '.clawboo')
mkdirSync(SANDBOX_STATE_DIR, { recursive: true })
mkdirSync(SANDBOX_CLAWBOO_DIR, { recursive: true })

// Expose the sandbox path to the test-runner process so fixtures can verify
// they're running in a sandboxed context before doing anything destructive.
process.env.CLAWBOO_E2E_SANDBOX_HOME = SANDBOX_HOME
process.env.CLAWBOO_E2E_SANDBOX_STATE_DIR = SANDBOX_STATE_DIR
process.env.CLAWBOO_E2E_SANDBOX_CLAWBOO_DIR = SANDBOX_CLAWBOO_DIR

// ─── Corepack cache passthrough ──────────────────────────────────────────────
//
// `webServer.command` below shells out to `pnpm` twice, and the spawned process
// runs with HOME pointed at the sandbox above. Once you have run `corepack
// enable` (which CONTRIBUTING.md tells contributors to do), `pnpm` is a corepack
// shim that keys its package-manager cache off HOME. Pointed at the sandbox's
// empty cache it re-fetches the pinned pnpm 9.15.0 from the npm registry on
// every single run. Measured both ways: without this block the run logs one
// "Corepack is about to download .../pnpm-9.15.0.tgz"; with it, none.
//
// It does not hang — corepack's confirmation prompt auto-proceeds when stdin is
// not a TTY, which is how Playwright spawns this. The reason to fix it is that
// the suite is otherwise network-free (the gateway is an in-process mock, every
// live probe is stubbed), so quietly needing the registry just to START is a
// dependency worth dropping: it is what breaks an air-gapped or rate-limited run.
//
// Corepack's cache location differs by platform and has moved between versions,
// so probe the known spots rather than hardcoding one. Setting the prompt flag
// makes the non-interactivity explicit instead of leaning on that TTY detail.
// Nothing writable leaks into the sandbox's blast radius: the corepack cache is
// read-mostly and holds no Clawboo state.
const COREPACK_HOME = [
  process.env.COREPACK_HOME,
  process.env.XDG_CACHE_HOME && path.join(process.env.XDG_CACHE_HOME, 'node', 'corepack'),
  path.join(os.homedir(), '.cache', 'node', 'corepack'),
  path.join(os.homedir(), 'Library', 'Caches', 'node', 'corepack'),
  process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'node', 'corepack'),
].find((dir): dir is string => !!dir && existsSync(dir))

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  // In CI, `github` writes ::error:: annotations so a failure shows up inline on
  // the pull-request diff, and the HTML report is uploaded as a build artifact.
  // `open: 'never'` is the load-bearing part: the bare 'html' reporter's default
  // is to serve the report on failure, which on a headless runner is a process
  // that never exits.
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'html',
  globalTeardown: './tests/e2e/globalTeardown.ts',
  use: {
    baseURL: API_BASE,
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: `CLAWBOO_API_PORT=${API_PORT} pnpm --filter @clawboo/web build:ui && CLAWBOO_API_PORT=${API_PORT} pnpm --filter @clawboo/web start`,
    url: `${API_BASE}/api/settings`,
    reuseExistingServer: !process.env.CI,
    // Bumped from 60s — a cold `vite build` takes 80–120s on the macOS
    // dev box. The 60s default was timing out before the UI bundle
    // finished, blocking `pnpm e2e` from running standalone.
    //
    // CI gets more headroom, precautionarily. This has NOT been measured on a
    // hosted runner: the reasoning is only that one has fewer cores than a dev
    // box and is always cold (no warm node_modules/.vite, no OS page cache).
    // What makes it worth pre-empting is how opaque the failure is — a bare
    // "Timed out waiting 180000ms from config.webServer" with nothing to say the
    // build merely needed longer. The extra wait costs nothing on a healthy run;
    // it only changes how long a genuinely stuck one takes to give up.
    timeout: process.env.CI ? 300_000 : 180_000,
    env: {
      // Sandbox the spawned server. `CLAWBOO_HOME` overrides resolveClawbooDir()
      // (clawboo's OWN dir: SQLite DB / settings / secrets vault / worktrees /
      // api-port / device identity); `OPENCLAW_STATE_DIR` overrides
      // resolveStateDir() (OpenClaw's openclaw.json / .env, read for interop).
      // `HOME` is kept as a belt-and-suspenders fallback. Tests run against this
      // isolated env and CAN'T touch the developer's real ~/.clawboo or ~/.openclaw.
      HOME: SANDBOX_HOME,
      OPENCLAW_STATE_DIR: SANDBOX_STATE_DIR,
      CLAWBOO_HOME: SANDBOX_CLAWBOO_DIR,
      // Keep corepack off the sandbox HOME — see the COREPACK_HOME note above.
      ...(COREPACK_HOME ? { COREPACK_HOME } : {}),
      COREPACK_ENABLE_DOWNLOAD_PROMPT: '0',
    },
  },
})
