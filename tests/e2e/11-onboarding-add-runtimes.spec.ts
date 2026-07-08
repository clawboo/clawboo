// The optional "add runtimes" step never strands. In the native-first flow a
// working team is already seeded (ConfigureNative) BEFORE this step, so the
// coding-agent / OpenClaw runtimes here are purely additive: whether the user
// connects one, opens the OpenClaw detour, or just continues, they always land
// in their working native team. This guards the OLD coding-agent-first-choice
// "strand" (a dashboard with nothing in it) from ever returning — the strand is
// now impossible by construction. (The RuntimeConnectionCard connect state
// machine itself is covered by the RTL step tests.)

import { test, expect, API_BASE, assertSandboxed } from './helpers/fixtures'

test.describe('Add-runtimes onboarding step', () => {
  test('seed native team → the add-runtimes surface is present → Continue → land in the working team', async ({
    page,
    request,
  }) => {
    await assertSandboxed(request)

    // Fresh state: no teams, no native agents (a prior run may have seeded some).
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

    // Clear any onboarding markers so the wizard runs fresh; suppress the one-time
    // post-landing tour / guided-first-task so they can't overlay the assertions.
    await page.addInitScript(() => {
      localStorage.removeItem('clawboo.onboarded')
      localStorage.removeItem('clawboo.wizard.active')
      localStorage.setItem('clawboo.tour.shown', '1')
      localStorage.setItem('clawboo.firstTask.shown', '1')
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

    // Keep the AddRuntimes step deterministic (no live CLI-health probing). The
    // coding-runtime cards render off the catalog regardless of live status.
    await page.route('**/api/runtimes', async (route) => {
      if (route.request().method() !== 'GET') return route.fallback()
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ runtimes: [], available: [] }),
      })
    })

    await page.goto('/')

    // Welcome → ConfigureNative → seed the starter team.
    await page.getByRole('button', { name: /Get Started/ }).click()
    await expect(page.getByTestId('configure-native-step')).toBeVisible({ timeout: 10_000 })
    await page.getByTestId('native-api-key').fill('sk-ant-e2e-fake-key')
    await page.getByTestId('native-create-team').click()

    // Add-runtimes: the three coding-runtime cards + the OpenClaw detour row are
    // all present (the opt-in surface); the native team is already seeded.
    await expect(page.getByTestId('add-runtimes-step')).toBeVisible({ timeout: 15_000 })
    await expect(page.getByTestId('runtime-card-claude-code')).toBeVisible()
    await expect(page.getByTestId('runtime-card-codex')).toBeVisible()
    await expect(page.getByTestId('runtime-card-hermes')).toBeVisible()
    await expect(page.getByTestId('addruntimes-setup-openclaw')).toBeVisible()

    // Continue → ready → dashboard with the seeded native team STILL present
    // (the add-runtimes step never strands — the team was seeded before it).
    await page.getByTestId('addruntimes-continue').click()
    await expect(page.getByTestId('native-ready-step')).toBeVisible({ timeout: 10_000 })
    await page.getByTestId('native-open-dashboard').click()
    await expect(page.getByTestId('native-ready-step')).toHaveCount(0)

    const sidebar = page.locator('[data-testid="agent-list-column"]')
    await expect(sidebar).toBeVisible({ timeout: 15_000 })
    await expect(sidebar.getByText('Team Lead')).toBeVisible({ timeout: 10_000 })
  })
})
