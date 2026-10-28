// Native onboarding on a local Ollama: no API key and no OLLAMA_BASE_URL (the
// e2e server sets neither). Picking Ollama on the connect step is the whole setup,
// so after it the native runtime must read connected, a deployed team and the
// universal Boo Zero must run on Ollama, and the 1:1 composer must be live.
//
// Offline-capable: the pre-advance healthcheck is route-stubbed (the spec asserts
// it ran). The model list and the deploy-time default are read server-side from
// whatever Ollama this machine runs, falling back to llama3.2 when none answers
// (CI), so the model assertion follows the server's own recommendation. No message
// is sent, so no model is needed. The server state is asserted over the API as well as in the
// page, because the "Led by Boo Zero" badge alone would also render for an
// OpenClaw Boo Zero left in the shared e2e database by an earlier spec.

import type { APIRequestContext } from '@playwright/test'

import { test, expect, API_BASE, assertSandboxed, stubNativeHealthcheck } from './helpers/fixtures'

interface NativeStatus {
  connectionState?: string
  hasCredential?: boolean
  ollamaConnected?: boolean
}

async function nativeStatus(request: APIRequestContext): Promise<NativeStatus> {
  const resp = await request.get(`${API_BASE}/api/runtimes`)
  expect(resp.ok()).toBe(true)
  const body = (await resp.json()) as { runtimes: ({ id: string } & NativeStatus)[] }
  const native = body.runtimes.find((r) => r.id === 'clawboo-native')
  expect(native).toBeTruthy()
  return native!
}

test.describe('Native onboarding on a local Ollama', () => {
  test('pick Ollama (no key, no env var) → deploy → agents and Boo Zero on Ollama, 1:1 chat live', async ({
    page,
    request,
  }) => {
    await assertSandboxed(request)

    // Start keyless: an earlier spec stores a native key in this shared server's
    // vault, and with one present the run would never exercise the Ollama path.
    // A full native disconnect clears every native slot (and records Ollama as
    // removed); the Ollama connect below picks it again and lifts the disconnect.
    await request.post(`${API_BASE}/api/runtimes/clawboo-native/disconnect`)
    const teamsResp = await request.get(`${API_BASE}/api/teams`)
    if (teamsResp.ok()) {
      const data = (await teamsResp.json()) as { teams?: { id: string }[] }
      for (const team of data.teams ?? []) await request.delete(`${API_BASE}/api/teams/${team.id}`)
    }
    const agentsResp = await request.get(`${API_BASE}/api/agents`)
    if (agentsResp.ok()) {
      const data = (await agentsResp.json()) as { agents?: { id: string; runtime?: string }[] }
      for (const a of data.agents ?? []) {
        if (a.runtime === 'clawboo-native' || a.id.startsWith('native-')) {
          await request.delete(`${API_BASE}/api/agents/${a.id}`)
        }
      }
    }
    // A Boo Zero override left by an earlier spec would hide the native Boo Zero
    // this spec asserts on.
    await request.post(`${API_BASE}/api/boo-zero/override`, { data: { agentId: null } })
    expect((await nativeStatus(request)).connectionState).toBe('needs-auth')

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
          node: {
            version: 'v22.23.2',
            major: 22,
            sufficient: true,
            required: '>=22.22.3 <23 || >=24.15.0 <25 || >=25.9.0',
            path: '/usr/bin/node',
          },
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

    // Continue checks the local daemon first; stub that probe so no Ollama is needed.
    const healthcheck = await stubNativeHealthcheck(page)

    await page.goto('/')
    await page.getByRole('button', { name: /Get Started/ }).click()
    await expect(page.getByTestId('configure-native-step')).toBeVisible({ timeout: 10_000 })

    // Ollama hides the key field: there is nothing to paste.
    await page.getByTestId('native-provider-ollama').click()
    await expect(page.getByTestId('native-api-key')).toHaveCount(0)
    await page.getByTestId('native-continue').click()

    await expect(page.getByTestId('add-runtimes-step')).toBeVisible({ timeout: 10_000 })
    expect(healthcheck.calls()).toBe(1)

    // The pick alone readied the runtime: connected, with no key behind it.
    const afterPick = await nativeStatus(request)
    expect(afterPick.connectionState).toBe('ready')
    expect(afterPick.ollamaConnected).toBe(true)
    expect(afterPick.hasCredential).toBe(false)

    await page.getByTestId('addruntimes-continue').click()
    await expect(page.getByTestId('select-team-step')).toBeVisible({ timeout: 10_000 })
    const search = page.getByPlaceholder(/Search teams/)
    await expect(search).toBeVisible({ timeout: 10_000 })
    await search.fill('Research Lab')
    await page.getByTestId('team-card-deploy').first().click()

    // Native is available, so no member row degrades with an "unavailable" note.
    await expect(page.getByTestId('create-team-deploy')).toBeVisible({ timeout: 10_000 })
    await expect(page.getByText(/unavailable · using/)).toHaveCount(0)
    await page.getByTestId('create-team-deploy').click()

    await expect(page.getByTestId('native-ready-step')).toBeVisible({ timeout: 30_000 })
    await expect(page.getByTestId('led-by-boo-zero-badge')).toBeVisible({ timeout: 10_000 })

    // Every native agent, the universal Boo Zero included, runs on the Ollama model.
    const listed = await request.get(`${API_BASE}/api/agents`)
    expect(listed.ok()).toBe(true)
    const { agents, defaultId } = (await listed.json()) as {
      agents: { id: string; runtime?: string; teamId?: string | null; model?: string | null }[]
      defaultId?: string | null
    }
    const booZero = agents.find((a) => a.id === defaultId)
    expect(booZero?.runtime).toBe('clawboo-native')
    expect(booZero?.teamId ?? null).toBeNull()
    const natives = agents.filter((a) => a.runtime === 'clawboo-native')
    expect(natives.length).toBeGreaterThan(1)
    const pulled = await request.get(`${API_BASE}/api/providers/ollama/models`)
    expect(pulled.ok()).toBe(true)
    const { recommendedModel } = (await pulled.json()) as { recommendedModel: string }
    for (const a of natives) expect(a.model).toBe(recommendedModel)

    await page.getByTestId('native-open-dashboard').click()
    await expect(page.getByTestId('native-ready-step')).toHaveCount(0)
    await expect(page.locator('[data-testid="agent-list-column"]')).toBeVisible({ timeout: 15_000 })

    // The 1:1 chat is live: no "Disconnected" chip, and the composer takes input.
    await page.getByRole('button', { name: 'Data Analyst Boo', exact: true }).click()
    const chat = page.getByTestId('chat-panel')
    await expect(chat).toBeVisible({ timeout: 10_000 })
    await expect(chat.getByRole('textbox')).toBeEnabled({ timeout: 10_000 })
    await expect(page.getByTestId('native-disconnected-chip')).toHaveCount(0)
  })
})
