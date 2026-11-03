// Archived teams in the team rail. They were loaded into the store but drawn
// nowhere, so an archive could not be undone from the dashboard. They now sit
// in a collapsed "Archived (n)" group whose icons open the team menu, and its
// Unarchive restores the team through the same PATCH that archived it.

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { server } from '@/__vitest__/mswServer'
import { useConnectionStore } from '@/stores/connection'
import { useFleetStore } from '@/stores/fleet'
import { useToastStore } from '@/stores/toast'
import type { Team } from '@/stores/team'
import { useTeamStore } from '@/stores/team'

import { TeamSidebar } from '../TeamSidebar'

function team(id: string, name: string, isArchived: boolean): Team {
  return {
    id,
    name,
    icon: '📈',
    color: '#10b981',
    colorCollectionId: null,
    templateId: null,
    agentCount: 1,
    leaderAgentId: null,
    isArchived,
    serverOrchestrated: true,
  }
}

let patches: { id: string; body: unknown }[] = []

beforeEach(() => {
  patches = []
  useToastStore.setState({ toasts: [] })
  useConnectionStore.setState({ status: 'connected', client: null, gatewayUrl: '' })
  useFleetStore.setState({ agents: [] })
  useTeamStore.setState({
    teams: [
      team('t1', 'Growth Studio', false),
      team('t2', 'Old Launch', true),
      team('t3', 'Retired Ops', true),
    ],
    selectedTeamId: 't1',
  })
  server.use(
    http.patch('/api/teams/:teamId', async ({ params, request }) => {
      patches.push({ id: String(params['teamId']), body: await request.json() })
      return HttpResponse.json({ ok: true })
    }),
  )
})

afterEach(() => {
  cleanup()
  useConnectionStore.setState({ status: 'disconnected', client: null, gatewayUrl: null })
})

describe('archived teams in the rail', () => {
  it('shows a collapsed Archived (n) group and lists the teams when opened', () => {
    render(<TeamSidebar />)

    const toggle = screen.getByRole('button', { name: 'Archived (2)' })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('button', { name: 'Old Launch (archived)' })).toBeNull()

    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('button', { name: 'Old Launch (archived)' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Retired Ops (archived)' })).toBeInTheDocument()
    // The active team is still drawn once, as an ordinary icon.
    expect(screen.getByRole('button', { name: 'Growth Studio' })).toBeInTheDocument()
  })

  it('restores an archived team through its menu', async () => {
    render(<TeamSidebar />)
    fireEvent.click(screen.getByRole('button', { name: 'Archived (2)' }))
    fireEvent.click(screen.getByRole('button', { name: 'Old Launch (archived)' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Unarchive' }))

    await waitFor(() => expect(patches).toEqual([{ id: 't2', body: { isArchived: 0 } }]))
    await waitFor(() =>
      expect(useTeamStore.getState().teams.find((t) => t.id === 't2')?.isArchived).toBe(false),
    )
    // Back among the active teams, and the group counts one.
    expect(await screen.findByRole('button', { name: 'Old Launch' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Archived (1)' })).toBeInTheDocument()
  })

  it('draws no group when nothing is archived', () => {
    useTeamStore.setState({ teams: [team('t1', 'Growth Studio', false)], selectedTeamId: 't1' })
    render(<TeamSidebar />)
    expect(screen.queryByTestId('archived-teams-toggle')).toBeNull()
  })
})
