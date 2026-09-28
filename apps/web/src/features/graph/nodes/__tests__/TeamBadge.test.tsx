import { cleanup, render, screen } from '@testing-library/react'
import { ReactFlowProvider } from '@xyflow/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { useTeamStore, type Team } from '@/stores/team'

import {
  TEAM_BADGE_MIN_SCREEN,
  TEAM_BADGE_SIZE,
  TeamBadge,
  teamBadgeScreenSize,
} from '../TeamBadge'

const team: Team = {
  id: 't1',
  name: 'Research Lab',
  icon: '🔬',
  color: '#3b82f6',
  colorCollectionId: null,
  templateId: null,
  agentCount: 3,
  leaderAgentId: null,
  isArchived: false,
  serverOrchestrated: true,
}

beforeEach(() => useTeamStore.setState({ teams: [team] }))
afterEach(() => cleanup())

describe('TeamBadge', () => {
  it("wears the team's icon and colour, and names the team on hover", () => {
    render(
      <ReactFlowProvider>
        <TeamBadge teamId="t1" />
      </ReactFlowProvider>,
    )
    const badge = screen.getByTestId('team-junction-badge')
    expect(badge).toHaveTextContent('🔬')
    expect(badge).toHaveAttribute('title', 'Research Lab')
    expect(badge).toHaveStyle({ background: '#3b82f6' })
  })

  it('draws nothing for a team that no longer exists, not a blank disc', () => {
    render(
      <ReactFlowProvider>
        <TeamBadge teamId="gone" />
      </ReactFlowProvider>,
    )
    expect(screen.queryByTestId('team-junction-badge')).toBeNull()
  })
})

describe('teamBadgeScreenSize', () => {
  it('holds a legible floor when Atlas is zoomed out, and scales normally past it', () => {
    expect(teamBadgeScreenSize(0.25)).toBeCloseTo(TEAM_BADGE_MIN_SCREEN)
    expect(teamBadgeScreenSize(1)).toBe(TEAM_BADGE_SIZE)
  })
})
