// OpenClaw on the ChatGPT subscription — the onboarding Add-runtimes OpenClaw
// row's in-place setup (OpenClawInlineSetup): fresh install → native connect →
// Add-runtimes → expand the OpenClaw row → Set up OpenClaw → the auto-configure
// needsCodexAuth rung surfaces the subscription panel (the NON-destructive
// `openclaw models auth login` command, no key prompt, an explicit key escape
// hatch) → Re-check re-runs auto-configure onto the oauth-profile rung.
//
// What is mocked vs real: `GET /api/system/status` (installed-but-unconfigured)
// and `POST /api/system/auto-configure-openclaw` (both rungs key off the
// developer machine's REAL auth state — codex login + OpenClaw profiles — which
// e2e can't drive headlessly), plus `POST /api/system/gateway` (never spawn a
// real Gateway in e2e). The REAL rung selection + keyless config write are
// covered by the server unit tests (openclawCodexAuth.test.ts); the wizard
// ConfigureStep's ChatGPT method is covered by ConfigureStep.test.tsx.

import { test, expect, API_BASE, assertSandboxed } from './helpers/fixtures'

test.describe('OpenClaw ChatGPT-subscription onboarding', () => {
  test('Add-runtimes OpenClaw setup → ChatGPT-subscription panel → Re-check proceeds keylessly', async ({
    page,
    request,
  }) => {
    await assertSandboxed(request)

    // Fresh state (mirrors specs 10-13): leftover teams/agents from spec 13 would
    // flip the bootstrap into dashboard/native mode UNDERNEATH the wizard overlay
    // (reconnect banner + toasts intercept clicks).
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

    // OpenClaw INSTALLED but NOT configured → the bootstrap shows the wizard and
    // the inline setup skips the install SSE.
    await page.route('**/api/system/status', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          node: { version: 'v22.0.0', major: 22, sufficient: true, path: '/usr/bin/node' },
          openclaw: {
            installed: true,
            version: '2026.5.27',
            path: '/usr/local/bin/openclaw',
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

    // The auto-configure rungs: first pass → the subscription exists (codex
    // login) but OpenClaw holds no profile → needsCodexAuth + the login command;
    // after the user "runs the login" and clicks Re-check → configured keylessly.
    // Mocked because both signals are the developer machine's real auth state —
    // the REAL rung + config-write behavior is covered by the server unit tests
    // (openclawCodexAuth.test.ts).
    let autoCalls = 0
    await page.route('**/api/system/auto-configure-openclaw', async (route) => {
      autoCalls += 1
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(
          autoCalls === 1
            ? {
                ok: false,
                needsCodexAuth: true,
                loginCommand: 'openclaw models auth login --provider openai-codex',
              }
            : { ok: true, gatewayUrl: 'ws://localhost:18789', provider: 'openai-codex' },
        ),
      })
    })

    // Never spawn a real Gateway from e2e — suppress the start SSE (the inline
    // setup lands on its error panel, far enough: the subscription phases have
    // already been proven).
    await page.route('**/api/system/gateway', async (route) => {
      if (route.request().method() !== 'POST') return route.fallback()
      await route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: 'data: {"type":"error","message":"e2e: gateway start suppressed"}\n\n',
      })
    })

    // The one-click sign-in stream: the server-side relay is unit-tested
    // (cliLogin.test.ts); here the mocked SSE mirrors the BROWSER-PKCE flow we
    // spawn (auth-url, no device code) and the verified completion auto-chains
    // back into the setup.
    await page.route('**/api/auth/cli-login/openclaw', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body:
          'data: {"type":"output","line":"Browser will open for OpenAI authentication."}\n\n' +
          'data: {"type":"auth-url","url":"https://auth.openai.com/oauth/authorize?x=1"}\n\n' +
          'data: {"type":"complete","success":true,"loggedIn":true}\n\n',
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

    // Welcome → native connect (a key, the plain path) → Add-runtimes.
    await page.getByRole('button', { name: /Get Started/ }).click()
    await expect(page.getByTestId('configure-native-step')).toBeVisible({ timeout: 10_000 })
    // OpenAI is the default card (ChatGPT sign-in, no key field); pick Anthropic.
    await page.getByTestId('native-provider-anthropic').click()
    await page.getByTestId('native-api-key').fill('sk-ant-e2e-fake-key')
    await page.getByTestId('native-continue').click()
    await expect(page.getByTestId('add-runtimes-step')).toBeVisible({ timeout: 15_000 })

    // The OpenClaw row's in-place setup (OpenClawInlineSetup): expand the row
    // first (the setup button lives in the accordion body), then start setup.
    await page.getByTestId('runtime-list-row-openclaw-toggle').click()
    await page.getByTestId('addruntimes-setup-openclaw').click()

    // Rung 3 surfaces the QUIET ChatGPT-subscription panel: detection-framed
    // ("Codex is connected"), the one-click sign-in (the NON-destructive login
    // command lives in the flow's failure states — never `openclaw onboard`),
    // an explicit key escape hatch — and NO key prompt on the subscription path.
    const panel = page.getByTestId('openclaw-inline-codex-auth')
    await expect(panel).toBeVisible({ timeout: 10_000 })
    await expect(panel).toContainText('Codex is connected')
    await expect(page.getByTestId('openclaw-inline-key')).toHaveCount(0)
    await expect(page.getByTestId('openclaw-inline-use-key')).toBeVisible()
    await expect(page.getByTestId('openclaw-inline-codex-recheck')).toBeVisible()

    // One-click sign-in: the verified completion AUTO-chains back into the
    // setup — auto-configure re-runs onto the oauth-profile rung with NO manual
    // Re-check. (The mocked stream completes instantly, so the transient
    // device-code display is asserted in ChatGptSignIn.test.tsx, where the
    // stream is held open — not here.)
    await page.getByTestId('chatgpt-signin-openclaw-start').click()
    await expect.poll(() => autoCalls, { timeout: 10_000 }).toBeGreaterThanOrEqual(2)
  })
})
