// A paused item looks paused wherever it shows: on a board card, on an agent's face,
// on a chat's task card, in the reply box's hint and in the menus that pause it. A
// pause raises no alert, since a person placed it.

import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { AgentBooAvatar } from '@/components/AgentBooAvatar'
import { collectAlertItems } from '@/features/alerts/alertRules'
import { TaskCard } from '@/features/board/TaskCard'
import { replyHint } from '@/features/board/TaskReplyBox'
import { receiptText } from '@/features/board/ReplyReceipt'
import { GraphContextMenu } from '@/features/graph/GraphContextMenu'
import { toneFor } from '@/features/group-chat/BoardTaskCard'
import { TeamContextMenu } from '@/features/teams/TeamContextMenu'
import { ThemeProvider } from '@/features/theme/ThemeProvider'
import type { BoardTask } from '@/lib/boardClient'
import type { BoardTaskView } from '@/stores/board'
import { routineHeldWords, runPill, statusPill } from '@/features/routines/routineHelpers'
import { useBoardStore } from '@/stores/board'
import { useFleetStore, type AgentState } from '@/stores/fleet'
import { pauseOfTeamChat, usePauseStore, type PauseView } from '@/stores/pauses'

const PAUSE: PauseView = {
  kind: 'agent',
  id: 'a1',
  name: 'Ada',
  reason: null,
  pausedBy: null,
  pausedAt: 1,
}

beforeEach(() => {
  usePauseStore.setState({ pauses: [] })
  useFleetStore.setState({ agents: [{ id: 'a1', name: 'Ada', teamId: 'T' } as AgentState] })
})
afterEach(() => {
  cleanup()
  usePauseStore.setState({ pauses: [] })
  useFleetStore.setState({ agents: [] })
})

describe('an agent face', () => {
  const face = () =>
    render(
      <ThemeProvider>
        <AgentBooAvatar agentId="a1" size={32} />
      </ThemeProvider>,
    )

  it('carries no mark, and no extra element, while nothing covers it', () => {
    face()
    expect(screen.queryByTestId('agent-paused-a1')).toBeNull()
  })

  it('carries the mark under its own pause', () => {
    usePauseStore.setState({ pauses: [PAUSE] })
    face()
    expect(screen.getByTestId('agent-paused-a1').textContent).toContain('Paused')
  })

  it('carries the mark under its team pause', () => {
    usePauseStore.setState({ pauses: [{ ...PAUSE, kind: 'team', id: 'T', name: 'Growth' }] })
    face()
    expect(screen.getByTestId('agent-paused-a1')).toBeTruthy()
  })
})

describe('a board card', () => {
  const task = (pause: PauseView | null): BoardTask =>
    ({ id: 't1', title: 'Work', status: 'todo', pause }) as unknown as BoardTask
  const card = (pause: PauseView | null) =>
    render(
      <ThemeProvider>
        <TaskCard task={task(pause)} onClick={() => undefined} />
      </ThemeProvider>,
    )

  it('names what is paused and who paused it', () => {
    card(PAUSE)
    expect(screen.getByTitle('Ada is paused. You paused it.')).toBeTruthy()
  })

  it('shows nothing when no pause covers it', () => {
    card(null)
    expect(screen.queryByTitle(/is paused/)).toBeNull()
  })
})

describe('a task card in the team chat', () => {
  const view = (extra: object): BoardTaskView =>
    ({
      id: 't1',
      title: 'Work',
      status: 'todo',
      sourceDelegationId: 'p:agent:a1',
      ...extra,
    }) as never

  it('reads Paused rather than Queued', () => {
    expect(toneFor(view({})).label).toBe('Queued')
    expect(toneFor(view({ pause: PAUSE })).label).toBe('Paused')
  })

  it('still leads with why a task needs a person', () => {
    const attention = { reason: 'failed', failedRuns: 1 }
    expect(toneFor(view({ pause: PAUSE, status: 'blocked', attention })).label).not.toBe('Paused')
  })
})

describe('a reply on a paused task', () => {
  it('says beforehand that it waits for the resume, not that it starts the agent', () => {
    expect(replyHint('todo', 'Ada')).toContain('Sending starts Ada')
    expect(replyHint('todo', 'Ada', true)).toBe(
      'This is paused. Ada starts on your reply after the resume.',
    )
    expect(replyHint('done', 'Ada', true)).toContain('finished')
  })

  it('says afterwards where it went', () => {
    expect(receiptText({ status: 'queued', agentId: 'a1', reason: 'paused' }, 'Ada')).toBe(
      'Saved. Ada starts on this after the resume',
    )
  })
})

