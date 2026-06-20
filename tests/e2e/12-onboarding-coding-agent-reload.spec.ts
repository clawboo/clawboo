// Coding-agent first-run RELOAD (the reload-trap regression): after a user picks
// a coding agent (Claude Code), CONNECTS it, and reaches the dashboard, a page
// reload must KEEP them on the dashboard — not re-trap them in a fresh wizard.
// The completed coding-agent path seeds no native agent and no team, so the
// durable signal that survives the reload is the connected-runtime credential
// (GET /api/runtimes → hasCredential), which the bootstrap consults.

import { test, expect, API_BASE, assertSandboxed } from './helpers/fixtures'

test.describe('Coding-agent onboarding — reload stays on the dashboard', () => {
  test('pick Claude Code → Continue → dashboard → reload → still dashboard (no wizard)', async ({
    page,
    request,
  }) => {
    await assertSandboxed(request)

    // Fresh state: no teams, no native agents (a prior spec may have seeded them;
    // without clearing, the bootstrap would take its native-mode reload path).
    const teamsResp = await request.get(`${API_BASE}/api/teams`)
    if (teamsResp.ok()) {
      const data = (await teamsResp.json()) as { teams?: { id: string }[] }
      for (const team of data.teams ?? []) await request.delete(`${API_BASE}/api/teams/${team.id}`)
    }
    const agentsResp = await request.get(`${API_BASE}/api/agents`)
    if (agentsResp.ok()) {
      const data = (await agentsResp.json()) as {
        agents?: { id: string; runtime?: string; sourceId?: string }[]
      }
      for (const a of data.agents ?? []) {
        if (
          a.runtime === 'clawboo-native' ||
          a.sourceId === 'clawboo-native' ||
          a.id.startsWith('native-')
        ) {
          await request.delete(`${API_BASE}/api/agents/${a.id}`)
        }
      }
    }

    // Clear the onboarding markers ONCE, on the first load only. addInitScript
    // re-runs on reload, so a sessionStorage sentinel keeps the reload from
    // wiping the `clawboo.onboarded` flag onboarding just set (which is exactly
    // what we're testing survives the reload).
    await page.addInitScript(() => {
      if (!sessionStorage.getItem('e2e-cleared')) {
        localStorage.removeItem('clawboo.onboarded')
        localStorage.removeItem('clawboo.wizard.active')
        localStorage.removeItem('clawboo.wizard.runtime')
        sessionStorage.setItem('e2e-cleared', '1')
      }
    })

    // OpenClaw is NOT configured → the wizard shows on first load.
    await page.route('**/api/system/status', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          node: { version: 'v22.0.0', major: 22, sufficient: true, path: '/usr/bin/node' },
          openclaw: {
            installed: false,
            version: null,
            path: null,
            stateDir: '/tmp/.openclaw',
            configExists: false,
            envExists: false,
          },
          gateway: {
            running: false,
            port: 18789,
            pid: null,
            managedByClawboo: false,
            uptimeMs: null,
          },
        }),
      })
    })

    // Claude Code reads as a CONNECTED runtime (a credential is present). This is
    // the durable signal the reload-decision consults — it persists across the
    // reload because the route handler stays registered.
    await page.route('**/api/runtimes', async (route) => {
      if (route.request().method() !== 'GET') return route.fallback()
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          runtimes: [
            {
              id: 'claude-code',
              name: 'Claude Code',
              installed: true,
              hasCredential: true,
              connectionState: 'ready',
              authKind: 'api-key',
              envVar: 'ANTHROPIC_API_KEY',
              builtIn: false,
            },
          ],
          available: [],
        }),
      })
    })

    await page.goto('/')

    // Welcome → Choose runtime → pick Claude Code → ConnectAgents → Continue.
    await page.getByRole('button', { name: /Get Started/ }).click()
    await expect(page.getByTestId('choose-runtime-step')).toBeVisible({ timeout: 10_000 })
    await page.getByTestId('runtime-pick-claude-code').click()
    await expect(page.getByTestId('connect-agents-step')).toBeVisible({ timeout: 10_000 })
    await page.getByTestId('connect-agents-continue').click()

    // Landed in the dashboard shell, wizard gone.
    await expect(page.locator('[data-testid="team-sidebar"]')).toBeVisible({ timeout: 15_000 })
    await expect(page.getByRole('dialog', { name: 'Set up Clawboo' })).toHaveCount(0)

    // THE regression: reload must keep the user on the dashboard, not a wizard.
    await page.reload()

    await expect(page.locator('[data-testid="team-sidebar"]')).toBeVisible({ timeout: 15_000 })
    await expect(page.getByTestId('choose-runtime-step')).toHaveCount(0)
    await expect(page.getByRole('dialog', { name: 'Set up Clawboo' })).toHaveCount(0)
  })
})
