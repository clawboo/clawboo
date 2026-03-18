import { test, expect, connectToMockGateway } from './helpers/fixtures'

test.describe('Ghost Graph', () => {
  test('Ghost Graph tab shows React Flow canvas', async ({ page, request, gateway }) => {
    await connectToMockGateway(page, request, gateway.url)

    // The default view is Ghost Graph, so the toolbar title in the main content area should be visible
    await expect(page.getByRole('main').getByText('Ghost Graph')).toBeVisible({ timeout: 5_000 })

    // React Flow renders a container with class .react-flow
    const reactFlow = page.locator('.react-flow')
    await expect(reactFlow).toBeVisible({ timeout: 10_000 })

    // Click an agent to switch to chat, then click Ghost Graph nav button to return
    const agentRow = page.locator('[data-testid="fleet-agent-row-a1"]')
    await agentRow.click()
    // Wait for chat to render (heading visible means we switched away from graph)
    await expect(page.getByRole('heading', { name: 'Test Boo' })).toBeVisible({ timeout: 5_000 })

    // Click Ghost Graph nav button in agent list column to switch back
    const sidebar = page.locator('[data-testid="agent-list-column"]')
    await sidebar.locator('button:has-text("Ghost Graph")').click()
    await expect(reactFlow).toBeVisible({ timeout: 5_000 })
  })
})
