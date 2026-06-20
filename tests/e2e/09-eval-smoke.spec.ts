import { test, expect, API_BASE, assertSandboxed } from './helpers/fixtures'

// Proves the eval harness is RUNNABLE from the UI with no setup: open the
// Observability view → click "Run smoke evals" → a real deterministic SuiteReport
// renders (sub-second, no live model). Observability is always on.

async function connect(
  page: import('@playwright/test').Page,
  request: import('@playwright/test').APIRequestContext,
  gatewayUrl: string,
): Promise<void> {
  await assertSandboxed(request)
  await request.post(`${API_BASE}/api/settings`, { data: { gatewayUrl, gatewayToken: '' } })
  await page.addInitScript(() => localStorage.setItem('clawboo.onboarded', '1'))
  await page.route('**/api/system/status', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        node: { version: process.version, major: 22, sufficient: true, path: '/usr/bin/node' },
        openclaw: {
          installed: true,
          version: '0.3.0',
          path: '/usr/bin/openclaw',
          stateDir: '/tmp/.openclaw',
          configExists: true,
          envExists: true,
        },
        gateway: { running: true, port: 18789, pid: null, managedByClawboo: false, uptimeMs: null },
      }),
    })
  })
  await page.goto('/')
}

test.describe('Eval-run-from-UI (smoke)', () => {
  test('Run smoke evals → a real SuiteReport renders', async ({ page, request, gateway }) => {
    test.setTimeout(90_000)
    await connect(page, request, gateway.url)

    // Observability is always available → open it directly.
    await expect(page.locator('[data-testid="nav-obs"]')).toBeVisible({ timeout: 10_000 })
    await page.locator('[data-testid="nav-obs"]').click()
    await expect(page.locator('[data-testid="obs-panel"]')).toBeVisible({ timeout: 10_000 })
    await expect(page.locator('[data-testid="eval-scorecard"]')).toBeVisible()

    // Run the smoke suite → a real SuiteReport renders (deterministic, sub-second).
    await page.locator('[data-testid="obs-run-smoke-evals"]').click()
    await expect(page.locator('[data-testid="eval-suite-report"]')).toBeVisible({ timeout: 30_000 })
    // At least one task row + the 100% pass@1 of the deterministic suite.
    await expect(page.locator('[data-testid="eval-task-row"]').first()).toBeVisible()
    await expect(page.locator('[data-testid="eval-suite-report"]')).toContainText('100%')
  })
})
