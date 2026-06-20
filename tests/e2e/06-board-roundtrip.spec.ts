import { test, expect, API_BASE, assertSandboxed } from './helpers/fixtures'

// Proves the chat-fused board round-trip end to end: a chat delegation DERIVES a
// durable board task (via a lifecycle event, no regex), the result ROUND-TRIPS
// back (status → done), and the task SURVIVES a refresh (re-loaded from REST).
//
// The mock gateway (helpers/mockGateway.ts) emits synthetic `chat` final frames:
// the leader (a1) replies with a `<delegate to="@Research Boo">…</delegate>`, and
// Research Boo (a2) replies with a report-up summary.

async function connectWithTeam(
  page: import('@playwright/test').Page,
  request: import('@playwright/test').APIRequestContext,
  gatewayUrl: string,
): Promise<{ teamId: string }> {
  await assertSandboxed(request)

  try {
    const teamsResp = await request.get(`${API_BASE}/api/teams`)
    if (teamsResp.ok()) {
      const data = (await teamsResp.json()) as { teams?: { id: string }[] }
      for (const team of data.teams ?? []) await request.delete(`${API_BASE}/api/teams/${team.id}`)
    }
  } catch {
    /* best-effort */
  }

  const teamResp = await request.post(`${API_BASE}/api/teams`, {
    data: { name: 'Test Team', icon: '🧪', color: '#34D399' },
  })
  const { team } = (await teamResp.json()) as { team: { id: string } }
  await request.post(`${API_BASE}/api/teams/${team.id}/agents`, {
    data: { agentId: 'a2', agentName: 'Research Boo' },
  })
  await request.patch(`${API_BASE}/api/teams/${team.id}/onboarding`, {
    data: { agentsIntroduced: true, userIntroduced: true },
  })
  await request.post(`${API_BASE}/api/settings`, { data: { gatewayUrl, gatewayToken: '' } })

  await page.addInitScript(() => localStorage.setItem('clawboo.onboarded', '1'))
  await page.route('**/api/system/status', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        node: { version: process.version, major: 22, sufficient: true, path: '/usr/bin/node' },
        openclaw: {
          installed: true,
          version: '0.3.0',
          path: '/usr/bin/openclaw',
          stateDir: '/tmp/.openclaw',
          configExists: true,
          envExists: true,
        },
        gateway: { running: true, port: 18789, pid: null, managedByClawboo: false, uptimeMs: null },
      }),
    })
  })

  await page.goto('/')
  return { teamId: team.id }
}

async function openGroupChat(page: import('@playwright/test').Page): Promise<void> {
  const teamSidebar = page.locator('[data-testid="team-sidebar"]')
  await expect(teamSidebar.locator('button[title="Test Team"]')).toBeVisible({ timeout: 20_000 })
  await teamSidebar.locator('button[title="Test Team"]').click()
  const agentList = page.locator('[data-testid="agent-list-column"]')
  const row = agentList.locator('[data-testid="group-chat-row"]')
  await expect(row).toBeVisible({ timeout: 15_000 })
  await row.click()
  await expect(page.locator('[data-testid="group-chat-panel"]')).toBeVisible({ timeout: 10_000 })
}

test.describe('Chat-fused board round-trip', () => {
  test('a delegation derives a durable task that completes and survives refresh', async ({
    page,
    request,
    gateway,
  }) => {
    // The round-trip inherently exceeds 30s: a ~5s agent-wake settle + the
    // delegate→child→done chain + a page reload + re-open.
    test.setTimeout(120_000)
    await connectWithTeam(page, request, gateway.url)
    await openGroupChat(page)

    // Send a user message → the leader delegates (mock) → board task derived.
    const composer = page.getByPlaceholder(/Message team/)
    await expect(composer).toBeVisible({ timeout: 15_000 })
    await composer.fill('Please research the answer.')
    await composer.press('Enter')

    // DERIVE: a durable BoardTaskCard appears (chat → board via a lifecycle event).
    const card = page.locator('[data-testid="board-task-card"]').first()
    await expect(card).toBeVisible({ timeout: 45_000 })

    // ROUND-TRIP: the specialist completes → the card flips to done.
    await expect(
      page.locator('[data-testid="board-task-card"][data-task-status="done"]').first(),
    ).toBeVisible({ timeout: 45_000 })

    // AC2 — refresh: the chat re-renders the task FROM THE BOARD (not ephemeral
    // memory). The projection store re-loads from SQLite-backed REST on mount.
    await page.reload()
    await openGroupChat(page)
    await expect(page.locator('[data-testid="board-task-card"]').first()).toBeVisible({
      timeout: 20_000,
    })
  })
})
