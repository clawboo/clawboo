import { defineConfig, devices } from '@playwright/test'
import { mkdirSync, mkdtempSync } from 'node:fs'
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
mkdirSync(SANDBOX_STATE_DIR, { recursive: true })

// Expose the sandbox path to the test-runner process so fixtures can verify
// they're running in a sandboxed context before doing anything destructive.
process.env.CLAWBOO_E2E_SANDBOX_HOME = SANDBOX_HOME
process.env.CLAWBOO_E2E_SANDBOX_STATE_DIR = SANDBOX_STATE_DIR

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: 'html',
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
    timeout: 180_000,
    env: {
      // Sandbox the spawned server. `HOME` overrides what os.homedir()
      // returns (controls the SQLite path); `OPENCLAW_STATE_DIR` overrides
      // resolveStateDir() (controls openclaw.json / .env / settings.json).
      // Tests run against this isolated env and CAN'T touch ~/.openclaw.
      HOME: SANDBOX_HOME,
      OPENCLAW_STATE_DIR: SANDBOX_STATE_DIR,
    },
  },
})
