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

    // Click Marketplace nav button
    await agentList.locator('button:has-text("Marketplace")').click()
    await expect(page.getByRole('main').getByText('Marketplace')).toBeVisible({ timeout: 5_000 })

    // Click Tokens Used nav button
    await agentList.locator('button:has-text("Tokens Used")').click()
    await expect(page.getByText('Token usage by team and agent')).toBeVisible({ timeout: 5_000 })

    // Click back to Atlas
    await agentList.locator('button:has-text("Atlas")').click()
    await expect(page.locator('.react-flow')).toBeVisible({ timeout: 10_000 })
  })

  test('system nav button opens maintenance panel', async ({ page, request, gateway }) => {
    await connectToMockGateway(page, request, gateway.url)

    const agentList = page.locator('[data-testid="agent-list-column"]')

    // Click System nav button in secondary nav
    await agentList.locator('button:has-text("System")').click()

    // MaintenancePanel renders this subtitle
    await expect(page.getByText('Manage your OpenClaw installation')).toBeVisible({
      timeout: 10_000,
    })
  })
})
