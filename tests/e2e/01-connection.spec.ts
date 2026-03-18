import { test, expect, connectToMockGateway } from './helpers/fixtures'

test.describe('Gateway Connection', () => {
  test('shows connect screen on first visit', async ({ page }) => {
    // Mark as onboarded so we skip the wizard
    await page.addInitScript(() => {
      localStorage.setItem('clawboo.onboarded', '1')
    })

    // Intercept system status — report OpenClaw as not installed so the
    // "Gateway Offline" overlay condition (!running && installed && configExists) is false.
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
            stateDir: '/tmp',
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

    // Intercept GET /api/settings to return empty — forces connect screen
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

    // After connecting, the fleet sidebar should be visible with agents
    const sidebar = page.locator('[data-testid="agent-list-column"]')
    await expect(sidebar).toBeVisible()
    await expect(sidebar.getByText('Test Boo')).toBeVisible()
    await expect(sidebar.getByText('Research Boo')).toBeVisible()
  })
})
