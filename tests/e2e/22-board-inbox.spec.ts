import { test, expect, connectToMockGateway, API_BASE } from './helpers/fixtures'
import { startMockGateway, type MockGateway } from './helpers/mockGateway'

// A person's inbox against the real server and database: read state on the server,
// so it survives a reload and a second browser; the badge moved by the event tail
// with no polling; and the layout at a phone's width, which jsdom cannot see.
//
// Tasks are written through the API with no browser metadata, which is how an agent
// or a script looks to the server, so they count as someone else's. None has an
// agent, so no run ever starts.

type Request = import('@playwright/test').APIRequestContext

async function newTask(request: Request, title: string): Promise<string> {
  const r = await request.post(`${API_BASE}/api/board`, { data: { title, status: 'backlog' } })
  const { task } = (await r.json()) as { task: { id: string } }
  return task.id
}

const comment = (request: Request, id: string, body: string): Promise<unknown> =>
  request.post(`${API_BASE}/api/board/${id}/comments`, { data: { body, authorType: 'agent' } })

test.describe('Inbox', () => {
  let ownGateway: MockGateway

  test.beforeAll(async () => {
    ownGateway = await startMockGateway()
  })
  test.afterAll(() => {
    ownGateway.close()
  })

  test('unread clears on open, returns on a comment, and holds across a reload', async ({
    page,
    request,
  }) => {
    test.setTimeout(90_000)
    await connectToMockGateway(page, request, ownGateway.url)
    const id = await newTask(request, 'E2E inbox task')
    const row = page.locator(`[data-testid="inbox-row"][data-task-id="${id}"]`)

    const badgeReads: number[] = []
    page.on('request', (req) => {
      if (req.method() === 'GET' && new URL(req.url()).pathname === '/api/board/inbox') {
        badgeReads.push(Date.now())
      }
    })

    await page.locator('[data-testid="nav-inbox"]').click()
    await page.getByRole('tab', { name: /Unread/ }).click()
    await expect(row).toBeVisible({ timeout: 20_000 })
    await expect(row.locator('[data-testid="inbox-row-unread"]')).toBeVisible()

    // Opening it clears it, through the drawer the board uses.
    await row.click()
    await expect(page.getByRole('heading', { name: 'E2E inbox task' })).toBeVisible()
    await expect(row.locator('[data-testid="inbox-row-unread"]')).toHaveCount(0)
    await page.keyboard.press('Escape')
    await expect(row).toHaveCount(0)

    // Quiet, it reads nothing: the badge has no timer behind it. Opening the task
    // wakes it once, so wait for that to land. A timer would never settle.
    let seen = -1
    await expect
      .poll(
        () => {
          const settled = badgeReads.length === seen
          seen = badgeReads.length
          return settled
        },
        { intervals: [3000], timeout: 30_000 },
      )
      .toBe(true)
    const quiet = badgeReads.length
    await page.waitForTimeout(6000)
    expect(badgeReads.length).toBe(quiet)

    // A comment from someone else brings it back, by way of the event tail.
    await comment(request, id, 'One more thing.')
    await expect(row).toBeVisible({ timeout: 10_000 })
    await expect(page.locator('[data-testid="nav-inbox"]')).toContainText(/\d/, { timeout: 10_000 })
    await expect.poll(() => badgeReads.length, { timeout: 10_000 }).toBeGreaterThan(quiet)

    // Read state lives on the server: a reload does not lose it either way.
    await row.click()
    await expect(row.locator('[data-testid="inbox-row-unread"]')).toHaveCount(0)
    await page.keyboard.press('Escape')
    await page.reload()
    await page.locator('[data-testid="nav-inbox"]').click()
    await page.getByRole('tab', { name: /^All/ }).click()
    await expect(row).toBeVisible({ timeout: 20_000 })
    await expect(row.locator('[data-testid="inbox-row-unread"]')).toHaveCount(0)
  })

  test('holds at a phone’s width', async ({ page, request }) => {
    test.setTimeout(90_000)
    await connectToMockGateway(page, request, ownGateway.url)
    await newTask(request, 'E2E a task with a long title that has to truncate rather than push')
    await newTask(request, 'E2E another task')
    await page.setViewportSize({ width: 390, height: 844 })
    await page.reload()

    const toggle = page.getByRole('button', { name: /Expand sidebar/ }).first()
    await expect(toggle).toBeVisible({ timeout: 20_000 })
    await expect(toggle.locator('[data-testid="sidebar-toggle-inbox-dot"]')).toBeVisible({
      timeout: 20_000,
    })
    await toggle.click()
    await page.locator('[data-testid="nav-inbox"]').click()
    await expect(page.locator('[data-testid="inbox-panel"]')).toBeVisible()

    for (const name of [/Needs you/, /Unread/, /^All/]) {
      await page.getByRole('tab', { name }).click()
      const { scrollWidth, innerWidth } = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth,
      }))
      expect(scrollWidth).toBeLessThanOrEqual(innerWidth)
      const tabs = await page.locator('[role="tablist"]').boundingBox()
      expect(tabs!.x).toBeGreaterThanOrEqual(0)
      expect(tabs!.x + tabs!.width).toBeLessThanOrEqual(innerWidth)
    }

    const first = page.locator('[data-testid="inbox-row"]').first()
    await expect(first).toBeVisible()
    const box = await first.boundingBox()
    expect(box!.x + box!.width).toBeLessThanOrEqual(390)
  })
})
