import { test, expect, connectToMockGateway } from './helpers/fixtures'

test.describe('Ghost Graph', () => {
  test('Atlas tab shows React Flow canvas', async ({ page, request, gateway }) => {
    await connectToMockGateway(page, request, gateway.url)

    // The default nav slot ('graph') now renders the Atlas all-teams view —
    // its toolbar title is "Atlas — All Teams" (see GhostGraphPanel.tsx:103).
    await expect(page.getByRole('main').getByText('Atlas — All Teams')).toBeVisible({
      timeout: 5_000,
    })

    // React Flow renders a container with class .react-flow
    const reactFlow = page.locator('.react-flow')
    await expect(reactFlow).toBeVisible({ timeout: 10_000 })

    // Click an agent to switch to chat, then click Atlas nav button to return.
    // Use Research Boo (a2) — always in the Default team, unlike Test Boo (a1, Boo Zero).
    const agentRow = page.locator('[data-testid="fleet-agent-row-a2"]')
    await agentRow.click()
    // Wait for chat to render (heading visible means we switched away from graph)
    await expect(page.getByRole('heading', { name: 'Research Boo' })).toBeVisible({
      timeout: 5_000,
    })

    // Click Atlas nav button in agent list column to switch back
    const sidebar = page.locator('[data-testid="agent-list-column"]')
    await sidebar.locator('button:has-text("Atlas")').click()
    await expect(reactFlow).toBeVisible({ timeout: 5_000 })
  })
})
