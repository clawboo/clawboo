// useThreadDrop: the thread picker shared by the Ghost Graph and the agent
// view's mini graph. A Boo's thread let go on empty space opens the picker where
// it fell; a tile's thread has nothing it can become, so it opens nothing.

import { act, renderHook } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { beforeEach, describe, expect, it } from 'vitest'

import { server } from '@/__vitest__/mswServer'

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
