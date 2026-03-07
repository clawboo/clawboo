import { test, expect, connectToMockGateway } from './helpers/fixtures'

test.describe('Fleet Sidebar', () => {
  test('agents appear in sidebar after connecting', async ({ page, request, gateway }) => {
    await connectToMockGateway(page, request, gateway.url)

    const sidebar = page.locator('[data-testid="fleet-sidebar"]')

    // Both mock agents should be visible
    await expect(sidebar.getByText('Test Boo')).toBeVisible({ timeout: 5_000 })
    await expect(sidebar.getByText('Research Boo')).toBeVisible({ timeout: 5_000 })
  })

  test('clicking agent selects it', async ({ page, request, gateway }) => {
    await connectToMockGateway(page, request, gateway.url)

    const sidebar = page.locator('[data-testid="fleet-sidebar"]')

    // Wait for agents to load
    await expect(sidebar.getByText('Test Boo')).toBeVisible({ timeout: 5_000 })

    // Click on the first agent row
    const agentRow = page.locator('[data-testid="fleet-agent-row-a1"]')
    await agentRow.click()

    // Switch to chat view to confirm the selected agent appears
    await page.locator('button:has-text("Chat")').click()

    // The chat panel header should show the selected agent name
    await expect(page.getByRole('heading', { name: 'Test Boo' })).toBeVisible()
  })
})