describe('the menus', () => {
  it("offers Pause team, or Resume team when it is paused, and calls the menu's handler", async () => {
    const onTogglePause = vi.fn()
    const props = {
      x: 0,
      y: 0,
      teamName: 'Growth',
      isArchived: false,
      onClose: vi.fn(),
      onTogglePause,
      onArchive: vi.fn(),
      onRefreshProtocol: vi.fn(),
      onDelete: vi.fn(),
      onDeleteWithAgents: vi.fn(),
    }
    const { rerender } = render(<TeamContextMenu {...props} isPaused={false} />)
    await userEvent.click(screen.getByRole('menuitem', { name: 'Pause team' }))
    expect(onTogglePause).toHaveBeenCalledTimes(1)
    rerender(<TeamContextMenu {...props} isPaused />)
    expect(screen.getByRole('menuitem', { name: 'Resume team' })).toBeTruthy()
  })

  it('offers Pause on an Org chart agent, or Resume when it is paused', async () => {
    const onTogglePause = vi.fn()
    const props = {
      x: 0,
      y: 0,
      agentName: 'Ada',
      onClose: vi.fn(),
      onChat: vi.fn(),
      onDelete: vi.fn(),
      onTogglePause,
    }
    const { rerender } = render(<GraphContextMenu {...props} />)
    await userEvent.click(screen.getByRole('menuitem', { name: 'Pause' }))
    expect(onTogglePause).toHaveBeenCalledTimes(1)
    rerender(<GraphContextMenu {...props} isPaused />)
    expect(screen.getByRole('menuitem', { name: 'Resume' })).toBeTruthy()
  })

  it('leaves the row out where no handler is given', () => {
    render(
      <GraphContextMenu
        x={0}
        y={0}
        agentName="Ada"
        onClose={vi.fn()}
        onChat={vi.fn()}
        onDelete={vi.fn()}
      />,
    )
    expect(screen.queryByRole('menuitem', { name: 'Pause' })).toBeNull()
  })
})

describe('the alerts', () => {
  it('announce nothing for a task a pause holds back: a person placed it', () => {
    const items = collectAlertItems(
      [{ id: 't1', title: 'Work', status: 'todo', attention: null, updatedAt: 1 }],
      [],
    )
    expect(items).toEqual([])
  })
})

describe('a team chat whose lead is paused', () => {
  it('shows the lead\u2019s pause, and the team\u2019s first when both are', () => {
    const lead = { ...PAUSE, id: 'boo', name: 'Boo Zero' }
    const team = { ...PAUSE, kind: 'team' as const, id: 'T', name: 'Growth' }
    expect(pauseOfTeamChat([lead], 'T', 'boo')).toBe(lead)
    expect(pauseOfTeamChat([lead, team], 'T', 'boo')).toBe(team)
    expect(pauseOfTeamChat([lead], 'T', 'someone-else')).toBeNull()
    expect(pauseOfTeamChat([lead], 'T', null)).toBeNull()
  })
})

describe('a task card that arrives by frame', () => {
  it('keeps the pause a frame carried, until one says otherwise', () => {
    const store = useBoardStore.getState()
    store.reset('T')
    store.applyChange('T', { id: 't1', title: 'Work', status: 'todo', updatedAt: 1, pause: PAUSE })
    const read = () => useBoardStore.getState().tasksByTeam.get('T')!.get('t1')!
    expect(toneFor(read()).label).toBe('Paused')
    store.applyChange('T', { id: 't1', summary: 'more', updatedAt: 2 })
    expect(read().pause).toEqual(PAUSE)
    store.applyChange('T', { id: 't1', status: 'todo', updatedAt: 3, pause: null })
    expect(toneFor(read()).label).toBe('Queued')
  })
})

describe('a routine a pause holds back', () => {
  const held = { kind: 'agent', id: 'a1', name: 'Ada' }
  it('reads as on hold, not on or queued, and says why', () => {
    expect(
      statusPill({ status: 'idle', nextRunAt: 5, manageability: 'managed', heldBy: held }).label,
    ).toBe('on hold')
    expect(
      statusPill({ status: 'queued', nextRunAt: 5, manageability: 'managed', heldBy: held }).label,
    ).toBe('on hold')
    expect(routineHeldWords({ heldBy: held })).toBe('Ada is paused, so this runs on resume')
    expect(routineHeldWords({ heldBy: null })).toBeNull()
  })

  it('still reads as running while a fire is under way', () => {
    expect(
      statusPill({ status: 'running', nextRunAt: 5, manageability: 'managed', heldBy: held }).label,
    ).toBe('running')
  })

  it('a fire a pause stopped reads as paused in the history', () => {
    expect(runPill('paused', 'agent')).toEqual({ tone: 'idle', label: 'paused' })
  })
})
