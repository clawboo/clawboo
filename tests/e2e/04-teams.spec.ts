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

    // Agents should appear in the agent list column (Col 2)
    const agentList = page.locator('[data-testid="agent-list-column"]')
    await expect(agentList.getByText('Test Boo')).toBeVisible({ timeout: 5_000 })
  })

  test('clicking nav buttons switches views', async ({ page, request, gateway }) => {
    await connectToMockGateway(page, request, gateway.url)

    const agentList = page.locator('[data-testid="agent-list-column"]')

    // Default view is Ghost Graph — scope to main content area to avoid nav button ambiguity
    await expect(page.getByRole('main').getByText('Ghost Graph')).toBeVisible({ timeout: 5_000 })

    // Click Marketplace nav button
    await agentList.locator('button:has-text("Marketplace")').click()
    await expect(page.getByText('Skill Marketplace')).toBeVisible({ timeout: 5_000 })

    // Click Cost nav button
    await agentList.locator('button:has-text("Cost")').click()
    await expect(page.getByText('Cost Tracking')).toBeVisible({ timeout: 5_000 })

    // Click back to Ghost Graph
    await agentList.locator('button:has-text("Ghost Graph")').click()
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
