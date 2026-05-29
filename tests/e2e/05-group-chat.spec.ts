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

  // Skip onboarding
  await page.addInitScript(() => {
    localStorage.setItem('clawboo.onboarded', '1')
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
  await expect(teamSidebar.locator('button[title="Test Team"]')).toBeVisible({ timeout: 20_000 })

  // Click team icon to select it
  await teamSidebar.locator('button[title="Test Team"]').click()

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

  test('shows "Know Your Team" gate when onboarding incomplete', async ({
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

    // Onboarding gate is rendered in the left panel — verify the
    // "Know Your Team" button is present, and that the GroupChatPanel
    // composer is NOT mounted (it's behind the gate).
    await expect(page.locator('[data-testid="know-your-team-button"]')).toBeVisible({
      timeout: 5_000,
    })
    await expect(page.locator('[data-testid="group-chat-panel"]')).not.toBeVisible({
      timeout: 1_000,
    })

    // Ghost Graph should still be visible alongside the gate (2-panel layout)
    await expect(page.locator('.react-flow')).toBeVisible({ timeout: 10_000 })
  })

  test('nests delegated agent response inside the source DelegationCard', async ({
    page,
    request,
    gateway,
  }) => {
    const { teamId } = await connectWithTeam(page, request, gateway.url)

    // Seed two transcript entries on the team-scoped session keys:
    //   1. Source assistant entry on a1 (Boo Zero / Test Boo) emitting a
    //      `<delegate to="@Research Boo">…</delegate>` block.
    //   2. Target reply assistant entry on a2 (Research Boo).
    // After hydration, GroupChatPanel runs buildDelegationLinkages which
    // pairs the two — the target reply should render INSIDE the source's
    // DelegationCard (delegation-card-body), not as a sibling top-level
    // assistant card.
    const sourceSk = `agent:a1:team:${teamId}`
    const targetSk = `agent:a2:team:${teamId}`
    const baseTs = Date.now()
    // Unique-per-run IDs so the chat-history POST isn't silently no-op'd by
    // ON CONFLICT (entry_id) DO NOTHING when previous test runs left rows.
    const runId = `e2e-${baseTs}`
    const srcId = `src-${runId}`
    const tgtId = `tgt-${runId}`
    const replyText =
      'Voice AI converts speech to structured intent — used in kiosks, in-car assistants, and call centers.'

    await request.post(`${API_BASE}/api/chat-history`, {
      data: {
        sessionKey: sourceSk,
        gatewayUrl: gateway.url,
        entries: [
          {
            entryId: srcId,
            runId: `run-bz-${runId}`,
            sessionKey: sourceSk,
            kind: 'assistant',
            role: 'assistant',
            text: 'On it. <delegate to="@Research Boo">Quick TL;DR of voice AI</delegate>',
            source: 'runtime-chat',
            timestampMs: baseTs,
            sequenceKey: 1,
            confirmed: true,
            fingerprint: `fp-${srcId}`,
          },
        ],
      },
    })

    await request.post(`${API_BASE}/api/chat-history`, {
      data: {
        sessionKey: targetSk,
        gatewayUrl: gateway.url,
        entries: [
          {
            entryId: tgtId,
            runId: `run-eng-${runId}`,
            sessionKey: targetSk,
            kind: 'assistant',
            role: 'assistant',
            text: replyText,
            source: 'runtime-chat',
            timestampMs: baseTs + 5_000,
            sequenceKey: 2,
            confirmed: true,
            fingerprint: `fp-${tgtId}`,
          },
        ],
      },
    })

    // Open group chat
    const agentList = page.locator('[data-testid="agent-list-column"]')
    const groupChatRow = agentList.locator('[data-testid="group-chat-row"]')
    await expect(groupChatRow).toBeVisible({ timeout: 5_000 })
    await groupChatRow.click()
    await expect(page.locator('[data-testid="group-chat-panel"]')).toBeVisible({ timeout: 5_000 })

    // Exactly one DelegationCard renders for our seeded source block.
    const card = page.locator('[data-testid="delegation-card"]')
    await expect(card).toHaveCount(1, { timeout: 10_000 })

    // The card body is visible (default-expanded for the newest delegation)
    // and contains the target's reply text.
    const cardBody = card.locator('[data-testid="delegation-card-body"]')
    await expect(cardBody).toBeVisible({ timeout: 5_000 })
    await expect(cardBody).toContainText('Voice AI converts speech to structured intent')

    // The target reply must NOT also appear as a top-level sibling card
    // outside the DelegationCard — count assert: the only paragraph
    // containing the reply text lives inside delegation-card-body.
    const allReplyMatches = page.locator(`text=${replyText}`)
    await expect(allReplyMatches).toHaveCount(1)
  })
})
