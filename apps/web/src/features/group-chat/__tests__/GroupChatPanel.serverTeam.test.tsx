// GroupChatPanel — the SERVER-orchestrated (native) branch. Verifies the thin-client
// integration: the composer works with `client === null` (canSend drops the client
// requirement), Send fires the REST ingest with the resolved leader target, and Stop
// (which appears once the team is busy) fires the REST stop. The SSE stream itself is
// inert in jsdom (no EventSource) — the reconciliation is covered by the hook tests.

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, describe, expect, it } from 'vitest'

import type { AgentState } from '@/stores/fleet'
import { useBooZeroStore } from '@/stores/booZero'
import { useConnectionStore } from '@/stores/connection'
import { useFleetStore } from '@/stores/fleet'
import { useTeamStore, type Team } from '@/stores/team'
import { ThemeProvider } from '@/features/theme/ThemeProvider'
import { FIRST_TASK_FLAG } from '@/lib/oneTimeFlag'

import { server } from '../../../__vitest__/mswServer'
import { GroupChatPanel } from '../GroupChatPanel'

function agent(id: string, name: string): AgentState {
  return {
    id,
    name,
    status: 'idle',
    sessionKey: `agent:${id}:native`,
    model: null,
    createdAt: 0,
    streamingText: null,
    runId: null,
    lastSeenAt: null,
    teamId: 't1',
    execConfig: null,
  }
}

const TEAM: Team = {
  id: 't1',
  name: 'My First Team',
  icon: '🚀',
  color: '#e94560',
  colorCollectionId: null,
  templateId: null,
  agentCount: 2,
  leaderAgentId: 'a1',
  isArchived: false,
  serverOrchestrated: true,
}

function seedNativeTeam(): void {
  // Opt out of the one-time guided-first-task prefill — it would prepend a
  // suggestion to the composer and this test asserts the exact sent message.
  localStorage.setItem(FIRST_TASK_FLAG, '1')
  useTeamStore.setState({ teams: [TEAM], selectedTeamId: 't1' })
  useFleetStore.setState({
    agents: [agent('a1', 'Team Lead'), agent('a2', 'Coder')],
    selectedAgentId: null,
  })
  useConnectionStore.setState({ status: 'connected', client: null, gatewayUrl: '' })
  useBooZeroStore.setState({ booZeroAgentId: null })
}

afterEach(() => {
  cleanup()
  localStorage.clear()
  useTeamStore.setState({ teams: [], selectedTeamId: null })
  useFleetStore.setState({ agents: [], selectedAgentId: null })
})

describe('GroupChatPanel — server-orchestrated branch', () => {
  it('composer works with client===null; Send POSTs the ingest with the leader target; Stop POSTs the stop', async () => {
    let chatBody: unknown = null
    let stopCalled = false
    server.use(
      http.get('/api/chat-history', () => HttpResponse.json({ entries: [] })),
      http.get('/api/board', () => HttpResponse.json({ tasks: [] })),
      http.post('/api/teams/t1/chat', async ({ request }) => {
        chatBody = await request.json()
        return new HttpResponse(null, { status: 202 })
      }),
      http.post('/api/teams/t1/chat/stop', () => {
        stopCalled = true
        return HttpResponse.json({ ok: true })
      }),
    )
    seedNativeTeam()

    render(
      <ThemeProvider>
        <GroupChatPanel teamId="t1" embedded />
      </ThemeProvider>,
    )

    // The composer is ENABLED despite `client === null` (native canSend).
    const textarea = await screen.findByPlaceholderText(/Message team/i)
    expect(textarea).not.toBeDisabled()

    // Send → REST ingest with { message, targetAgentId: leader(a1), entryId }.
    await userEvent.type(textarea, 'build the thing')
    await userEvent.keyboard('{Enter}')
    await waitFor(() => expect(chatBody).not.toBeNull())
    expect(chatBody).toMatchObject({ message: 'build the thing', targetAgentId: 'a1' })
    expect(typeof (chatBody as { entryId?: unknown }).entryId).toBe('string')

    // The team is now busy → the Stop button appears; clicking it POSTs the stop.
    const stopBtn = await screen.findByTestId('chat-stop-button')
    await userEvent.click(stopBtn)
    await waitFor(() => expect(stopCalled).toBe(true))
  })
})

// ── Cross-team Boo Zero must not leak into a team's roster ────────────────────
// Regression for the reported bug: an agent that belongs to ANOTHER team (a
// codex-preferred deploy / manual "Make this agent Boo Zero" override that
// points Boo Zero at a team member) showed up in this team's tag chips +
// @mention list. Only a TEAMLESS Boo Zero (the universal coordinator) may.

function agentWithTeam(id: string, name: string, teamId: string | null): AgentState {
  return {
    id,
    name,
    status: 'idle',
    sessionKey: `agent:${id}:native`,
    model: null,
    createdAt: 0,
    streamingText: null,
    runId: null,
    lastSeenAt: null,
    teamId,
    execConfig: null,
  }
}

function seedRosterTest(booZero: AgentState): void {
  localStorage.setItem(FIRST_TASK_FLAG, '1')
  useTeamStore.setState({ teams: [TEAM], selectedTeamId: 't1' })
  useFleetStore.setState({
    agents: [agentWithTeam('a1', 'Team Lead', 't1'), agentWithTeam('a2', 'Coder', 't1'), booZero],
    selectedAgentId: null,
  })
  useConnectionStore.setState({ status: 'connected', client: null, gatewayUrl: '' })
  useBooZeroStore.setState({ booZeroAgentId: booZero.id })
}

describe('GroupChatPanel — Boo Zero roster eligibility', () => {
  it('excludes a Boo Zero that belongs to a DIFFERENT team from the tag chips', async () => {
    server.use(
      http.get('/api/chat-history', () => HttpResponse.json({ entries: [] })),
      http.get('/api/board', () => HttpResponse.json({ tasks: [] })),
    )
    // Boo Zero is "Bug Fixer Boo" — a member of team t2, promoted via override.
    seedRosterTest(agentWithTeam('bugfixer', 'Bug Fixer Boo', 't2'))

    render(
      <ThemeProvider>
        <GroupChatPanel teamId="t1" embedded />
      </ThemeProvider>,
    )

    // The team's own members are taggable…
    expect(await screen.findByTitle('Tag @Team Lead')).toBeInTheDocument()
    expect(screen.getByTitle('Tag @Coder')).toBeInTheDocument()
    // …but the cross-team Boo Zero never appears in the roster.
    expect(screen.queryByTitle('Tag @Bug Fixer Boo')).toBeNull()
  })

  it('includes a TEAMLESS Boo Zero (the universal coordinator) in every team', async () => {
    server.use(
      http.get('/api/chat-history', () => HttpResponse.json({ entries: [] })),
      http.get('/api/board', () => HttpResponse.json({ tasks: [] })),
    )
    seedRosterTest(agentWithTeam('bz', 'Boo Zero', null))

    render(
      <ThemeProvider>
        <GroupChatPanel teamId="t1" embedded />
      </ThemeProvider>,
    )

    expect(await screen.findByTitle('Tag @Boo Zero')).toBeInTheDocument()
  })
})
