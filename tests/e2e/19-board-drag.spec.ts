import { test, expect, connectToMockGateway, API_BASE } from './helpers/fixtures'
import { startMockGateway, type MockGateway } from './helpers/mockGateway'

// Dragging board cards with a real mouse. The jsdom suites call dnd-kit's drag
// callbacks with a hand-built drop target, so they never run the collision
// detection that decides which column a drop lands in; this spec does.
//
// The cards are bound to an agent but wait on a blocker that never finishes, so
// the dispatch pump never starts a run for them and the moves are the only thing
// that changes them. All of them sit on today's row (they are created now), so a
// move to Done asks nothing, and a move to Cancelled asks only to confirm.

type Request = import('@playwright/test').APIRequestContext
type Page = import('@playwright/test').Page

async function teamOnBoard(request: Request): Promise<string> {
  // The dashboard files the mock gateway's agents into a team once it loads, and
  // the board starts filtered to the selected team.
  let teamId = ''
  await expect
    .poll(
      async () => {
        const r = await request.get(`${API_BASE}/api/teams`)
        const body = (await r.json()) as { teams?: Array<{ id: string }> }
        teamId = body.teams?.[0]?.id ?? ''
        return teamId
      },
      { timeout: 20_000 },
    )
    .not.toBe('')
  return teamId
}

async function createCard(
  request: Request,
  teamId: string,
  title: string,
  blockerId: string,
): Promise<string> {
  const r = await request.post(`${API_BASE}/api/board`, {
    data: { title, teamId, status: 'todo', sourceDelegationId: `e2e:${title}:agent:a2` },
  })
  const { task } = (await r.json()) as { task: { id: string } }
  await request.post(`${API_BASE}/api/board/${task.id}/deps`, {
    data: { dependsOnTaskId: blockerId },
  })
  return task.id
}

async function box(page: Page, selector: string) {
  const b = await page.locator(selector).first().boundingBox()
  if (!b) throw new Error(`no box for ${selector}`)
  return b
}

/** Press on the card, travel to (x, y) in small steps, and hold there. */
async function lift(page: Page, title: string, x: number, y: number): Promise<void> {
  const card = page.locator('[data-testid="board-card"]', { hasText: title }).first()
  await card.scrollIntoViewIfNeeded()
  const from = await card.boundingBox()
  if (!from) throw new Error(`no card ${title}`)
  const sx = from.x + from.width / 2
  const sy = from.y + from.height / 2
  await page.mouse.move(sx, sy)
  await page.mouse.down()
  for (let i = 1; i <= 16; i++) {
    await page.mouse.move(sx + ((x - sx) * i) / 16, sy + ((y - sy) * i) / 16)
  }
  await page.waitForTimeout(200)
}

function column(page: Page, id: string) {
  return page.locator(`[data-testid="board-column-${id}"]`)
}

