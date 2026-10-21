// Which column a drop goes to. dnd-kit passes collision detection only the
// columns that would take the card (a refused column is disabled and left out),
// so these tests hand it exactly that: the enabled columns, their rects, the
// lifted card's rect and the pointer.

import type { ClientRect, CollisionDescriptor, DroppableContainer } from '@dnd-kit/core'
import { describe, expect, it } from 'vitest'

import { boardCollision } from '../boardCollision'

const TOP = 100
const HEIGHT = 600

function rect(left: number, width: number): ClientRect {
  return { left, top: TOP, width, height: HEIGHT, right: left + width, bottom: TOP + HEIGHT }
}

// Needs you 376-624, Backlog 624-808, To do 808-1008, In progress 1008-1192,
// Done 1192-1376, Cancelled 1376-1416 (folded strip).
const COLUMNS: Record<string, ClientRect> = {
  backlog: rect(624, 184),
  todo: rect(808, 200),
  in_progress: rect(1008, 184),
  done: rect(1192, 184),
  cancelled: rect(1376, 40),
}

function args(
  enabled: string[],
  lifted: ClientRect,
  pointer: { x: number; y: number } | null,
): Parameters<typeof boardCollision>[0] {
  const droppableRects = new Map(enabled.map((id) => [id, COLUMNS[id]!]))
  const droppableContainers = enabled.map(
    (id) => ({ id, rect: { current: COLUMNS[id]! }, disabled: false }) as DroppableContainer,
  )
  return {
    active: { id: 'card' } as Parameters<typeof boardCollision>[0]['active'],
    collisionRect: lifted,
    droppableRects,
    droppableContainers,
    pointerCoordinates: pointer,
  }
}

const ids = (hits: CollisionDescriptor[] | ReturnType<typeof boardCollision>) =>
  hits.map((h) => String(h.id))

describe('boardCollision', () => {
  it('drops on the column under the pointer', () => {
    const lifted = { ...rect(1100, 180), top: 300, bottom: 360, height: 60 }
    expect(
      ids(boardCollision(args(['backlog', 'in_progress', 'done'], lifted, { x: 1250, y: 330 }))),
    ).toEqual(['done'])
  })

  it('finds nothing over a refused column, even when the lifted card overlaps a neighbour', () => {
    // A To do card: Done refuses it, so dnd-kit leaves Done out. The pointer is
    // just inside Done; the card hangs back over In progress.
    const lifted = { ...rect(1131, 183), top: 300, bottom: 360, height: 60 }
    const hits = boardCollision(
      args(['backlog', 'in_progress', 'cancelled'], lifted, { x: 1222, y: 330 }),
    )
    expect(hits).toEqual([])
  })

  it('finds nothing over Needs you, which never takes a card', () => {
    const lifted = { ...rect(520, 184), top: 300, bottom: 360, height: 60 }
    const hits = boardCollision(
      args(['backlog', 'in_progress', 'cancelled'], lifted, { x: 610, y: 330 }),
    )
    expect(hits).toEqual([])
  })

  it('does not slip a card into the folded Cancelled strip from beside it', () => {
    // A Backlog card over Done (refused) whose right edge overlaps the strip.
    const lifted = { ...rect(1300, 184), top: 300, bottom: 360, height: 60 }
    const hits = boardCollision(args(['todo', 'cancelled'], lifted, { x: 1330, y: 330 }))
    expect(hits).toEqual([])
  })

  it('finds nothing in the day gutter or past the last column', () => {
    const lifted = { ...rect(1380, 184), top: 300, bottom: 360, height: 60 }
    expect(boardCollision(args(['cancelled'], lifted, { x: 1500, y: 330 }))).toEqual([])
  })

  it('matches a keyboard drag, which has no pointer, by the card’s overlap', () => {
    const lifted = { ...rect(1010, 180), top: 300, bottom: 360, height: 60 }
    expect(ids(boardCollision(args(['backlog', 'in_progress', 'done'], lifted, null)))[0]).toBe(
      'in_progress',
    )
  })
})
