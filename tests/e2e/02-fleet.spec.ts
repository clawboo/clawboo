import { test, expect, connectToMockGateway } from './helpers/fixtures'

test.describe('Fleet Sidebar', () => {
  test('agents appear in sidebar after connecting', async ({ page, request, gateway }) => {
    await connectToMockGateway(page, request, gateway.url)

    const sidebar = page.locator('[data-testid="agent-list-column"]')

    // Research Boo (a2) is always visible — it's assigned to the auto-created "Default" team.
    // Test Boo (a1) is Boo Zero and excluded from teams, so it may not appear in filtered list.
    await expect(sidebar.getByText('Research Boo')).toBeVisible({ timeout: 5_000 })
  })

  test('clicking agent selects it', async ({ page, request, gateway }) => {
    await connectToMockGateway(page, request, gateway.url)

    const sidebar = page.locator('[data-testid="agent-list-column"]')

    // Wait for Research Boo (a2) — always in the Default team
    await expect(sidebar.getByText('Research Boo')).toBeVisible({ timeout: 5_000 })

    // Click on Research Boo — clicking directly opens agent detail view
    const agentRow = page.locator('[data-testid="fleet-agent-row-a2"]')
    await agentRow.click()

    // The chat panel header should show the selected agent name
    await expect(page.getByRole('heading', { name: 'Research Boo' })).toBeVisible({
      timeout: 5_000,
    })
  })
})
