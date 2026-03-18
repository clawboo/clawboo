import { test as base, expect, type Page, type APIRequestContext } from '@playwright/test'
import { startMockGateway, type MockGateway } from './mockGateway'

const SETTINGS_URL = 'http://127.0.0.1:3000/api/settings'

// ─── Shared fixture: mock gateway per worker ────────────────────────────────
// Worker-scoped so all tests in the same worker share a single gateway,
// avoiding race conditions from parallel settings file writes.
// Saves original settings before tests and restores them after.

export const test = base.extend<object, { gateway: MockGateway }>({
  gateway: [
    // eslint-disable-next-line no-empty-pattern
    async ({}, use) => {
      // Snapshot original settings so we can restore after tests
      let originalSettings: { gatewayUrl?: string; gatewayToken?: string } | null = null
      try {
        const resp = await fetch(SETTINGS_URL)
        if (resp.ok) originalSettings = (await resp.json()) as typeof originalSettings
      } catch {
        /* server may not be ready yet — will restore defaults */
      }

      const gw = await startMockGateway()
      await use(gw)
      gw.close()

      // Restore original settings to avoid polluting the user's environment
      try {
        if (originalSettings?.gatewayUrl) {
          await fetch(SETTINGS_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              gatewayUrl: originalSettings.gatewayUrl,
              gatewayToken: originalSettings.gatewayToken ?? '',
            }),
          })
        } else {
          // Original had no URL — restore defaults
          await fetch(SETTINGS_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ gatewayUrl: 'ws://localhost:18789', gatewayToken: '' }),
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
  // Clean up stale teams from previous dev sessions so they don't
  // filter out mock gateway agents via auto-select in hydrateTeams.
  try {
    const teamsResp = await request.get('http://127.0.0.1:3000/api/teams')
    if (teamsResp.ok()) {
      const data = (await teamsResp.json()) as { teams?: { id: string }[] }
      for (const team of data.teams ?? []) {
        await request.delete(`http://127.0.0.1:3000/api/teams/${team.id}`)
      }
    }
  } catch {
    /* best-effort cleanup */
  }

  // Pre-save settings so auto-connect finds them
  await request.post('http://127.0.0.1:3000/api/settings', {
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
  await expect(sidebar.getByText('Test Boo')).toBeVisible({ timeout: 10_000 })
}
