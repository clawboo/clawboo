// The team rail's frame: as wide as the macOS window buttons (72px), icons sized
// to sit centred in it, and the add-team button at the end of the team icons,
// scrolling with them, in the look it always had.

import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { useConnectionStore } from '@/stores/connection'
import { useFleetStore } from '@/stores/fleet'
import { useMarketplaceStore } from '@/stores/marketplace'
import type { Team } from '@/stores/team'
import { useTeamStore } from '@/stores/team'
import { useViewStore } from '@/stores/view'

import { MAX_TOGGLE_LEFT, RAIL_ICON_SIZE, RAIL_WIDTH } from '../railMetrics'
import { TeamSidebar } from '../TeamSidebar'

function team(id: string, name: string, isArchived = false): Team {
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

const ADD_TEAM_CLASSES =
  'flex h-10 w-10 shrink-0 cursor-pointer items-center justify-center rounded-[13px] border border-dashed border-border-strong bg-transparent p-0 text-foreground/40 transition-all duration-150 hover:border-primary hover:text-primary hover:bg-primary/[0.06]'

beforeEach(() => {
  useConnectionStore.setState({ status: 'connected', client: null, gatewayUrl: '' })
  useFleetStore.setState({ agents: [] })
  useTeamStore.setState({
    teams: [team('t1', 'Growth Studio'), team('t2', 'Support Desk'), team('t3', 'Old', true)],
    selectedTeamId: 't1',
  })
  useViewStore.setState({ viewMode: { type: 'nav', view: 'graph' } })
  useMarketplaceStore.setState({ marketplaceTab: 'agents' })
})
afterEach(() => cleanup())

describe('the team rail', () => {
  it('is 72px wide, the width of the window buttons', () => {
    expect(RAIL_WIDTH).toBe(72)
    render(<TeamSidebar />)
    expect(screen.getByTestId('team-sidebar').style.width).toBe('72px')
  })

  it('sizes its icons to sit centred in it', () => {
    render(<TeamSidebar />)
    for (const name of ['Boo Zero', 'Growth Studio', 'Support Desk', 'Archived (1)']) {
      const icon = screen.getByRole('button', { name })
      expect(icon.style.width).toBe(`${RAIL_ICON_SIZE}px`)
      expect(icon.style.height).toBe(`${RAIL_ICON_SIZE}px`)
    }
    // 12px of rail either side of a 48px icon.
    expect((RAIL_WIDTH - RAIL_ICON_SIZE) / 2).toBe(12)
  })

  it('keeps the peek toggle inside the wider rail', () => {
    expect(MAX_TOGGLE_LEFT).toBe(RAIL_WIDTH - 32)
    render(<TeamSidebar peek showToggle toggleAnchor={{ left: 500, top: 6 }} />)
    const holder = screen.getByTestId('sidebar-toggle').parentElement!
    expect(holder.style.paddingLeft).toBe(`${MAX_TOGGLE_LEFT}px`)
  })
})

describe('the add-team button', () => {
  it('sits at the end of the team icons, in the same scrolling list', () => {
    render(<TeamSidebar />)
    const add = screen.getByRole('button', { name: 'Create a team' })
    const list = screen.getByRole('button', { name: 'Growth Studio' }).closest('.overflow-y-auto')
    expect(list).not.toBeNull()
    expect(list).toContainElement(add)
    // Last in the list: after every team icon and the archived group.
    expect(list!.lastElementChild).toContainElement(add)
    const order = within(list as HTMLElement)
      .getAllByRole('button')
      .map((b) => b.getAttribute('aria-label'))
    expect(order).toEqual(['Growth Studio', 'Support Desk', 'Archived (1)', 'Create a team'])
  })

  it('stays last when the archived teams are shown', async () => {
    render(<TeamSidebar />)
    await userEvent.click(screen.getByRole('button', { name: 'Archived (1)' }))
    const list = screen.getByRole('button', { name: 'Growth Studio' }).closest('.overflow-y-auto')!
    const buttons = within(list as HTMLElement).getAllByRole('button')
    expect(buttons[buttons.length - 1]).toHaveAccessibleName('Create a team')
  })

  it('keeps its look exactly, and opens the Teams tab of the Marketplace', async () => {
    render(<TeamSidebar />)
    const add = screen.getByRole('button', { name: 'Create a team' })
    expect(add.className).toBe(ADD_TEAM_CLASSES)
    await userEvent.click(add)
    expect(useViewStore.getState().viewMode).toEqual({ type: 'nav', view: 'marketplace' })
    expect(useMarketplaceStore.getState().marketplaceTab).toBe('teams')
  })
})
