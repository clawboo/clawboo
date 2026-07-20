import { test, expect, API_BASE, assertSandboxed } from './helpers/fixtures'

/**
 * Custom connect helper for group chat tests.
 *
 * Creates a team and assigns Research Boo (a2) via API BEFORE navigating,
 * so auto-migration finds an existing team and doesn't interfere.
 *
 * `skipOnboarding` (default true) pre-marks the team's onboarding flags as
 * complete so the gate doesn't intercept rendering of `GroupChatPanel`.
 * Set to false to test the onboarding gate flow itself.
 */
async function connectWithTeam(
  page: import('@playwright/test').Page,
  request: import('@playwright/test').APIRequestContext,
  gatewayUrl: string,
  options: { skipOnboarding?: boolean } = {},
): Promise<{ teamId: string }> {
  const { skipOnboarding = true } = options

  // Safety: refuse to DELETE-all-teams unless the e2e sandbox is active.
  // Without the sandbox the loop below would wipe the developer's real
  // ~/.openclaw/clawboo/clawboo.db.
  await assertSandboxed(request)

  // Clean up stale teams
  try {
    const teamsResp = await request.get(`${API_BASE}/api/teams`)
    if (teamsResp.ok()) {
      const data = (await teamsResp.json()) as { teams?: { id: string }[] }
      for (const team of data.teams ?? []) {
        await request.delete(`${API_BASE}/api/teams/${team.id}`)
      }
    }
  } catch {
    /* best-effort */
  }

  // Create team and assign agent via API BEFORE page load
  const teamResp = await request.post(`${API_BASE}/api/teams`, {
    data: { name: 'Test Team', icon: '🧪', color: '#34D399' },
  })
  const { team } = (await teamResp.json()) as { team: { id: string } }
  await request.post(`${API_BASE}/api/teams/${team.id}/agents`, {
    data: { agentId: 'a2', agentName: 'Research Boo' },
  })

  // Pre-mark onboarding complete (most tests don't exercise the gate directly).
  // The TeamOnboardingGate would otherwise intercept GroupChatPanel rendering
  // until the user clicks "Know Your Team" and submits a self-introduction.
  if (skipOnboarding) {
    await request.patch(`${API_BASE}/api/teams/${team.id}/onboarding`, {
      data: { agentsIntroduced: true, userIntroduced: true },
    })
  }

  // Pre-save settings
  await request.post(`${API_BASE}/api/settings`, {
    data: { gatewayUrl, gatewayToken: '' },
  })

  // Skip onboarding + the one-time first-run affordances (tour / guided-first-task)
  await page.addInitScript(() => {
    localStorage.setItem('clawboo.onboarded', '1')
    localStorage.setItem('clawboo.tour.shown', '1')
    localStorage.setItem('clawboo.firstTask.shown', '1')
  })

  // Mock system status
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

  // Wait for team icon to appear in team sidebar
  const teamSidebar = page.locator('[data-testid="team-sidebar"]')
  await expect(teamSidebar.locator('button[aria-label="Test Team"]')).toBeVisible({
    timeout: 20_000,
  })

  // Click team icon to select it
  await teamSidebar.locator('button[aria-label="Test Team"]').click()

  // Wait for agent to appear in filtered list
  const agentList = page.locator('[data-testid="agent-list-column"]')
  await expect(agentList.getByText('Research Boo')).toBeVisible({ timeout: 15_000 })

  return { teamId: team.id }
}

test.describe('Group Chat', () => {
  test('shows group chat row when team is selected', async ({ page, request, gateway }) => {
    await connectWithTeam(page, request, gateway.url)

    // GroupChatRow should be visible (team selected + has agents)
    const agentList = page.locator('[data-testid="agent-list-column"]')
    await expect(agentList.locator('[data-testid="group-chat-row"]')).toBeVisible({
      timeout: 5_000,
    })
    await expect(
      agentList.locator('[data-testid="group-chat-row"]').getByText('Group Chat'),
    ).toBeVisible()
  })

  test('opens group chat view with 2-panel layout on click', async ({ page, request, gateway }) => {
    await connectWithTeam(page, request, gateway.url)

    // Click group chat row
    const agentList = page.locator('[data-testid="agent-list-column"]')
    const groupChatRow = agentList.locator('[data-testid="group-chat-row"]')
    await expect(groupChatRow).toBeVisible({ timeout: 5_000 })
    await groupChatRow.click()

    // Verify group chat panel appears
    await expect(page.locator('[data-testid="group-chat-panel"]')).toBeVisible({ timeout: 5_000 })

    // Verify Ghost Graph panel appears alongside (2-panel layout)
    await expect(page.locator('.react-flow')).toBeVisible({ timeout: 10_000 })
  })

  test('group chat row not visible when no team selected', async ({ page, request, gateway }) => {
    await connectWithTeam(page, request, gateway.url)

    // Confirm group chat row is visible
    const agentList = page.locator('[data-testid="agent-list-column"]')
    await expect(agentList.locator('[data-testid="group-chat-row"]')).toBeVisible({
      timeout: 5_000,
    })

    // Click mascot icon to deselect team (enters Boo Zero view — hides AgentListColumn)
    const teamSidebar = page.locator('[data-testid="team-sidebar"]')
    await teamSidebar.locator('img[src="/logo.svg"]').click()

    // Group chat row should not be visible (AgentListColumn hidden in Boo Zero view)
    await expect(agentList.locator('[data-testid="group-chat-row"]')).not.toBeVisible({
      timeout: 5_000,
    })
  })

  test('gates onboarding, then walks welcome → user-intro into the team space', async ({
    page,
    request,
    gateway,
  }) => {
    // Do NOT skip onboarding so the gate intercepts.
    await connectWithTeam(page, request, gateway.url, { skipOnboarding: false })

    // Click group chat row
    const agentList = page.locator('[data-testid="agent-list-column"]')
    const groupChatRow = agentList.locator('[data-testid="group-chat-row"]')
    await expect(groupChatRow).toBeVisible({ timeout: 5_000 })
    await groupChatRow.click()

    // Phase A — the welcome gate is rendered in the left panel; the GroupChatPanel
    // composer is NOT mounted (it's behind the gate), and the Ghost Graph is not
    // rendered until the user finishes.
    await expect(page.locator('[data-testid="know-your-team-button"]')).toBeVisible({
      timeout: 5_000,
    })
    await expect(page.locator('[data-testid="group-chat-panel"]')).not.toBeVisible({
      timeout: 1_000,
    })
    await expect(page.locator('.react-flow')).not.toBeVisible({ timeout: 2_000 })

    // NEW FLOW — the welcome advances STRAIGHT to the user's self-introduction
    // (Phase B, the agent intro parade, was removed). Still gated (no panel yet).
    await page.locator('[data-testid="know-your-team-button"]').click()
    await expect(page.locator('[data-testid="user-intro-textarea"]')).toBeVisible({
      timeout: 5_000,
    })
    await expect(page.locator('[data-testid="group-chat-panel"]')).not.toBeVisible({
      timeout: 1_000,
    })

    // Submitting the self-intro opens the team space — the gate hands off to the
    // graph(top)+chat(bottom) split (works with no live orchestration client too).
    await page
      .locator('[data-testid="user-intro-textarea"]')
      .fill('Hi team, I am testing the onboarding flow.')
    await page.locator('[data-testid="submit-user-intro"]').click()
    await expect(page.locator('[data-testid="group-chat-panel"]')).toBeVisible({ timeout: 15_000 })
  })
})
