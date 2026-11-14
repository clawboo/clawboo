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
    // A team's agents show as mascot tiles; with no team selected, as list rows.
    const agentRow = page
      .locator('[data-testid="teamspace-mascot-a2"], [data-testid="fleet-agent-row-a2"]')
      .first()
    await agentRow.click()

    // The chat panel header should show the selected agent name
    await expect(page.getByRole('heading', { name: 'Research Boo' })).toBeVisible({
      timeout: 5_000,
    })
  })

  test('the agent page names its files tab Computer, and Settings keeps Workspace', async ({
    page,
    request,
    gateway,
  }) => {
    await connectToMockGateway(page, request, gateway.url)

    const sidebar = page.locator('[data-testid="agent-list-column"]')
    await expect(sidebar.getByText('Research Boo')).toBeVisible({ timeout: 5_000 })
    await page
      .locator('[data-testid="teamspace-mascot-a2"], [data-testid="fleet-agent-row-a2"]')
      .first()
      .click()

    // "Workspace" means a whole Clawboo, so the agent's own tab is Computer.
    const details = page.getByRole('tablist', { name: 'Agent details' })
    await expect(details.getByRole('tab', { name: 'Computer' })).toBeVisible({ timeout: 5_000 })
    await expect(details.getByRole('tab', { name: 'Workspace' })).toHaveCount(0)

    // Settings still groups the install-wide panes under Workspace.
    await sidebar.locator('[data-testid="nav-settings"]').click()
    const settings = page.locator('[data-testid="settings-modal"]')
    await expect(settings).toBeVisible({ timeout: 5_000 })
    await expect(settings.getByText('Workspace', { exact: true })).toBeVisible()
  })
})
