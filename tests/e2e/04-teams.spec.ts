import { test, expect, connectToMockGateway } from './helpers/fixtures'

test.describe('Teams', () => {
  test('team sidebar shows mascot icon and agents appear after connecting', async ({
    page,
    request,
    gateway,
  }) => {
    await connectToMockGateway(page, request, gateway.url)

    // Team sidebar (Col 1) should be visible
    const teamSidebar = page.locator('[data-testid="team-sidebar"]')
    await expect(teamSidebar).toBeVisible({ timeout: 5_000 })

    // Mascot logo should be in the team sidebar
    const mascot = teamSidebar.locator('img[src="/logo.svg"]')
    await expect(mascot).toBeVisible({ timeout: 5_000 })

    // Agents should appear in the agent list column (Col 2).
    // Research Boo (a2) is always visible — assigned to auto-created "Default" team.
    const agentList = page.locator('[data-testid="agent-list-column"]')
    await expect(agentList.getByText('Research Boo')).toBeVisible({ timeout: 5_000 })
  })

  test('clicking nav buttons switches views', async ({ page, request, gateway }) => {
    await connectToMockGateway(page, request, gateway.url)

    const agentList = page.locator('[data-testid="agent-list-column"]')

    // Default view is Atlas (the 'graph' nav slot now renders the global
    // all-teams view) — scope to main content area to avoid nav button ambiguity
    await expect(page.getByRole('main').getByText('Atlas — All Teams')).toBeVisible({
      timeout: 5_000,
    })

    // Click Marketplace nav button — use testid because button text alone
    // collides with surfaces like the theme-toggle title ("Theme: System ...").
    await agentList.locator('[data-testid="nav-marketplace"]').click()
    await expect(page.getByRole('main').getByText('Marketplace')).toBeVisible({ timeout: 5_000 })

    // Tokens Used moved into the Settings modal (opened from the sidebar gear).
    await agentList.locator('[data-testid="nav-settings"]').click()
    await expect(page.locator('[data-testid="settings-modal"]')).toBeVisible({ timeout: 5_000 })
    await page.locator('[data-testid="settings-nav-cost"]').click()
    await expect(page.getByText('Token usage by team and agent')).toBeVisible({ timeout: 5_000 })

    // Close the modal before clicking a sidebar nav — the scrim covers it.
    await page.locator('[data-testid="settings-close"]').click()
    await expect(page.locator('[data-testid="settings-modal"]')).toHaveCount(0)

    // Click back to Atlas
    await agentList.locator('[data-testid="nav-graph"]').click()
    await expect(page.locator('.react-flow')).toBeVisible({ timeout: 10_000 })
  })

  test('runtime diagnostics drawer opens full-height above the Settings modal', async ({
    page,
    request,
    gateway,
  }) => {
    await connectToMockGateway(page, request, gateway.url)
    const agentList = page.locator('[data-testid="agent-list-column"]')

    // Settings modal defaults to the Runtimes pane, which renders every runtime as a
    // row (RuntimeConnectList). A CONNECTED row shows a "Manage" footer that expands
    // to the inline management body, where a "Details" link opens the diagnostics
    // drawer (the ⓘ header button was folded into Manage). OpenClaw is connected via
    // the mock gateway here, so its Manage → Details is the stable target.
    await agentList.locator('[data-testid="nav-settings"]').click()
    await expect(page.locator('[data-testid="settings-modal"]')).toBeVisible({ timeout: 5_000 })
    await expect(page.locator('[data-testid="runtime-list-row-openclaw"]')).toBeVisible({
      timeout: 5_000,
    })
    await page.locator('[data-testid="runtime-list-row-openclaw-toggle"]').click()
    await page.locator('[data-testid="runtime-openclaw-details"]').click()

    // The drawer is portaled to <body> so it escapes the modal's clipping glass
    // container — assert it renders roughly full viewport height (the regression
    // was it being clipped to the ~640px modal box).
    const drawer = page.locator('[data-testid="runtime-diagnostics-drawer"]')
    await expect(drawer).toBeVisible({ timeout: 5_000 })
    const box = await drawer.boundingBox()
    const vp = page.viewportSize()
    expect(box).not.toBeNull()
    if (box && vp) expect(box.height).toBeGreaterThan(vp.height - 8)
  })

  test('system settings opens maintenance panel', async ({ page, request, gateway }) => {
    await connectToMockGateway(page, request, gateway.url)

    const agentList = page.locator('[data-testid="agent-list-column"]')

    // System moved into the Settings modal. Open the modal from the sidebar
    // gear (testid — `button:has-text("Settings")` would also match the modal's
    // own "Settings" heading + the "System" theme-toggle title), then pick it.
    await agentList.locator('[data-testid="nav-settings"]').click()
    await expect(page.locator('[data-testid="settings-modal"]')).toBeVisible({ timeout: 5_000 })
    await page.locator('[data-testid="settings-nav-system"]').click()

    // MaintenancePanel renders this subtitle
    await expect(page.getByText('Manage your OpenClaw installation')).toBeVisible({
      timeout: 10_000,
    })
  })
})
