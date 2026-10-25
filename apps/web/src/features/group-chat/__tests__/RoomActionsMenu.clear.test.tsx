// Clear chat, from a room's "..." menu. On General it is the only action; on a
// room it sits beside Pin, Rename and Delete. Clearing asks first, then empties
// that chat's transcripts on screen and leaves every other chat alone.

import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { server } from '@/__vitest__/mswServer'
import type { Room } from '@/lib/roomsClient'
import { useChatStore } from '@/stores/chat'
import { useConnectionStore } from '@/stores/connection'
import { useFleetStore } from '@/stores/fleet'
import { useRoomStore } from '@/stores/rooms'
import { useTeamStore } from '@/stores/team'

vi.mock('@/stores/confirm', () => ({ confirm: vi.fn(async () => true) }))

const { RoomActionsMenu } = await import('../RoomActionsMenu')

const GENERAL: Room = {
  id: '',
  teamId: 'T',
  name: 'General',
  memberIds: ['a1'],
  pinnedAt: null,
  createdAt: 0,
  updatedAt: 0,
}
const DESIGN: Room = { ...GENERAL, id: 'R1', name: 'Design', createdAt: 1, updatedAt: 1 }

const generalKey = 'agent:a1:team:T'
const roomKey = 'agent:a1:team:T:room:R1'

const posted: unknown[] = []

beforeEach(() => {
  posted.length = 0
  server.use(
    http.post('/api/teams/T/chat/clear', async ({ request }) => {
      posted.push(await request.json())
      return HttpResponse.json({ ok: true, clearedAt: 1234, cleared: 1 })
    }),
  )
  useChatStore.setState({
    transcripts: new Map([
      [generalKey, [{ entryId: 'g' } as never]],
      [roomKey, [{ entryId: 'r' } as never]],
    ]),
    streamingText: new Map(),
  })
  useConnectionStore.setState({ client: null })
  useFleetStore.setState({ agents: [] })
  useTeamStore.setState({
    teams: [
      {
        id: 'T',
        name: 'T',
        icon: 'T',
        color: '#e94560',
        colorCollectionId: null,
        templateId: null,
        agentCount: 1,
        leaderAgentId: null,
        isArchived: false,
        serverOrchestrated: true,
      },
    ],
  })
})
afterEach(() => cleanup())

function open(room: Room, general: boolean) {
  const anchor = { top: 0, bottom: 20, left: 0, right: 200 } as DOMRect
  render(
    <RoomActionsMenu
      room={room}
      anchor={anchor}
      onClose={() => undefined}
      onRename={() => undefined}
      general={general}
    />,
  )
}

describe('Clear chat', () => {
  it('is the only action on General, and clears only its chat', async () => {
    open(GENERAL, true)
    const items = screen.getAllByRole('menuitem').map((i) => i.textContent)
    expect(items).toEqual(['Clear chat'])

    await userEvent.click(screen.getByRole('menuitem', { name: 'Clear chat' }))
    await vi.waitFor(() => expect(posted).toEqual([{}]))
    await vi.waitFor(() => expect(useChatStore.getState().transcripts.has(generalKey)).toBe(false))
    expect(useChatStore.getState().transcripts.has(roomKey)).toBe(true)
    expect(useTeamStore.getState().teams[0]?.chatClearedAt).toBe(1234)
  })

  it("sits in a room's menu and clears only that room", async () => {
    useRoomStore.getState().upsert(DESIGN)
    open(DESIGN, false)
    expect(screen.getAllByRole('menuitem').map((i) => i.textContent)).toEqual([
      'Pin',
      'Rename',
      'Clear chat',
      'Delete',
    ])

    await userEvent.click(screen.getByRole('menuitem', { name: 'Clear chat' }))
    await vi.waitFor(() => expect(posted).toEqual([{ roomId: 'R1' }]))
    await vi.waitFor(() => expect(useChatStore.getState().transcripts.has(roomKey)).toBe(false))
    expect(useChatStore.getState().transcripts.has(generalKey)).toBe(true)
  })

  describe("an OpenClaw teammate's conversation, which lives in the Gateway", () => {
    const call = vi.fn(
      async (_method: string, _params: { sessionKey: string; message: string }) => ({}),
    )
    beforeEach(() => {
      call.mockClear()
      useConnectionStore.setState({ client: { call } as never })
      useFleetStore.setState({
        agents: [
          { id: 'a1', name: 'Ada', teamId: 'T', runtime: 'openclaw' },
          { id: 'a2', name: 'Bea', teamId: 'T', runtime: 'clawboo-native' },
          { id: 'a4', name: 'Dee', teamId: 'T', runtime: 'openclaw' },
          { id: 'a9', name: 'Zed', teamId: 'OTHER', runtime: 'openclaw' },
        ] as never,
      })
    })

    it("General's clear sends /reset to the team's OpenClaw teammates", async () => {
      open(GENERAL, true)
      await userEvent.click(screen.getByRole('menuitem', { name: 'Clear chat' }))
      await vi.waitFor(() => expect(call).toHaveBeenCalledTimes(2))
      const reset = call.mock.calls.map(([method, params]) => [method, params.sessionKey])
      expect(reset).toEqual(
        expect.arrayContaining([
          ['chat.send', 'agent:a1:team:T'],
          ['chat.send', 'agent:a4:team:T'],
        ]),
      )
      expect(call).toHaveBeenCalledWith(
        'chat.send',
        expect.objectContaining({ message: '/reset', deliver: false }),
      )
    })

    it("a room's clear resets only its own OpenClaw members, on the room's keys", async () => {
      useRoomStore.getState().upsert(DESIGN)
      open(DESIGN, false)
      await userEvent.click(screen.getByRole('menuitem', { name: 'Clear chat' }))
      await vi.waitFor(() => expect(call).toHaveBeenCalledTimes(1))
      expect(call).toHaveBeenCalledWith(
        'chat.send',
        expect.objectContaining({ sessionKey: roomKey, message: '/reset' }),
      )
    })
  })
})
