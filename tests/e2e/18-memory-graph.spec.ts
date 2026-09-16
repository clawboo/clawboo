import { test, expect, connectToMockGateway, API_BASE } from './helpers/fixtures'
import { startMockGateway, type MockGateway } from './helpers/mockGateway'

// The Memory Graph view (features/memory/graph/) — sidebar nav, empty state,
// synthesized tag edges over seeded facts, search → ego-graph → inspect loop,
// neighbor-chip refocus, and legend community filtering. Runs deterministically
// with or without a local embedding provider (the similarity honesty pill is
// asserted CONDITIONALLY on the live /api/memory/provider response).
//
// This spec starts its OWN mock gateway instead of using the worker-scoped
// `gateway` fixture: 15-live-reconnect deliberately calls `gateway.close()` on
// the SHARED worker gateway mid-test and never restores it, so any later spec
// that dials the fixture's URL hits a dead server. A private gateway keeps this
// spec order-independent. (Fixture hardening is tracked as a follow-up.)
test.describe('Memory Graph', () => {
  let ownGateway: MockGateway

  test.beforeAll(async () => {
    ownGateway = await startMockGateway()
  })
  test.afterAll(() => {
    ownGateway.close()
  })

  test('empty state → seeded graph → search/inspect → legend filter', async ({ page, request }) => {
    await connectToMockGateway(page, request, ownGateway.url)

    // ── Sidebar nav → empty state (no facts saved by any earlier spec). ──
    await page.locator('[data-testid="nav-memory"]').click()
    await expect(page.getByText('Nothing remembered yet')).toBeVisible({ timeout: 10_000 })

    // ── Seed: 3 facts sharing a tag + 1 apart + a 2-version procedure. ──
    const saved: string[] = []
    for (const [title, content, tags] of [
      ['Deploy cadence', 'we release on Fridays after the smoke test passes', ['deploy']],
      ['Rollback drill', 'rollback is one click in the deploy dashboard', ['deploy']],
      ['Smoke gate', 'the deploy smoke suite gates every release', ['deploy']],
      ['Auth keys', 'device pairing uses Ed25519 keys', ['auth']],
    ] as const) {
      const resp = await request.post(`${API_BASE}/api/memory`, {
        data: { title, content, tags: [...tags] },
      })
      expect(resp.ok()).toBe(true)
      const body = (await resp.json()) as { fact?: { id: string } }
      expect(body.fact?.id).toBeTruthy()
      saved.push(body.fact!.id)
    }
    for (const content of ['release steps v1', 'release steps v2']) {
      const resp = await request.post(`${API_BASE}/api/memory`, {
        data: { kind: 'procedure', name: 'release-checklist', content },
      })
      expect(resp.ok()).toBe(true)
    }

    // ── Reload the view so the graph refetches the seeded payload. ──
    await page.reload()
    await page.locator('[data-testid="nav-memory"]').click()
    const canvas = page.locator('[data-testid="memory-graph-canvas"]')
    await expect(canvas).toBeVisible({ timeout: 10_000 })
    for (const id of saved) {
      await expect(page.locator(`[data-testid="mem-node-${id}"]`)).toBeVisible({
        timeout: 10_000,
      })
    }
    // The 2-version procedure collapses to ONE node (its name also appears as
    // the procedure-only community's label in the legend — scope to nodes).
    await expect(
      canvas.locator('[data-testid^="mem-node-"]', { hasText: 'release-checklist' }),
    ).toHaveCount(1)

    // Honesty pill — conditional on whether the sandbox resolved a provider.
    const providerResp = await request.get(`${API_BASE}/api/memory/provider`)
    const provider = ((await providerResp.json()) as { provider: unknown }).provider
    const providerPill = page.getByText('Similarity links unavailable: no embedding provider')
    if (provider == null) await expect(providerPill).toBeVisible()
    else await expect(providerPill).not.toBeVisible()

    // ── Search → Enter → ego-graph auto-selects the top hit → inspector. ──
    await page.locator('[data-testid="memory-graph-search"]').fill('rollback')
    await page.locator('[data-testid="memory-graph-search"]').press('Enter')
    const inspector = page.locator('[data-testid="memory-inspect-panel"]')
    const inspectTitle = inspector.locator('[data-testid="memory-inspect-title"]')
    await expect(inspector).toBeVisible({ timeout: 10_000 })
    await expect(inspectTitle).toHaveText('Rollback drill')

    // ── Neighbor chip refocuses the inspector (shared 'deploy' tag edge).
    //    The previous fact stays visible as a chip in the NEW selection's
    //    neighbor list, so assert on the title, not text presence. ──
    const neighborChips = inspector.locator('[data-testid^="mem-neighbor-"]')
    await expect(neighborChips.first()).toBeVisible({ timeout: 10_000 })
    await neighborChips.first().click()
    await expect(inspectTitle).not.toHaveText('Rollback drill')

    // ── Legend: hide the 'deploy' community → its nodes disappear. ──
    const legend = page.locator('[data-testid="memory-graph-legend"]')
    await expect(legend).toBeVisible()
    await expect(legend.getByText('deploy')).toBeVisible()
    await legend.getByRole('checkbox', { name: /^deploy/ }).click()
    // The three deploy facts hide; the auth fact stays.
    await expect(page.locator(`[data-testid="mem-node-${saved[0]}"]`)).not.toBeVisible({
      timeout: 5_000,
    })
    await expect(page.locator(`[data-testid="mem-node-${saved[3]}"]`)).toBeVisible()

    // ── Surface toggle: List mode shows the classic panel. ──
    await page.getByRole('radio', { name: 'List' }).click()
    await expect(page.locator('[data-testid="memory-panel"]')).toBeVisible({ timeout: 5_000 })
  })
})
