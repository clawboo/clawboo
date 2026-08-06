// The bounded chat render window (#71), in a REAL browser.
//
// Everything else about the window is unit-tested, but the `loadEarlier`
// scroll-anchor restore is not reachable there: jsdom reports 0 for
// scrollHeight/scrollTop/clientHeight, so the arithmetic that keeps the reader's
// position steady while older blocks are prepended above it has no observable
// effect. This spec measures it with real layout.
//
// The mechanism: capture `scrollHeight - scrollTop` in the click handler, then
// re-apply it in a layout effect once the taller list has laid out. Because
// `clientHeight` is fixed by the flex parent, preserving that difference also
// leaves `scrollHeight - scrollTop - clientHeight` — the exact expression
// `useChatAutoScroll`'s handler tests — untouched, so auto-scroll cannot fire as
// a side effect. Assertions 4-8 below pin each half of that claim.
//
// Runs last in file order and wipes teams on entry, so it cannot disturb the
// specs that share this suite's single server and SQLite file.

import { test, expect, API_BASE, assertSandboxed } from './helpers/fixtures'

const TOTAL = 320 // > RENDER_WINDOW_INITIAL (150) + one STEP (100)

function entries(sessionKey: string, n: number) {
  return Array.from({ length: n }, (_, i) => ({
    entryId: `seed-${i}`,
    role: i % 2 === 0 ? 'user' : 'assistant',
    kind: i % 2 === 0 ? 'user' : 'assistant',
    // Tall, varied bodies so heights differ per row — a uniform list could hide
    // an anchor bug that only shows with variable block heights.
    text: `seed-msg-${i}\n\n${'filler text '.repeat(3 + (i % 7))}`,
    sessionKey,
    runId: null,
    source: 'history',
    timestampMs: 1_700_000_000_000 + i * 1000,
    sequenceKey: i,
    confirmed: true,
    fingerprint: `fp-${i}`,
  }))
}

