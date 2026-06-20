import { test as base, expect, type Page, type APIRequestContext } from '@playwright/test'
import os from 'node:os'
import { startMockGateway, type MockGateway } from './mockGateway'

// Mirrors playwright.config.ts — keeps tests pinned to a known port so the
// fixture's direct API calls don't have to rediscover where the server is.
const API_PORT = parseInt(process.env.CLAWBOO_API_PORT ?? '19999', 10)
export const API_BASE = `http://127.0.0.1:${API_PORT}`

const SETTINGS_URL = `${API_BASE}/api/settings`

/**
 * Guard rail — throws when the test runner OR the running server isn't
 * clearly in a sandboxed environment.
 *
 * Two checks:
 *   1. **Test runner env**: `CLAWBOO_E2E_SANDBOX_HOME` must point at a
 *      tmp dir. This is set by `playwright.config.ts` at config-load time
 *      (mkdtemp + `webServer.env` overrides for HOME / OPENCLAW_STATE_DIR).
 *   2. **Server state dir**: a GET to `/api/system/status` returns the
 *      live server's `openclaw.stateDir`. If that isn't under the OS
 *      tmpdir, the server is using the developer's real `~/.openclaw`
 *      (e.g. `pnpm e2e` reused an existing unsandboxed server on the same
 *      port). Refuse to touch it.
 *
 * Both checks together make the guard robust against the bad cases:
 *   - misconfigured playwright.config.ts (check #1 catches it)
 *   - playwright reusing a stale unsandboxed server (check #2 catches it)
 *   - fixture imported by a non-playwright runner (check #1 catches it)
 *
 * Used by helpers that touch destructive endpoints (e.g. DELETE
 * /api/teams) so a misconfigured run can't wipe a developer's real
 * `~/.openclaw/clawboo/clawboo.db`.
 */
export async function assertSandboxed(request: APIRequestContext): Promise<void> {
  const tmpRoot = os.tmpdir()

  // Check #1 — test runner env
  const sandboxHome = process.env.CLAWBOO_E2E_SANDBOX_HOME
  if (!sandboxHome || !sandboxHome.startsWith(tmpRoot)) {
    throw new Error(
      `Refusing to run destructive e2e helpers: CLAWBOO_E2E_SANDBOX_HOME ` +
        `is not set or doesn't live under ${tmpRoot}. This guards against ` +
        `a misconfigured run wiping the developer's real ~/.clawboo/clawboo.db. ` +
        `Run via 'pnpm e2e' which configures the sandbox automatically.`,
    )
  }

  // Check #1b — clawboo's OWN state dir (the SQLite DB / settings / secrets
  // vault) now lives under CLAWBOO_HOME. Verify the sandbox set it under tmp.
  const sandboxClawbooDir = process.env.CLAWBOO_E2E_SANDBOX_CLAWBOO_DIR
  if (!sandboxClawbooDir || !sandboxClawbooDir.startsWith(tmpRoot)) {
    throw new Error(
      `Refusing to run destructive e2e helpers: CLAWBOO_E2E_SANDBOX_CLAWBOO_DIR ` +
        `is not set or doesn't live under ${tmpRoot}. clawboo's own state dir ` +
        `(~/.clawboo by default) must be sandboxed via CLAWBOO_HOME. ` +
        `Run via 'pnpm e2e' which configures the sandbox automatically.`,
    )
  }

  // Check #2 — server state dir. Fetch the live server's identity.
  let serverStateDir: string | null = null
  try {
    const resp = await request.get(`${API_BASE}/api/system/status`)
    if (resp.ok()) {
      const data = (await resp.json()) as { openclaw?: { stateDir?: string } }
      serverStateDir = data.openclaw?.stateDir ?? null
    }
  } catch {
    /* fall through to the guard below */
  }
  if (!serverStateDir || !serverStateDir.startsWith(tmpRoot)) {
    throw new Error(
      `Refusing to run destructive e2e helpers: the server at ${API_BASE} ` +
        `reports stateDir=${serverStateDir ?? '<unknown>'} which isn't under ` +
        `${tmpRoot}. This usually means playwright reused an unsandboxed ` +
        `server (e.g. one started manually via 'pnpm dev' or 'pnpm start'). ` +
        `Kill that server and re-run 'pnpm e2e' so playwright spawns a ` +
        `fresh sandboxed one.`,
    )
  }
}

// ─── Shared fixture: mock gateway per worker ────────────────────────────────
// Worker-scoped so all tests in the same worker share a single gateway,
// avoiding race conditions from parallel settings file writes.
// Saves original settings before tests and restores them after.

