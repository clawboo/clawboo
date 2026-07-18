// TeamOnboardingGate phase selection — which screen a team lands on, and the shared
// `MeetYourTeamCard` it renders.
//
// The onboarding regression this guards: `CreateTeamModal`'s `presatisfyOnboardingGate`
// used to PATCH `userIntroduced: true` + `userIntroText: ''` alongside
// `agentsIntroduced`, which (a) skipped the "introduce yourself" screen entirely for the
// first team and (b) left its `userIntroText` permanently blank — so the server's team
// context preamble never told those agents who the user is, a gap every marketplace team
// was spared. Onboarding now pre-satisfies ONLY the welcome phase (the wizard's
// `NativeReadyStep` IS that beat), so the gate must open on the user's introduction.

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AgentState } from '@/stores/fleet'
import type { Team } from '@/stores/team'
import { TeamOnboardingGate } from '../TeamOnboardingGate'

afterEach(() => cleanup())

const agent = (id: string, name: string): AgentState => ({ id, name }) as unknown as AgentState

const TEAM = { id: 'team-1', name: 'Content Crew', color: '#e94560' } as unknown as Team
const TEAM_AGENTS = [agent('a1', 'Captain Boo'), agent('a2', 'Pixel Boo')]
const BOO_ZERO = agent('native-bz', 'Boo Zero')

function renderGate(over: { agentsIntroduced: boolean; userIntroduced: boolean }) {
  return render(
    <TeamOnboardingGate
      teamId="team-1"
      team={TEAM}
      teamAgents={TEAM_AGENTS}
      booZeroAgent={BOO_ZERO}
      onMarkAgentsIntroduced={vi.fn().mockResolvedValue(undefined)}
      onMarkUserIntroduced={vi.fn().mockResolvedValue(undefined)}
      {...over}
    />,
  )
}

describe('TeamOnboardingGate phase selection', () => {
  it('a brand-new team opens on the welcome card (marketplace path)', () => {
    renderGate({ agentsIntroduced: false, userIntroduced: false })
    expect(screen.getByTestId('meet-your-team-card')).toBeInTheDocument()
    expect(screen.getByTestId('know-your-team-button')).toBeInTheDocument()
    expect(screen.queryByTestId('user-intro-textarea')).not.toBeInTheDocument()
  })

  it('the welcome card names Boo Zero as the leader', () => {
    renderGate({ agentsIntroduced: false, userIntroduced: false })
    expect(screen.getByTestId('led-by-boo-zero-badge')).toHaveTextContent(/Led by\s*Boo Zero/)
    // Boo Zero is teamless — it leads via the badge, never as a roster member.
    expect(screen.getByText('Captain Boo')).toBeInTheDocument()
    expect(screen.getByText('Pixel Boo')).toBeInTheDocument()
  })

  it('THE onboarding regression: agentsIntroduced-only opens the user INTRODUCTION, not the welcome', () => {
    // This is the exact state `presatisfyOnboardingGate` now writes. Regressing it to
    // also set `userIntroduced` would drop the user straight into the group chat and
    // blank the team's `userIntroText` forever.
    renderGate({ agentsIntroduced: true, userIntroduced: false })
    expect(screen.getByTestId('user-intro-textarea')).toBeInTheDocument()
    expect(screen.getByTestId('submit-user-intro')).toBeInTheDocument()
    // The wizard's NativeReadyStep already showed this card — don't replay it.
    expect(screen.queryByTestId('meet-your-team-card')).not.toBeInTheDocument()
    expect(screen.queryByTestId('know-your-team-button')).not.toBeInTheDocument()
  })
})
