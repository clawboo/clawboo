// The System view's pointer to where Boo Zero's settings live. It still named a
// Global brief after that field was removed (it was saved but never read).

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { useBooZeroStore } from '@/stores/booZero'
import type { AgentState } from '@/stores/fleet'
import { useFleetStore } from '@/stores/fleet'
import { useTeamStore } from '@/stores/team'

import { BooZeroBriefsPanel } from '../BooZeroBriefsPanel'

beforeEach(() => {
  useFleetStore.setState({ agents: [{ id: 'bz', name: 'Boo Zero' } as AgentState] })
  useBooZeroStore.setState({ booZeroAgentId: 'bz' })
  useTeamStore.setState({ teams: [], selectedTeamId: null })
})
afterEach(() => cleanup())

describe('BooZeroBriefsPanel', () => {
  it('points to the display name only, and names no Global brief', () => {
    render(<BooZeroBriefsPanel />)
    expect(screen.getByText('Boo Zero: Display name')).toBeInTheDocument()
    expect(screen.queryByText(/global brief/i)).toBeNull()
  })
})
