// Native onboarding happy path (the headline ~60-second first-run): a fresh
// install → the native-first wizard → paste a key → seed a starter team → skip
// the optional "add runtimes" step → land in the dashboard with the team
// showing. Native is the DEFAULT (no up-front runtime choice). Fully offline-
// capable — the native connect route only writes the vault and the seed only
// writes SQLite (no Gateway, no live provider call).
//
// The OpenClaw / coding-agent runtime connect flows are covered by the RTL step
// tests (ConfigureNativeStep / AddRuntimesStep / RuntimeConnectionCard) plus the
// existing connected-dashboard e2e; their install-subprocess steps are fragile
// to drive headlessly and are intentionally out of scope here.

import { test, expect, API_BASE, assertSandboxed } from './helpers/fixtures'

test.describe('Native onboarding', () => {
  test('fresh install → paste key → seed team → skip runtimes → land in dashboard', async ({
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

    // Report OpenClaw as NOT configured so the bootstrap shows the wizard (no
    // gateway auto-connect, no offline overlay).
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

    // Welcome → ConfigureNative directly (native is the default — no runtime pick).
    await page.getByRole('button', { name: /Get Started/ }).click()
    await expect(page.getByTestId('configure-native-step')).toBeVisible({ timeout: 10_000 })

    // Paste a (fake) key and create the team. The connect route writes the
    // vault; the seed writes SQLite — both run offline.
    await page.getByTestId('native-api-key').fill('sk-ant-e2e-fake-key')
    await page.getByTestId('native-create-team').click()

    // Optional "add more runtimes" step → skip it.
    await expect(page.getByTestId('add-runtimes-step')).toBeVisible({ timeout: 15_000 })
    await page.getByTestId('addruntimes-skip').click()

    // "Team is ready" landing → open the dashboard.
    await expect(page.getByTestId('native-ready-step')).toBeVisible({ timeout: 10_000 })
    await page.getByTestId('native-open-dashboard').click()

    // Wizard fully exits (its NativeReady roster also renders a "Team Lead"
    // label, so wait for the overlay to be gone before asserting the dashboard
    // — otherwise the assertion races the AnimatePresence exit animation).
    await expect(page.getByTestId('native-ready-step')).toHaveCount(0)

    // Landed in the dashboard with the seeded team showing — scope the lookup
    // to the sidebar agent list (the seeded agent also appears as a graph node).
    const sidebar = page.locator('[data-testid="agent-list-column"]')
    await expect(sidebar).toBeVisible({ timeout: 15_000 })
    await expect(sidebar.getByText('Team Lead')).toBeVisible({ timeout: 10_000 })
  })
})
