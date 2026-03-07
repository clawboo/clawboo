import { test, expect, connectToMockGateway } from './helpers/fixtures'

test.describe('Ghost Graph', () => {
  test('Ghost Graph tab shows React Flow canvas', async ({ page, request, gateway }) => {
    await connectToMockGateway(page, request, gateway.url)

    // The default view is Ghost Graph, so the toolbar title span should be visible
    await expect(page.getByText('Ghost Graph', { exact: true })).toBeVisible({ timeout: 5_000 })

    // React Flow renders a container with class .react-flow
    const reactFlow = page.locator('.react-flow')
    await expect(reactFlow).toBeVisible({ timeout: 10_000 })

    // If we switch to Chat and back, Ghost Graph should still render
    await page.locator('button:has-text("Chat")').click()
    await page.locator('button:has-text("Ghost Graph")').click()
    await expect(reactFlow).toBeVisible({ timeout: 5_000 })
  })
})
