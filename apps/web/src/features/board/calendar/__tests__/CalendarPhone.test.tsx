// The board at phone width, rendered through the real BoardPanel against msw.
//
// Every lane is as wide as the screen less a strip of the next one, so a lane's
// cards read at full width, and the board snaps lane to lane as it is swiped:
// Needs you first, then the statuses in order. The header keeps a way to the
// sidebar, which at this width is a drawer rather than a column.
//
// On a wide window none of that applies: the fixed Needs you track, status
// columns that share the space, no snapping.

import { cleanup, render, screen } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { mockPhoneViewport, type PhoneViewport } from '@/__vitest__/phoneViewport'
import { ThemeProvider } from '@/features/theme/ThemeProvider'
import { useTeamStore } from '@/stores/team'
import { useToastStore } from '@/stores/toast'
import { useViewStore } from '@/stores/view'

import { server } from '../../../../__vitest__/mswServer'
import { BoardPanel } from '../../BoardPanel'
import { resetBoardStorage } from '../../__tests__/resetBoardStorage'
import { PHONE_LANE } from '../CalendarGrid'

function serve(): void {
  const createdAt = Date.now() - 60_000
  server.use(
    http.get('/api/board', () =>
      HttpResponse.json({
        tasks: [
          { id: 't1', title: 'Write the brief', status: 'todo', createdAt, assigneeAgentId: 'a1' },
          { id: 't2', title: 'Ship it', status: 'in_progress', createdAt, assigneeAgentId: 'a1' },
        ],
      }),
    ),
    http.get('/api/teams', () => HttpResponse.json({ teams: [] })),
    http.get('/api/schedules', () =>
      HttpResponse.json({
        schedules: [],
        sources: [{ sourceId: 'clawboo-routine', ok: true, degraded: false, at: 1 }],
      }),
    ),
    http.get('/api/schedules/occurrences', () =>
      HttpResponse.json({ now: Date.now(), routines: [] }),
    ),
  )
}

function renderBoard() {
  return render(
    <ThemeProvider>
      <BoardPanel />
    </ThemeProvider>,
  )
}

/** The grid's tracks, one per lane (the Kanban board has no date gutter). */
function tracks(): string[] {
  const template = screen.getByTestId('board-calendar').style.gridTemplateColumns
  return template.match(/var\([^)]*\)|minmax\([^)]*\)|\S+/g) ?? []
}

let viewport: PhoneViewport

beforeEach(() => {
  useTeamStore.setState({ teams: [], selectedTeamId: null })
  useToastStore.setState({ toasts: [] })
  useViewStore.setState({ columnCollapsed: false })
  resetBoardStorage({ view: 'all' })
  serve()
})
afterEach(() => {
  cleanup()
  viewport.restore()
})

describe('the board at phone width', () => {
  beforeEach(() => {
    viewport = mockPhoneViewport(true)
  })

  it('draws every open lane a screen wide, the folded Cancelled rail aside', async () => {
    renderBoard()
    await screen.findByTestId('board-calendar')
    const [needsYou, ...statuses] = tracks()
    expect(needsYou).toBe(PHONE_LANE)
    // The screen less the 16 px side gutter, the 8 px gap and a 32 px strip of
    // the next lane.
    expect(screen.getByTestId('board-calendar').style.getPropertyValue('--board-phone-lane')).toBe(
      'calc(100vw - 56px)',
    )
    const cancelled = statuses.pop()
    expect(cancelled).toBe('40px')
    expect(statuses.length).toBeGreaterThan(0)
    for (const track of statuses) expect(track).toBe(PHONE_LANE)
  })

  it('snaps lane to lane, Needs you first', async () => {
    renderBoard()
    await screen.findByTestId('board-calendar')
    expect(screen.getByTestId('board-scroll')).toHaveClass('snap-x', 'snap-mandatory')
    expect(screen.getByTestId('board-column-needs-you')).toHaveClass('snap-start')
    expect(screen.getByTestId('board-column-todo')).toHaveClass('snap-start')
  })

  it('keeps a way to the sidebar in its header', async () => {
    renderBoard()
    await screen.findByTestId('board-calendar')
    expect(screen.getByTestId('board-header')).toContainElement(
      screen.getByTestId('sidebar-toggle'),
    )
  })
})

describe('the board on a wide window', () => {
  beforeEach(() => {
    viewport = mockPhoneViewport(false)
  })

  it('keeps the fixed Needs you track and shares the rest, with no snapping', async () => {
    renderBoard()
    await screen.findByTestId('board-calendar')
    const [needsYou, ...statuses] = tracks()
    expect(needsYou).toBe('248px')
    expect(statuses[0]).toMatch(/^minmax\(/)
    expect(screen.getByTestId('board-scroll')).not.toHaveClass('snap-x')
    expect(screen.getByTestId('board-column-needs-you')).not.toHaveClass('snap-start')
    // The sidebar is docked and open, so the header has no toggle for it.
    expect(screen.queryByTestId('sidebar-toggle')).not.toBeInTheDocument()
  })
})
