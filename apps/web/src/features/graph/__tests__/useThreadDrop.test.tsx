// useThreadDrop: the thread picker shared by the Ghost Graph and the agent
// view's mini graph. A Boo's thread let go on empty space opens the picker where
// it fell; a tile's thread has nothing it can become, so it opens nothing. A new
// agent made from a thread joins the source's team, and on a room's graph the
// room as well.

import { act, renderHook } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { beforeEach, describe, expect, it } from 'vitest'

import { server } from '@/__vitest__/mswServer'
import type { Room } from '@/lib/roomsClient'
import { useRoomStore } from '@/stores/rooms'

import type { GraphNode } from '../types'
import { useThreadDrop } from '../useThreadDrop'

const boo = {
  id: 'boo-a1',
  type: 'boo',
  position: { x: 0, y: 0 },
  data: { agentId: 'a1', name: 'Scout', status: 'idle' },
} as unknown as GraphNode

function setup() {
  return renderHook(() =>
    useThreadDrop({
      nodes: [boo],
      getNode: (id) => (id === boo.id ? boo : undefined),
      // Any mapping will do; the hook must carry the flow point through.
      screenToFlowPosition: (p) => ({ x: p.x / 2, y: p.y / 2 }),
      fallbackTeamId: null,
    }),
  )
}

beforeEach(() => {
  server.use(
    http.get('/api/connectors', () => HttpResponse.json({ connectors: [] })),
    http.get('/api/connectors/configured', () => HttpResponse.json({ slugs: [], supplied: [] })),
    http.get('/api/connectors/composio', () => HttpResponse.json({ connected: [] })),
  )
})

describe('useThreadDrop', () => {
  it('opens the picker where a Boo thread fell, in screen AND flow coordinates', () => {
    const { result } = setup()
    act(() =>
      result.current.openFromDrop(new MouseEvent('mouseup', { clientX: 120, clientY: 40 }), {
        id: 'boo-a1',
        type: 'boo',
      }),
    )

    expect(result.current.threadDrop).toEqual({
      screen: { x: 120, y: 40 },
      flow: { x: 60, y: 20 },
      fromNodeId: 'boo-a1',
      fromNodeType: 'boo',
    })
    // Skills and connectors to give the agent.
    expect(result.current.threadOptions.length).toBeGreaterThan(0)

    act(() => result.current.close())
    expect(result.current.threadDrop).toBeNull()
  })

  it('offers nothing for a thread pulled off a skill tile', () => {
    const { result } = setup()
    act(() =>
      result.current.openFromDrop(new MouseEvent('mouseup', { clientX: 10, clientY: 10 }), {
        id: 'skill-a1-echo',
        type: 'skill',
      }),
    )
    expect(result.current.threadOptions).toEqual([])
  })
})

describe('New agent from a thread', () => {
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
  let routed: string | null = null

  beforeEach(() => {
    created = null
    roomPatch = null
    routed = null
    useRoomStore.setState({ roomsByTeam: new Map([['T', [ROOM]]]), loadedTeams: new Set(['T']) })
    server.use(
      http.post('/api/agents', async ({ request }) => {
        created = await request.json()
        return HttpResponse.json({ agent: { id: 'a2' } }, { status: 201 })
      }),
      http.patch('/api/teams/T/rooms/R1', async ({ request }) => {
        roomPatch = await request.json()
        return HttpResponse.json({ room: { ...ROOM, memberIds: ['a1', 'a2'] } })
      }),
      http.get('/api/agents/:id/files/:name', () =>
        HttpResponse.json({ name: 'AGENTS.md', content: '# AGENTS\n' }),
      ),
      http.put('/api/agents/:id/files/:name', async ({ request }) => {
        routed = ((await request.json()) as { content: string }).content
        return HttpResponse.json({ name: 'AGENTS.md', content: routed })
      }),
    )
  })

  /** Pull a thread off `source` and let it go on empty canvas. */
  function drop(source: GraphNode, opts: { fallbackTeamId: string | null; roomId: string | null }) {
    const { result } = renderHook(() =>
      useThreadDrop({
        nodes: [source],
        getNode: (id) => (id === source.id ? source : undefined),
        screenToFlowPosition: (p) => p,
        ...opts,
      }),
    )
    act(() =>
      result.current.openFromDrop(new MouseEvent('mouseup', { clientX: 300, clientY: 200 }), {
        id: source.id,
        type: 'boo',
      }),
    )
    return result
  }

  /** Pull a thread off `source`, let it go on empty canvas, and name the agent. */
  async function dropAndCreate(
    source: GraphNode,
    opts: { fallbackTeamId: string | null; roomId: string | null },
  ) {
    const result = drop(source, opts)
    await act(() => result.current.createAgent('Bea'))
  }

  const teamBoo = {
    ...boo,
    data: { ...(boo.data as object), teamId: 'T' },
  } as unknown as GraphNode

  it("on a room's graph, joins the room as well as the source's team", async () => {
    await dropAndCreate(teamBoo, { fallbackTeamId: 'T', roomId: 'R1' })
    expect(created).toMatchObject({ name: 'Bea', teamId: 'T' })
    expect(roomPatch).toEqual({ addMemberIds: ['a2'] })
    expect(useRoomStore.getState().roomsByTeam.get('T')?.[0]?.memberIds).toEqual(['a1', 'a2'])
    // The thread's routing line still lands on the source agent.
    expect(routed).toContain('Bea')
  })

  it("on the team's own graph, joins the team and no room", async () => {
    await dropAndCreate(teamBoo, { fallbackTeamId: 'T', roomId: null })
    expect(created).toMatchObject({ name: 'Bea', teamId: 'T' })
    expect(roomPatch).toBeNull()
  })

  const booZero = {
    id: 'boo-bz',
    type: 'boo',
    position: { x: 0, y: 0 },
    data: { agentId: 'bz', name: 'Boo Zero', status: 'idle', teamId: null },
  } as unknown as GraphNode

  it('a thread off teamless Boo Zero on a room graph lands the agent in the room', async () => {
    await dropAndCreate(booZero, { fallbackTeamId: 'T', roomId: 'R1' })
    expect(created).toMatchObject({ name: 'Bea', teamId: 'T' })
    expect(roomPatch).toEqual({ addMemberIds: ['a2'] })
  })

  // The Org chart passes a fallback too, and the source's own team still wins
  // over it: a thread off a Boo in team S makes an agent in S.
  it("names the source's own team ahead of the fallback, and creates it there", async () => {
    const otherTeamBoo = {
      ...boo,
      data: { ...(boo.data as object), teamId: 'S' },
    } as unknown as GraphNode
    const result = drop(otherTeamBoo, { fallbackTeamId: 'T', roomId: null })
    expect(result.current.newAgentTeamId).toBe('S')
    await act(() => result.current.createAgent('Bea'))
    expect(created).toMatchObject({ name: 'Bea', teamId: 'S' })
  })

  it('names the fallback team for a thread off teamless Boo Zero, and none once closed', () => {
    const result = drop(booZero, { fallbackTeamId: 'T', roomId: null })
    expect(result.current.newAgentTeamId).toBe('T')
    act(() => result.current.close())
    expect(result.current.newAgentTeamId).toBeNull()
  })
})
