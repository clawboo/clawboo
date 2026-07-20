import { test, expect, API_BASE, assertSandboxed } from './helpers/fixtures'

// Proves the OpenClaw team round-trip runs entirely on the SERVER engine (no browser
// orchestration) after the cutover: a user message → the server orchestrator delivers
// it over the server-held OPERATOR connection → the mock gateway replies → the reply
// streams back to the thin client over the chat SSE. The delegation cascade (leader →
// specialist → report-up) is driven by the server engine; the browser only POSTs the
// message and renders the SSE transcript.
//
// The mock gateway (helpers/mockGateway.ts) accepts the server operator connection and
// emits synthetic `chat` final frames: the leader (a1 / Boo Zero) replies with a
// `<delegate to="@Research Boo">…</delegate>`, and Research Boo (a2) replies with the
// report-up "Research complete: the answer is 42." — which is what we assert appears in
// the chat (it's produced only when a2 gets a turn, via the delegation OR directly, so
// it's robust to the Boo-Zero sync timing).

/** Poll the agent registry health until the server's operator connection to the mock
 *  gateway is up — so the first `chat.send` reaches the gateway (the pairing race). */
async function waitForOperatorConnection(
  request: import('@playwright/test').APIRequestContext,
): Promise<void> {
  await expect
    .poll(
      async () => {
        try {
          const r = await request.get(`${API_BASE}/api/agents/registry/health`)
          if (!r.ok()) return 'unreachable'
          const body = (await r.json()) as { connection?: string }
          return body.connection ?? 'unknown'
        } catch {
          return 'error'
        }
      },
      { timeout: 30_000, intervals: [500] },
    )
    .toBe('connected')
}

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
  // Assign Research Boo (a2) to the team — the upsert creates it (runtime openclaw by
  // default) so the server team has an OpenClaw member the leader can delegate to.
  await request.post(`${API_BASE}/api/teams/${team.id}/agents`, {
    data: { agentId: 'a2', agentName: 'Research Boo' },
  })
  await request.patch(`${API_BASE}/api/teams/${team.id}/onboarding`, {
    data: { agentsIntroduced: true, userIntroduced: true },
  })
  // Point the server's OpenClawAgentSource at the mock gateway (triggers reconnect + sync).
  await request.post(`${API_BASE}/api/settings`, { data: { gatewayUrl, gatewayToken: '' } })
  // Gate on the operator connection so the first server-side `chat.send` reaches the gateway.
  await waitForOperatorConnection(request)

  await page.addInitScript(() => {
    localStorage.setItem('clawboo.onboarded', '1')
    localStorage.setItem('clawboo.tour.shown', '1')
    localStorage.setItem('clawboo.firstTask.shown', '1')
  })
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
  await expect(teamSidebar.locator('button[aria-label="Test Team"]')).toBeVisible({
    timeout: 20_000,
  })
  await teamSidebar.locator('button[aria-label="Test Team"]').click()
  const agentList = page.locator('[data-testid="agent-list-column"]')
  const row = agentList.locator('[data-testid="group-chat-row"]')
  await expect(row).toBeVisible({ timeout: 15_000 })
  await row.click()
  await expect(page.locator('[data-testid="group-chat-panel"]')).toBeVisible({ timeout: 10_000 })
}

test.describe('Server-orchestrated OpenClaw round-trip (no browser orchestration)', () => {
  test('a user message drives a server-side round-trip that streams back + survives refresh', async ({
    page,
    request,
    gateway,
  }) => {
    // The round-trip inherently exceeds 30s: the operator-connection gate + the
    // delegate→child→done chain over the server engine + a reload + re-open.
    test.setTimeout(120_000)
    await connectWithTeam(page, request, gateway.url)
    await openGroupChat(page)

    // Send a user message → the server engine delivers it over the operator connection.
    const composer = page.getByPlaceholder(/Message team/)
    await expect(composer).toBeVisible({ timeout: 15_000 })
    await composer.fill('Please research the answer.')
    await composer.press('Enter')

    // ROUND-TRIP: the specialist's report-up ("Research complete…") streams back over the
    // chat SSE — produced only when Research Boo (a2) gets a turn on the SERVER engine.
    await expect(page.getByText(/Research complete: the answer is 42\./).first()).toBeVisible({
      timeout: 60_000,
    })

    // LIVE BOARD: the delegation also mints a board task, and the server pushes each
    // board change over the chat SSE (`event: board`) → the BoardTaskCard renders
    // DURING the cascade, not just after a reload (the live board-projection push).
    await expect(page.locator('[data-testid="board-task-card"]').first()).toBeVisible({
      timeout: 30_000,
    })

    // Refresh: the chat re-renders FROM chat-history REST (server-persisted, no browser
    // orchestration state) — the round-trip survived the reload.
    await page.reload()
    await openGroupChat(page)
    await expect(page.getByText(/Research complete: the answer is 42\./).first()).toBeVisible({
      timeout: 20_000,
    })
  })
})
