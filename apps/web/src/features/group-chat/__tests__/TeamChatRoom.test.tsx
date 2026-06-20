import type { ReactElement } from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { axe } from 'jest-axe'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { ThemeProvider } from '@/features/theme/ThemeProvider'

import { server } from '../../../__vitest__/mswServer'
import { TeamChatRoom } from '../TeamChatRoom'

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

  it('has no level-A/AA a11y violations', async () => {
    const { container } = renderRoom(<TeamChatRoom teamId="t1" onClose={noop} />)
    await screen.findByTestId('team-chat-room')
    expect(
      await axe(container, { rules: { 'color-contrast': { enabled: false } } }),
    ).toHaveNoViolations()
  })
})
