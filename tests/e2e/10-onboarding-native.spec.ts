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

    // Paste a (fake) key and continue. The connect route writes the vault
    // (offline); no team is created here — real team selection is the next step.
    await page.getByTestId('native-api-key').fill('sk-ant-e2e-fake-key')
    await page.getByTestId('native-continue').click()

    // Add-runtimes comes FIRST (so a connected runtime is assignable to a team) —
    // it's optional; skip it.
    await expect(page.getByTestId('add-runtimes-step')).toBeVisible({ timeout: 10_000 })
    await page.getByTestId('addruntimes-skip').click()

    // Team step: the marketplace opens. Pick a small starter team and deploy it —
    // every agent degrades to clawboo-native (no Gateway), so the deploy is a pure
    // SQLite write and runs fully offline.
    await expect(page.getByTestId('select-team-step')).toBeVisible({ timeout: 10_000 })
    const search = page.getByPlaceholder(/Search teams/)
    await expect(search).toBeVisible({ timeout: 10_000 })
    await search.fill('Research Lab')
    await page.getByTestId('team-card-deploy').first().click()
    // Customize step → deploy the team (creates the native agents in SQLite).
    await page.getByTestId('create-team-deploy').click()

    // "Team is ready" landing (appears once the deploy lands) → open the dashboard.
    await expect(page.getByTestId('native-ready-step')).toBeVisible({ timeout: 30_000 })
    await page.getByTestId('native-open-dashboard').click()

    // Wizard fully exits before asserting the dashboard (avoid racing the
    // AnimatePresence exit animation).
    await expect(page.getByTestId('native-ready-step')).toHaveCount(0)

    // Landed in the dashboard with the DEPLOYED team showing — the group-chat row
    // appears once the selected team has agents (proves a real team was deployed).
    const sidebar = page.locator('[data-testid="agent-list-column"]')
    await expect(sidebar).toBeVisible({ timeout: 15_000 })
    await expect(page.getByTestId('group-chat-row')).toBeVisible({ timeout: 15_000 })
  })
})
