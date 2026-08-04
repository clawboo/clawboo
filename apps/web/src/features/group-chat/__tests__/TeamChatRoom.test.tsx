import { act, type ReactElement } from 'react'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ThemeProvider } from '@/features/theme/ThemeProvider'

import { server } from '../../../__vitest__/mswServer'
import { TeamChatRoom } from '../TeamChatRoom'

import { axe } from '@/__vitest__/axe'

afterEach(() => cleanup())

// TeamChatRoom renders AgentBooAvatar, which reads theme context.
const renderRoom = (ui: ReactElement) => render(<ThemeProvider>{ui}</ThemeProvider>)

const ROOM = {
  roomId: 'team:t1',
  nextSeq: 3,
  posts: [
    {
      id: 'p1',
      roomId: 'team:t1',
      teamId: 't1',
      authorAgentId: 'a1',
      body: 'Picking up the tagline task',
      kind: 'peer',
      createdAt: 1,
      seq: 1,
    },
    {
      id: 'p2',
      roomId: 'team:t1',
      teamId: 't1',
      authorAgentId: '',
      body: 'Task "tagline" → done.',
      kind: 'system',
      createdAt: 2,
      seq: 2,
    },
  ],
}

beforeEach(() => {
  server.use(http.get('/api/team-chat', () => HttpResponse.json(ROOM)))
})

const noop = (): void => {}

describe('TeamChatRoom', () => {
  it('renders the room + the "any runtime can lead" framing', async () => {
    renderRoom(<TeamChatRoom teamId="t1" onClose={noop} />)
    expect(await screen.findByTestId('team-chat-room')).toBeInTheDocument()
    expect(screen.getByText(/any runtime can lead/i)).toBeInTheDocument()
  })

  it('renders peer posts and system narration', async () => {
    renderRoom(<TeamChatRoom teamId="t1" onClose={noop} />)
    expect(await screen.findByText('Picking up the tagline task')).toBeInTheDocument()
    expect(screen.getByText(/Task "tagline" → done\./)).toBeInTheDocument()
  })

  // The drawer already carried role="dialog" + a label, but had no aria-modal
  // and no focus trap — Tab walked straight out behind the scrim.
  it('is a modal dialog that closes on Escape', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    renderRoom(<TeamChatRoom teamId="t1" onClose={onClose} />)

    const dialog = await screen.findByRole('dialog', { name: 'Team room' })
    expect(dialog).toHaveAttribute('aria-modal', 'true')

    await user.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  // The room polls every 8 s. Posts that land while it's open are announced;
  // the backlog present on first load is not (that would read the whole room).
  it('announces a post that arrives after the room opened, not the backlog', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    renderRoom(<TeamChatRoom teamId="t1" onClose={noop} />)
    await screen.findByText('Picking up the tagline task')
    expect(screen.getByTestId('team-chat-announcer')).toBeEmptyDOMElement()

    server.use(
      http.get('/api/team-chat', () =>
        HttpResponse.json({
          ...ROOM,
          nextSeq: 4,
          posts: [
            ...ROOM.posts,
            {
              id: 'p3',
              roomId: 'team:t1',
              teamId: 't1',
              authorAgentId: 'a1',
              body: 'Tagline drafted',
              kind: 'peer',
              createdAt: 3,
              seq: 3,
            },
          ],
        }),
      ),
    )

    // Fast-forward to the next 8 s poll.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(8000)
    })

    await waitFor(() =>
      expect(screen.getByTestId('team-chat-announcer')).toHaveTextContent(/Tagline drafted/),
    )
    vi.useRealTimers()
  })

  it('has no level-A/AA a11y violations', async () => {
    const { container } = renderRoom(<TeamChatRoom teamId="t1" onClose={noop} />)
    await screen.findByTestId('team-chat-room')
    expect(await axe(container)).toHaveNoViolations()
  })
})