test('bounded render window: real-layout scroll anchoring', async ({ page, request }) => {
  await assertSandboxed(request)

  // Clean slate, then one team with one member.
  const list = await request.get(`${API_BASE}/api/teams`)
  if (list.ok()) {
    const { teams = [] } = (await list.json()) as { teams?: { id: string }[] }
    for (const t of teams) await request.delete(`${API_BASE}/api/teams/${t.id}`)
  }
  const teamResp = await request.post(`${API_BASE}/api/teams`, {
    data: { name: 'Window Team', icon: '🪟', color: '#34D399' },
  })
  const { team } = (await teamResp.json()) as { team: { id: string } }
  await request.post(`${API_BASE}/api/teams/${team.id}/agents`, {
    data: { agentId: 'a2', agentName: 'Window Boo' },
  })
  await request.patch(`${API_BASE}/api/teams/${team.id}/onboarding`, {
    data: { agentsIntroduced: true, userIntroduced: true },
  })

  await page.addInitScript(() => {
    localStorage.setItem('clawboo.onboarded', '1')
    localStorage.setItem('clawboo.tour.shown', '1')
    localStorage.setItem('clawboo.firstTask.shown', '1')
  })

  // Serve a long transcript for whichever participant the panel asks about.
  await page.route('**/api/chat-history*', async (route) => {
    const sk = new URL(route.request().url()).searchParams.get('sessionKey') ?? ''
    const isLead = sk.includes(':a2:')
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ entries: isLead ? entries(sk, TOTAL) : [] }),
    })
  })
  await page.route('**/api/board*', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: '{"tasks":[]}' }),
  )

  await page.goto('/')

  const sidebar = page.locator('[data-testid="team-sidebar"]')
  await sidebar.locator('button[aria-label="Window Team"]').click({ timeout: 20_000 })
  const row = page.locator('[data-testid="agent-list-column"] [data-testid="group-chat-row"]')
  await row.click({ timeout: 15_000 })
  await expect(page.locator('[data-testid="group-chat-panel"]')).toBeVisible({ timeout: 10_000 })

  const scroller = page.locator('[data-testid="group-chat-scroll"]')
  const loadEarlier = page.locator('[data-testid="load-earlier"]')
  await expect(loadEarlier).toBeVisible({ timeout: 15_000 })

  // ── 1. The window is bounded, and layout is real ────────────────────────────
  const geom = async () =>
    scroller.evaluate((el) => ({
      h: el.scrollHeight,
      t: el.scrollTop,
      c: el.clientHeight,
      rows: (el.textContent?.match(/seed-msg-\d+/g) ?? []).length,
    }))

  const g0 = await geom()
  console.log('[verify] initial geometry', g0)
  expect(g0.c, 'clientHeight > 0 proves real layout (jsdom would be 0)').toBeGreaterThan(0)
  expect(g0.h, 'content taller than viewport').toBeGreaterThan(g0.c)

  console.log('[verify] rendered rows before', g0.rows, 'of', TOTAL)
  expect(g0.rows, 'window is bounded well below the full transcript').toBeLessThan(TOTAL)

  // ── 2. Auto-scroll landed at the bottom ─────────────────────────────────────
  const distFromBottom0 = g0.h - g0.t - g0.c
  console.log('[verify] distance from bottom on load =', distFromBottom0)
  expect(distFromBottom0, 'initial view is pinned to the newest message').toBeLessThan(4)

  // ── 3. Reading position across "Load earlier" ───────────────────────────────
  // Modelled as it actually happens: the control lives at the TOP of the
  // container, so a user has necessarily scrolled there to click it. (An earlier
  // version of this test clicked from the bottom and mis-measured, because
  // Playwright scrolls a target into view first — the viewport legitimately
  // moved before the handler ran.)
  await scroller.evaluate((el) => {
    el.scrollTop = 0
  })
  await page.waitForTimeout(250)

  // The oldest row currently rendered — this is what must not move.
  const firstRow = scroller.locator('text=/seed-msg-\\d+/').first()
  const firstLabel = (await firstRow.textContent())?.match(/seed-msg-\d+/)?.[0]
  const boxBefore = await firstRow.boundingBox()
  const before = await geom()
  console.log('[verify] at top, before click', { ...before, firstLabel, y: boxBefore?.y })

  await loadEarlier.click()

  await expect
    .poll(async () => (await geom()).h, { timeout: 5000, intervals: [50] })
    .toBeGreaterThan(before.h)
  await page.waitForTimeout(150)

  const after = await geom()
  const sameRow = scroller.locator(`text=${firstLabel}`).first()
  const boxAfter = await sameRow.boundingBox()
  console.log('[verify] after click', { ...after, y: boxAfter?.y })

  // ── 4. THE INVARIANT: scrollHeight - scrollTop is preserved ─────────────────
  const anchorBefore = before.h - before.t
  const anchorAfter = after.h - after.t
  console.log('[verify] anchor before/after', anchorBefore, anchorAfter)
  expect(Math.abs(anchorAfter - anchorBefore), 'scrollHeight - scrollTop preserved').toBeLessThan(2)

  // ── 5. Equivalently: scrollTop shifted by exactly the prepended height ──────
  const prepended = after.h - before.h
  console.log('[verify] prepended px =', prepended, 'scrollTop =', after.t)
  expect(Math.abs(after.t - prepended), 'scrollTop === height of new content').toBeLessThan(2)

  // ── 6. What the reader feels: that row is still where it was ────────────────
  const drift = Math.abs((boxAfter?.y ?? 0) - (boxBefore?.y ?? 0))
  console.log('[verify] on-screen drift of', firstLabel, '=', drift, 'px')
  expect(drift, 'the row the reader was on stays put').toBeLessThan(3)

  // ── 7. A step of older rows really was revealed ─────────────────────────────
  console.log('[verify] rows', g0.rows, '->', after.rows)
  expect(after.rows, 'one step of older rows prepended').toBeGreaterThan(g0.rows)

  // ── 8. nearBottom unchanged ⇒ the auto-scroll effect cannot have fired ──────
  const dbBefore = before.h - before.t - before.c
  const dbAfter = after.h - after.t - after.c
  console.log('[verify] distFromBottom', dbBefore, '->', dbAfter)
  expect(Math.abs(dbAfter - dbBefore), 'handleScroll sees no change').toBeLessThan(2)

  // ── 9. The expanded window still pins to the newest message ─────────────────
  // The window is now 250 rows deep; auto-scroll must still reach the true end.
  await scroller.evaluate((el) => {
    el.scrollTop = el.scrollHeight
  })
  await page.waitForTimeout(200)
  const atEnd = await geom()
  console.log('[verify] after scroll-to-end, distFromBottom =', atEnd.h - atEnd.t - atEnd.c)
  expect(atEnd.h - atEnd.t - atEnd.c, 'reaches the true bottom').toBeLessThan(4)
  await expect(scroller.locator(`text=seed-msg-${TOTAL - 1}`).first()).toBeVisible()
})
