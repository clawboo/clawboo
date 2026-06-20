// Coding-agent first-run (the dead-end regression): picking a coding agent
// (Claude Code) on the FIRST onboarding screen must REACH the dashboard, not
// strand the user in the Gateway-only team → deploy flow (no GatewayClient is
// ever created on this path). The ConnectAgents step's Skip/Continue completes
// onboarding client-free; the user lands in the dashboard (no team seeded — the
// landing surface is Atlas) and adds a team from Capabilities later.

import { test, expect, API_BASE, assertSandboxed } from './helpers/fixtures'

test.describe('Coding-agent onboarding', () => {
  test('fresh install → pick Claude Code → Skip connecting agents → land in dashboard', async ({
    page,
    request,
  }) => {
    await assertSandboxed(request)

    // Fresh state: no teams, no native agents. A prior spec (the native
    // onboarding happy path) seeds a team + native agents; without clearing
    // them the bootstrap takes its native-mode RELOAD path (straight to the
    // dashboard) instead of showing the wizard, so we'd never exercise the
    // coding-agent first-run at all.
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

    // Clear any onboarding markers so the wizard runs fresh.
    await page.addInitScript(() => {
      localStorage.removeItem('clawboo.onboarded')
      localStorage.removeItem('clawboo.wizard.active')
      localStorage.removeItem('clawboo.wizard.runtime')
    })

    // Report OpenClaw as NOT configured so the bootstrap shows the wizard.
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

    // Keep the ConnectAgents step deterministic (no live CLI-health probing).
    await page.route('**/api/runtimes', async (route) => {
      if (route.request().method() !== 'GET') return route.fallback()
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ runtimes: [], available: [] }),
      })
    })

    await page.goto('/')

    // Welcome → Choose runtime.
    await page.getByRole('button', { name: /Get Started/ }).click()
    await expect(page.getByTestId('choose-runtime-step')).toBeVisible({ timeout: 10_000 })

    // Pick a coding agent (Claude Code) — a secondary card on the picker.
    await page.getByTestId('runtime-pick-claude-code').click()

    // The connect-agents step is reached without a Gateway client; Skip finishes.
    await expect(page.getByTestId('connect-agents-step')).toBeVisible({ timeout: 10_000 })
    await page.getByTestId('connect-agents-skip').click()

    // Landed in the dashboard shell — NOT trapped on an inert team step or a
    // blank deploy overlay. The persistent left rail is present and the wizard
    // is gone.
    await expect(page.locator('[data-testid="team-sidebar"]')).toBeVisible({ timeout: 15_000 })
    await expect(page.getByTestId('connect-agents-step')).toHaveCount(0)
    await expect(page.getByRole('dialog', { name: 'Set up Clawboo' })).toHaveCount(0)
  })
})
