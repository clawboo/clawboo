// A REAL mid-session WebSocket drop, end to end: browser → /api/gateway/ws proxy
// → mock Gateway. Killing the upstream makes the proxy close the browser socket
// with 1012, which is a non-manual close — so the browser GatewayClient goes to
// `reconnecting` and starts its own backoff. This is the exact scenario from
// issue #67 (machine sleep / Gateway restart), and the only place it can be
// exercised against a real socket rather than a faked client.

import { test, expect, connectToMockGateway } from './helpers/fixtures'

test.describe('Live Gateway reconnect', () => {
  test('a dropped socket surfaces the banner, keeps the workspace, and self-heals', async ({
    page,
    request,
    gateway,
  }) => {
    await connectToMockGateway(page, request, gateway.url)

    const banner = page.locator('[data-testid="gateway-live-reconnect-banner"]')
    const connectScreen = page.locator('[data-testid="gateway-connect-screen"]')
    const sidebar = page.locator('[data-testid="agent-list-column"]')

    // Baseline: connected, no banner.
    await expect(banner).toBeHidden()

    // Kill the live connection but keep listening, so the client's retry can land.
    gateway.dropConnections()

    // 1. The drop is reflected in the UI.
    await expect(banner).toBeVisible({ timeout: 15_000 })
    await expect(banner).toContainText('Reconnecting to Gateway')

    // 2. It is NON-BLOCKING: the workspace stays, and the full-screen connect
    //    modal must NOT appear. Before this change every overlay was gated on a
    //    strict `status === 'connected'`, so a blip threw that modal over a
    //    working dashboard — this is the regression this test exists to catch.
    await expect(sidebar).toBeVisible()
    await expect(sidebar.getByText('Research Boo')).toBeVisible()
    await expect(connectScreen).toHaveCount(0)

    // 3. The client reconnects on its own backoff (800ms, then x1.7) and the
    //    banner clears without the user touching anything.
    await expect(banner).toBeHidden({ timeout: 30_000 })
    await expect(sidebar.getByText('Research Boo')).toBeVisible()
  })

  test('"Connect manually" escapes a Gateway that never comes back', async ({
    page,
    request,
    gateway,
  }) => {
    await connectToMockGateway(page, request, gateway.url)

    const banner = page.locator('[data-testid="gateway-live-reconnect-banner"]')

    // Stop listening entirely, then drop: every retry now fails, so the client
    // would spin on `reconnecting` forever. Without an escape the user could
    // never reach the connect form again.
    gateway.close()
    gateway.dropConnections()

    await expect(banner).toBeVisible({ timeout: 15_000 })

    await page.locator('[data-testid="gateway-live-reconnect-manual"]').click()

    // The retry loop is stopped and the manual connect screen takes over.
    await expect(page.locator('[data-testid="gateway-connect-screen"]')).toBeVisible({
      timeout: 15_000,
    })
    await expect(banner).toBeHidden()
  })
})
