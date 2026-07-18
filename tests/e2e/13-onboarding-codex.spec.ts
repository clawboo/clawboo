// Codex (ChatGPT-subscription) onboarding happy path — the keyless first-run: a
// fresh install → the wizard → the OpenAI card → "Sign in with ChatGPT" (already
// signed in via the user's own terminal `codex login`, mocked here as a ready
// probe) → deploy a marketplace team → land in the dashboard with a CODEX-LED
// team showing. Mirrors 10-onboarding-native, swapping the pasted key for the
// subscription path.
//
// What is mocked vs real: `GET /api/runtimes` is route-mocked to report codex
// installed + ready (the real probe shells out to `codex login status`, which is
// machine-dependent). Everything downstream is REAL: the deploy writes real codex
// agent rows (RuntimeAgentSource → SQLite), the Boo Zero override POST validates
// the created agent and persists the setting, and the "Led by" badge renders only
// when `GET /api/agents` `defaultId` resolves — which on a pure-codex install
// (no native key path exercised, no Gateway) happens ONLY via that override.

import { test, expect, API_BASE, assertSandboxed } from './helpers/fixtures'

test.describe('Codex onboarding', () => {
  test('fresh install → Sign in with ChatGPT → deploy team → Codex-led dashboard', async ({
    page,
    request,
  }) => {
    await assertSandboxed(request)

    // Fresh state: earlier specs (10-12) leave teams, native agents, a native Boo
    // Zero, and a vault key behind. Delete teams + native/codex agents (the Boo
    // Zero resolvers validate agent ROWS, so deleting them flushes the chain even
    // though the vault key persists) and clear any override from a prior run.
    // DELIBERATELY KEPT: the teamless OpenClaw "Test Boo" the mock-gateway specs
    // synced into SQLite — `resolveBooZero` falls back to it (tier `openclaw`),
    // and this spec proves the codex-preferred deploy OUTRANKS that weak fallback
    // (an OpenClaw `main` leading a codex team is the "unresponsive first team"
    // class) while a deliberate override/native Boo Zero is never stomped.
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
          a.runtime === 'codex' ||
          a.sourceId === 'codex' ||
          a.id.startsWith('native-')
        ) {
          await request.delete(`${API_BASE}/api/agents/${a.id}`)
        }
      }
    }
    await request.post(`${API_BASE}/api/boo-zero/override`, { data: { agentId: null } })

    await page.addInitScript(() => {
      localStorage.removeItem('clawboo.onboarded')
      localStorage.removeItem('clawboo.wizard.active')
      localStorage.setItem('clawboo.tour.shown', '1')
      localStorage.setItem('clawboo.firstTask.shown', '1')
    })

    // OpenClaw NOT configured → the bootstrap shows the wizard.
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

    // Codex installed + signed in. This one mock feeds all three consumers: the
    // ConfigureNativeStep ChatGPT probe (→ ready), the AddRuntimes step, and the
    // CreateTeamModal availability check (codex must be ready or every agent
    // would degrade to native).
    await page.route('**/api/runtimes', async (route) => {
      if (route.request().method() !== 'GET') return route.fallback()
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          runtimes: [
            {
              id: 'codex',
              name: 'Codex',
              installed: true,
              authKind: 'oauth',
              loggedIn: true,
              connectionState: 'ready',
            },
          ],
          available: [],
        }),
      })
    })

    await page.goto('/')

    // Welcome → ConfigureNative. Pick the OpenAI card — Sign in with ChatGPT is
    // the DEFAULT method (Recommended) and the mocked probe reads ready.
    await page.getByRole('button', { name: /Get Started/ }).click()
    await expect(page.getByTestId('configure-native-step')).toBeVisible({ timeout: 10_000 })
    await page.getByTestId('native-provider-openai').click()
    await expect(page.getByTestId('native-auth-chatgpt')).toHaveAttribute('aria-checked', 'true')
    await expect(page.getByTestId('native-chatgpt-ready')).toBeVisible({ timeout: 10_000 })
    // No key was typed anywhere — the subscription IS the credential.
    await page.getByTestId('native-continue').click()

    // Add-runtimes (optional) → continue.
    await expect(page.getByTestId('add-runtimes-step')).toBeVisible({ timeout: 10_000 })
    await page.getByTestId('addruntimes-continue').click()

    // Team step — the subtitle names the subscription path, and the deploy
    // defaults every agent to codex (preferRuntime='codex').
    await expect(page.getByTestId('select-team-step')).toBeVisible({ timeout: 10_000 })
    await expect(page.getByText(/ChatGPT subscription/)).toBeVisible()
    const search = page.getByPlaceholder(/Search teams/)
    await expect(search).toBeVisible({ timeout: 10_000 })
    await search.fill('Research Lab')
    await page.getByTestId('team-card-deploy').first().click()
    await page.getByTestId('create-team-deploy').click()

    // "Team is ready" — THE end-to-end proof of a Codex-led install: the badge
    // renders only when `defaultId` resolves, which here requires the deploy to
    // have (a) created real codex agent rows, (b) designated a lead, and (c)
    // promoted it via the Boo Zero override (no native key, no Gateway — nothing
    // else in the resolution chain can produce a leader).
    await expect(page.getByTestId('native-ready-step')).toBeVisible({ timeout: 30_000 })
    await expect(page.getByTestId('led-by-boo-zero-badge')).toBeVisible({ timeout: 10_000 })

    // The designated universal leader is a CODEX agent (server-verified, not UI).
    const override = await request.get(`${API_BASE}/api/boo-zero/override`)
    expect(override.ok()).toBe(true)
    const { effective } = (await override.json()) as { effective: { id: string } | null }
    expect(effective).not.toBeNull()
    const leader = await request.get(`${API_BASE}/api/agents/${effective!.id}`)
    expect(leader.ok()).toBe(true)
    const leaderBody = (await leader.json()) as { agent?: { runtime?: string } }
    expect(leaderBody.agent?.runtime).toBe('codex')

    await page.getByTestId('native-open-dashboard').click()
    await expect(page.getByTestId('native-ready-step')).toHaveCount(0)

    // Landed in the dashboard with the deployed team showing.
    const sidebar = page.locator('[data-testid="agent-list-column"]')
    await expect(sidebar).toBeVisible({ timeout: 15_000 })
    await expect(page.getByTestId('group-chat-row')).toBeVisible({ timeout: 15_000 })
  })
})
