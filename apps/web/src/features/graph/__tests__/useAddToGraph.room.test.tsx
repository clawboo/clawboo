// The + button's New agent on a room's graph. A room's graph draws only the
// room's members, so the agent made there joins the room as well as the team.

import { act, renderHook } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { beforeEach, describe, expect, it } from 'vitest'

import { server } from '@/__vitest__/mswServer'
import type { Room } from '@/lib/roomsClient'
import { useRoomStore } from '@/stores/rooms'

import { useAddToGraph } from '../useAddToGraph'

const ROOM: Room = {
  id: 'R1',
  teamId: 'T',
  name: 'Design',
  memberIds: ['a1'],
  pinnedAt: null,
  createdAt: 1,
  updatedAt: 1,
}

let created: unknown = null
let roomPatch: unknown = null

beforeEach(() => {
  created = null
  roomPatch = null
  useRoomStore.setState({ roomsByTeam: new Map([['T', [ROOM]]]), loadedTeams: new Set(['T']) })
  server.use(
    http.get('/api/connectors', () => HttpResponse.json({ connectors: [] })),
    http.get('/api/connectors/configured', () => HttpResponse.json({ slugs: [], supplied: [] })),
    http.get('/api/connectors/composio', () => HttpResponse.json({ connected: [] })),
    http.post('/api/agents', async ({ request }) => {
      created = await request.json()
      return HttpResponse.json({ agent: { id: 'a2' } }, { status: 201 })
    }),
    http.patch('/api/teams/T/rooms/R1', async ({ request }) => {
      roomPatch = await request.json()
      return HttpResponse.json({ room: { ...ROOM, memberIds: ['a1', 'a2'] } })
    }),
  )
})

function setup(newAgentRoomId: string | null) {
  return renderHook(() =>
    useAddToGraph({
      canvasKey: 'team-T',
      getNodes: () => [],
      getEdges: () => [],
      getZoom: () => 1,
      screenToFlowPosition: (p) => p,
      paneRef: { current: null },
      barRef: { current: null },
      newAgentTeamId: 'T',
      newAgentRoomId,
    }),
  )
}

describe('New agent from the + button', () => {
  it("on a room's graph, joins the room as well as the team", async () => {
    const { result } = setup('R1')
    await act(() => result.current.createAgent('Bea'))
    expect(created).toMatchObject({ name: 'Bea', teamId: 'T' })
    expect(roomPatch).toEqual({ memberIds: ['a1', 'a2'] })
    expect(useRoomStore.getState().roomsByTeam.get('T')?.[0]?.memberIds).toEqual(['a1', 'a2'])
  })

  it("on the team's own graph, joins the team and no room", async () => {
    const { result } = setup(null)
    await act(() => result.current.createAgent('Bea'))
    expect(created).toMatchObject({ name: 'Bea', teamId: 'T' })
    expect(roomPatch).toBeNull()
  })
})