export const test = base.extend<object, { gateway: MockGateway }>({
  gateway: [
    // eslint-disable-next-line no-empty-pattern
    async ({}, use) => {
      // Snapshot the original gateway URL so we can restore it after tests.
      // The token is NOT read back (GET /api/settings never returns the raw
      // token) and is NOT rewritten on restore — settingsPOST only updates the
      // fields present in the body, so omitting gatewayToken leaves the saved
      // token untouched (the correct restore semantics, no accidental wipe).
      let originalSettings: { gatewayUrl?: string } | null = null
      try {
        const resp = await fetch(SETTINGS_URL)
        if (resp.ok) originalSettings = (await resp.json()) as typeof originalSettings
      } catch {
        /* server may not be ready yet — will restore defaults */
      }

      const gw = await startMockGateway()
      await use(gw)
      gw.close()

      // Restore the original gateway URL to avoid polluting the user's environment.
      try {
        if (originalSettings?.gatewayUrl) {
          await fetch(SETTINGS_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ gatewayUrl: originalSettings.gatewayUrl }),
          })
        } else {
          // Original had no URL — restore the default URL (token left as-is).
          await fetch(SETTINGS_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ gatewayUrl: 'ws://localhost:18789' }),
          })
        }
      } catch {
        /* best-effort restore */
      }
    },
    { scope: 'worker' },
  ],
})

export { expect }

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Pre-save settings pointing to the mock gateway, then navigate and
 * let auto-connect succeed. This avoids the browser-side connect screen
 * entirely and is the most reliable approach for e2e tests.
 *
 * The auto-connect flow:
 *   1. Settings are saved to disk via POST /api/settings
 *   2. Page loads → GatewayBootstrap reads settings → auto-connects via proxy
 *   3. Proxy reads same settings → connects upstream to mock gateway
 *   4. Fleet hydrated → sidebar appears with agents
 */
export async function connectToMockGateway(
  page: Page,
  request: APIRequestContext,
  gatewayUrl: string,
) {
  // Safety: only DELETE teams in a sandboxed run. The server-side SQLite
  // path is hardcoded to `os.homedir() + '/.openclaw/clawboo/clawboo.db'`,
  // and without HOME being a sandbox dir, this loop would wipe the
  // developer's real teams. `playwright.config.ts` mkdtemps a sandbox and
  // overrides HOME on the spawned server; this assert refuses to run if
  // that hasn't happened. Also verifies via HTTP that the live server's
  // stateDir is actually under /tmp/ (catches the case where playwright
  // reused a stale unsandboxed server on the same port).
  await assertSandboxed(request)

  // Clean up stale teams from previous dev sessions so they don't
  // filter out mock gateway agents via auto-select in hydrateTeams.
  try {
    const teamsResp = await request.get(`${API_BASE}/api/teams`)
    if (teamsResp.ok()) {
      const data = (await teamsResp.json()) as { teams?: { id: string }[] }
      for (const team of data.teams ?? []) {
        await request.delete(`${API_BASE}/api/teams/${team.id}`)
      }
    }
  } catch {
    /* best-effort cleanup */
  }

  // Pre-save settings so auto-connect finds them
  await request.post(`${API_BASE}/api/settings`, {
    data: { gatewayUrl, gatewayToken: '' },
  })

  // Mark as onboarded to skip the onboarding wizard
  await page.addInitScript(() => {
    localStorage.setItem('clawboo.onboarded', '1')
  })

  // Intercept system status to prevent "Gateway Offline" overlay from blocking auto-connect.
  // The real server probes port 18789, which won't match our mock gateway's random port.
  await page.route('**/api/system/status', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        node: { version: process.version, major: 22, sufficient: true, path: '/usr/bin/node' },
        openclaw: {
          installed: true,
          version: '0.3.0',
          path: '/usr/bin/openclaw',
          stateDir: '/tmp/.openclaw',
          configExists: true,
          envExists: true,
        },
        gateway: { running: true, port: 18789, pid: null, managedByClawboo: false, uptimeMs: null },
      }),
    })
  })

  await page.goto('/')

  // Auto-connect fires on mount — wait for sidebar agents to appear
  const sidebar = page.locator('[data-testid="agent-list-column"]')
  await expect(sidebar).toBeVisible({ timeout: 15_000 })
  await expect(sidebar.getByText('Research Boo')).toBeVisible({ timeout: 10_000 })
}
