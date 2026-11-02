// The Org chart / Ghost Graph empty state. Agents on every runtime show up
// here, so the hint must not send people to the OpenClaw Gateway: an install
// without one has nothing to connect, and its agents still draw.

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { useGraphStore } from '../store'
import { GhostGraphPanel } from '../GhostGraphPanel'

// The canvas itself is out of scope; only the overlay copy is under test.
vi.mock('../GhostGraph', () => ({ GhostGraph: () => null }))
vi.mock('@/features/promo/GitHubStarButton', () => ({ GitHubStarButton: () => null }))

afterEach(() => cleanup())

describe('GhostGraphPanel empty state', () => {
  it.each(['atlas', 'team'] as const)(
    '%s scope points to creating agents, not a Gateway',
    (scope) => {
      useGraphStore.setState({ nodes: [], isLoadingFiles: false, filesError: null })

      render(<GhostGraphPanel scope={scope} />)

      expect(screen.getByText('No agents yet')).toBeInTheDocument()
      expect(
        screen.getByText('Create a Boo or deploy a team from the Marketplace to see it here.'),
      ).toBeInTheDocument()
      expect(screen.queryByText(/Gateway/)).not.toBeInTheDocument()
    },
  )
})
