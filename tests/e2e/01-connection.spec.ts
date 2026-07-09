import { test, expect, connectToMockGateway } from './helpers/fixtures'

test.describe('Gateway Connection', () => {
  test('shows connect screen on first visit', async ({ page }) => {
    // Mark as onboarded so we skip the wizard; suppress the one-time tour.
    await page.addInitScript(() => {
      localStorage.setItem('clawboo.onboarded', '1')
      localStorage.setItem('clawboo.tour.shown', '1')
      localStorage.setItem('clawboo.firstTask.shown', '1')
    })

    // GatewayBootstrap's wizard-gate logic:
    //   - If openclaw.installed && configExists && envExists → showWizard=false
    //     (returning-user path; falls through to auto-connect → connect screen)
    //   - Otherwise → showWizard=true (the install wizard renders, NOT the
    //     connect screen)
    //
    // To reach the connect screen we need to report a fully-configured
    // OpenClaw with the Gateway already running (otherwise the "Gateway
    // Offline" overlay catches us). The connect screen renders because the
    // mocked /api/settings below returns no gatewayUrl, so auto-connect
    // bails and the bootstrap falls through to GatewayConnectScreen.
    await page.route('**/api/system/status', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          node: { version: 'v22.0.0', major: 22, sufficient: true, path: '/usr/bin/node' },
          openclaw: {
            installed: true,
            version: '0.3.0',
            path: '/usr/bin/openclaw',
            stateDir: '/tmp/.openclaw',
            configExists: true,
            envExists: true,
          },
          gateway: {
            running: true,
            port: 18789,
            pid: null,
            managedByClawboo: false,
            uptimeMs: null,
          },
        }),
      })
    })

    // Intercept GET /api/settings to return empty — forces auto-connect to
    // bail, which makes GatewayBootstrap render the connect screen as
    // fallback.
    await page.route('**/api/settings', async (route) => {
      if (route.request().method() === 'GET') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ gatewayUrl: '', hasToken: false }),
        })
      } else {
        await route.continue()
      }
    })

    await page.goto('/')

    // Connect screen should appear since auto-connect has no URL
    const connectScreen = page.locator('[data-testid="gateway-connect-screen"]')
    await expect(connectScreen).toBeVisible({ timeout: 15_000 })

    // Verify key form elements are present
    await expect(page.locator('[data-testid="gateway-url-input"]')).toBeVisible()
    await expect(page.locator('[data-testid="gateway-connect-button"]')).toBeVisible()
    await expect(page.getByText('Connect to an OpenClaw Gateway')).toBeVisible()
  })

  test('can connect to mock gateway', async ({ page, request, gateway }) => {
    await connectToMockGateway(page, request, gateway.url)

    // After connecting, the fleet sidebar should be visible with agents.
    // Note: Test Boo (a1) is Boo Zero and excluded from auto-created "Default" team,
    // so it may not appear in the team-filtered list. Check Research Boo (a2) which is always in the team.
    const sidebar = page.locator('[data-testid="agent-list-column"]')
    await expect(sidebar).toBeVisible()
    await expect(sidebar.getByText('Research Boo')).toBeVisible({ timeout: 10_000 })
  })
})
