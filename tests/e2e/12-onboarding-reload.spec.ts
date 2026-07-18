// Reload stays on the dashboard (the reload-trap regression). After completing
// native onboarding and reaching the dashboard, a page reload must KEEP the user
// there — not re-trap them in a fresh wizard. The durable signal that survives
// the reload is the DEPLOYED native team (GET /api/agents → a clawboo-native
// agent exists → decideOnboardingView returns 'native'), persisted in SQLite.

import { test, expect, API_BASE, assertSandboxed } from './helpers/fixtures'

test.describe('Native onboarding — reload stays on the dashboard', () => {
  test('complete native onboarding → dashboard → reload → still dashboard (no wizard)', async ({
    page,
    request,
  }) => {
    await assertSandboxed(request)

    // Fresh state: no teams, no native agents (a prior spec may have seeded them).
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
    // wiping the `clawboo.onboarded` flag onboarding just set.
    await page.addInitScript(() => {
      if (!sessionStorage.getItem('e2e-cleared')) {
        localStorage.removeItem('clawboo.onboarded')
        localStorage.removeItem('clawboo.wizard.active')
        sessionStorage.setItem('e2e-cleared', '1')
      }
      // Suppress the one-time post-landing tour / guided-first-task.
      localStorage.setItem('clawboo.tour.shown', '1')
      localStorage.setItem('clawboo.firstTask.shown', '1')
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

    // Keep the AddRuntimes step deterministic (no live CLI-health probing).
    await page.route('**/api/runtimes', async (route) => {
      if (route.request().method() !== 'GET') return route.fallback()
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ runtimes: [], available: [] }),
      })
    })

    await page.goto('/')

    // Complete native onboarding: Welcome → ConfigureNative (connect) → pick +
    // deploy a real team → skip runtimes → open the dashboard.
    await page.getByRole('button', { name: /Get Started/ }).click()
    await expect(page.getByTestId('configure-native-step')).toBeVisible({ timeout: 10_000 })
    // OpenAI is the default card (ChatGPT sign-in, no key field); pick Anthropic.
    await page.getByTestId('native-provider-anthropic').click()
    await page.getByTestId('native-api-key').fill('sk-ant-e2e-fake-key')
    await page.getByTestId('native-continue').click()
    // Add-runtimes comes first (optional; a SINGLE forward action) → continue past it,
    // then pick + deploy a real team.
    await expect(page.getByTestId('add-runtimes-step')).toBeVisible({ timeout: 10_000 })
    await page.getByTestId('addruntimes-continue').click()
    await expect(page.getByTestId('select-team-step')).toBeVisible({ timeout: 10_000 })
    const search = page.getByPlaceholder(/Search teams/)
    await expect(search).toBeVisible({ timeout: 10_000 })
    await search.fill('Research Lab')
    await page.getByTestId('team-card-deploy').first().click()
    await page.getByTestId('create-team-deploy').click()
    await expect(page.getByTestId('native-ready-step')).toBeVisible({ timeout: 30_000 })
    await page.getByTestId('native-open-dashboard').click()

    // Landed in the dashboard shell, wizard gone.
    await expect(page.locator('[data-testid="team-sidebar"]')).toBeVisible({ timeout: 15_000 })
    await expect(page.getByRole('dialog', { name: 'Set up Clawboo' })).toHaveCount(0)

    // THE regression: reload must keep the user on the dashboard, not a wizard —
    // the seeded native team (hasNative) is the durable returning-user signal.
    await page.reload()

    await expect(page.locator('[data-testid="team-sidebar"]')).toBeVisible({ timeout: 15_000 })
    await expect(page.getByTestId('configure-native-step')).toHaveCount(0)
    await expect(page.getByRole('dialog', { name: 'Set up Clawboo' })).toHaveCount(0)
  })
})
