// The + button's New agent on a room's graph. A room's graph draws only the
// room's members, so the agent made there joins the room as well as the team.

import { act, renderHook } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { beforeEach, describe, expect, it } from 'vitest'

import { server } from '@/__vitest__/mswServer'
import type { Room } from '@/lib/roomsClient'
import { useRoomStore } from '@/stores/rooms'
import { useToastStore } from '@/stores/toast'

import { joinRoom } from '../operations/spawnNode'
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
  useToastStore.setState({ toasts: [] })
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
    expect(roomPatch).toEqual({ addMemberIds: ['a2'] })
    expect(useRoomStore.getState().roomsByTeam.get('T')?.[0]?.memberIds).toEqual(['a1', 'a2'])
  })

  it("on the team's own graph, joins the team and no room", async () => {
    const { result } = setup(null)
    await act(() => result.current.createAgent('Bea'))
    expect(created).toMatchObject({ name: 'Bea', teamId: 'T' })
    expect(roomPatch).toBeNull()
  })

  it('says so, naming the room, when the agent could not join it', async () => {
    server.use(
      http.patch('/api/teams/T/rooms/R1', () =>
        HttpResponse.json({ error: 'room not found' }, { status: 404 }),
      ),
    )
    const { result } = setup('R1')
    await act(() => result.current.createAgent('Bea'))
    expect(created).toMatchObject({ name: 'Bea', teamId: 'T' })
    expect(useToastStore.getState().toasts.map((t) => t.message)).toContain(
      'Bea was created but could not join Design: room not found',
    )
    expect(useRoomStore.getState().roomsByTeam.get('T')?.[0]?.memberIds).toEqual(['a1'])
  })
})

describe('joinRoom', () => {
  it('sends joins to one room one at a time, so an older response never lands last', async () => {
    const sent: string[] = []
    let markFirstSeen!: () => void
    const firstSeen = new Promise<void>((resolve) => (markFirstSeen = resolve))
    let releaseFirst!: () => void
    const firstHeld = new Promise<void>((resolve) => (releaseFirst = resolve))
    server.use(
      http.patch('/api/teams/T/rooms/R1', async ({ request }) => {
        const agentId = ((await request.json()) as { addMemberIds: string[] }).addMemberIds[0]
        sent.push(agentId ?? '')
        // Hold the first join's response, as a slow network would.
        if (agentId === 'a2') {
          markFirstSeen()
          await firstHeld
        }
        const memberIds = agentId === 'a2' ? ['a1', 'a2'] : ['a1', 'a2', 'a3']
        return HttpResponse.json({ room: { ...ROOM, memberIds } })
      }),
    )

    const first = joinRoom('T', 'R1', { agentId: 'a2', name: 'Bea' })
    const second = joinRoom('T', 'R1', { agentId: 'a3', name: 'Cy' })
    await firstSeen
    // Leave a second request time to go out, as it would if joins were not
    // chained. The second join waits for the first: only one request is out.
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(sent).toEqual(['a2'])

    releaseFirst()
    await Promise.all([first, second])
    expect(sent).toEqual(['a2', 'a3'])
    expect(useRoomStore.getState().roomsByTeam.get('T')?.[0]?.memberIds).toEqual(['a1', 'a2', 'a3'])
  })
})