test.describe('Board drag with a real mouse', () => {
  let ownGateway: MockGateway

  test.beforeAll(async () => {
    ownGateway = await startMockGateway()
  })
  test.afterAll(() => {
    ownGateway.close()
  })

  test('a drop goes only where the pointer is, and finishing asks first', async ({
    page,
    request,
  }) => {
    test.setTimeout(90_000)
    await page.setViewportSize({ width: 1440, height: 900 })
    await connectToMockGateway(page, request, ownGateway.url)
    const teamId = await teamOnBoard(request)

    const blocker = await request.post(`${API_BASE}/api/board`, {
      data: { title: 'E2E blocker that never finishes', teamId, status: 'backlog' },
    })
    const blockerId = ((await blocker.json()) as { task: { id: string } }).task.id
    await createCard(request, teamId, 'E2E stays put', blockerId)
    const runningId = await createCard(request, teamId, 'E2E running card', blockerId)
    await createCard(request, teamId, 'E2E to cancel', blockerId)
    // An agent has it: the card sits in In progress.
    await request.post(`${API_BASE}/api/board/${runningId}/claim`, {
      data: { assigneeAgentId: 'a2', assigneeRuntime: 'openclaw' },
    })

    const patches: string[] = []
    page.on('request', (req) => {
      if (req.method() === 'PATCH' && req.url().includes('/api/board/')) patches.push(req.url())
    })

    await page.locator('[data-testid="nav-board"]').click()
    await expect(page.locator('[data-testid="board-calendar"]')).toBeVisible({ timeout: 20_000 })
    // The board opens on Kanban, which has no rows by day; the Week view's
    // today row is what says a move finishes a card today.
    await page.locator('[data-testid="board-view"]').click()
    await page.getByRole('menuitemradio', { name: 'Week' }).click()
    await expect(page.locator('[data-testid="board-calendar"]')).toHaveAttribute(
      'data-mode',
      'week',
    )
    await expect(column(page, 'todo').getByText('E2E stays put')).toBeVisible({ timeout: 10_000 })

    // 1. A To do card held over In progress: the column refuses it and steps back.
    const inProgress = await box(page, '[data-testid="board-column-in_progress"]')
    const stays = await box(page, '[data-testid="board-card"]:has-text("E2E stays put")')
    await lift(page, 'E2E stays put', inProgress.x + inProgress.width / 2, stays.y + 20)
    await expect(column(page, 'in_progress')).toHaveCSS('opacity', '0.45')
    await expect(page.locator('[data-testid="board-column-needs-you"]')).toHaveCSS(
      'opacity',
      '0.45',
    )
    await page.mouse.up()

    // 2. The pointer just inside Done's right edge. Done refuses a To do card; the
    //    lifted card hangs over the folded Cancelled strip beside it, which would
    //    take it, but a drop goes where the pointer is. Nothing moves.
    const done = await box(page, '[data-testid="board-column-done"]')
    await lift(page, 'E2E stays put', done.x + done.width - 10, stays.y + 20)
    await expect(page.locator('[data-testid="calendar-landing"]')).toHaveCount(0)
    await page.mouse.up()

    // 3. Over Needs you, which never takes a card. Nothing moves.
    const needsYou = await box(page, '[data-testid="board-column-needs-you"]')
    await lift(page, 'E2E stays put', needsYou.x + needsYou.width - 12, stays.y + 20)
    await page.mouse.up()

    await page.waitForTimeout(600)
    expect(patches).toEqual([])
    await expect(column(page, 'todo').getByText('E2E stays put')).toBeVisible()

    // 4. An In progress card from today onto Done: it moves at once, nothing to ask.
    const running = await box(page, '[data-testid="board-card"]:has-text("E2E running card")')
    await lift(page, 'E2E running card', done.x + done.width / 2, running.y + 20)
    await expect(page.locator('[data-testid="calendar-landing"]')).toHaveText('Done today')
    await page.mouse.up()
    await expect(column(page, 'done').getByText('E2E running card')).toBeVisible()
    await expect(page.locator('[data-testid="finish-prompt"]')).toHaveCount(0)
    expect(patches).toHaveLength(1)

    // 5. A card onto the folded Cancelled strip: the strip says what letting go does,
    //    the move asks first, and the card is in view afterwards.
    const rail = await box(page, '[data-testid="board-cancelled-rail"]')
    const toCancel = await box(page, '[data-testid="board-card"]:has-text("E2E to cancel")')
    await lift(page, 'E2E to cancel', rail.x + rail.width / 2, toCancel.y + 20)
    await expect(page.locator('[data-testid="board-cancelled-rail-caption"]')).toHaveText(
      'Cancelled today',
    )
    await page.mouse.up()
    const prompt = page.locator('[data-testid="finish-prompt"]')
    await expect(prompt).toBeVisible()
    await expect(prompt).toContainText('It moves to Cancelled and will not run again.')
    await prompt.getByTestId('finish-ok').click()
    const landed = column(page, 'cancelled').getByText('E2E to cancel')
    await expect(landed).toBeVisible()
    await expect(landed).toBeInViewport()
    expect(patches).toHaveLength(2)
  })
})
