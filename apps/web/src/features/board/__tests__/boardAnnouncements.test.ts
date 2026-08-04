// The board's drag-and-drop announcements. Before these, dnd-kit's defaults read
// raw ids at a screen-reader user ("Picked up draggable item 9f3c8a1e-…",
// "…moved over droppable area in_progress"). Pure by construction, so the whole
// contract is asserted here with no DOM and no drag simulation.

import { describe, expect, it } from 'vitest'

import { boardAnnouncements as a, columnLabel } from '../boardAnnouncements'

/** A dnd-kit `active` carrying the payload DraggableCard attaches. Pass
 *  `title: null` to simulate a payload that never got one. */
function active(fromStatus: string, title: string | null = 'Ship it') {
  return {
    id: 't1',
    data: { current: { fromStatus, ...(title !== null && { title }) } },
  } as never
}

const over = (id: string) => ({ id }) as never

describe('columnLabel', () => {
  it('maps every canonical status to its human label', () => {
    expect(columnLabel('backlog')).toBe('Backlog')
    expect(columnLabel('todo')).toBe('To do')
    expect(columnLabel('in_progress')).toBe('In progress')
    expect(columnLabel('in_review')).toBe('In review')
    expect(columnLabel('blocked')).toBe('Blocked')
    expect(columnLabel('done')).toBe('Done')
    expect(columnLabel('cancelled')).toBe('Cancelled')
  })

  // The regression this module exists to prevent: `statusLabel` passes an
  // off-list id straight through, so the catch-all column would be spoken as
  // the literal sentinel "__other__".
  it('speaks the catch-all column as "Other", never the raw sentinel', () => {
    expect(columnLabel('__other__')).toBe('Other')
  })

  it('degrades gracefully for an empty or unknown id', () => {
    expect(columnLabel('')).toBe('its column')
    expect(columnLabel('archived')).toBe('archived')
  })
})

describe('onDragStart', () => {
  it('names the task and the column it came from', () => {
    expect(a.onDragStart({ active: active('in_progress') })).toBe(
      'Picked up “Ship it” from In progress.',
    )
  })

  it('falls back when the payload has no title', () => {
    expect(a.onDragStart({ active: active('todo', null) })).toBe(
      'Picked up “this task” from To do.',
    )
  })
})

describe('onDragOver', () => {
  it('offers the move over a legal target', () => {
    expect(a.onDragOver({ active: active('in_progress'), over: over('done') })).toBe(
      'Over Done. Release to move “Ship it” from In progress to Done.',
    )
  })

  it('says the card is already there when hovering its own column', () => {
    expect(a.onDragOver({ active: active('todo'), over: over('todo') })).toBe(
      'Over To do, where “Ship it” already is.',
    )
  })

  // Illegal columns are disabled droppables mid-drag, so they report no hit at
  // all — one sentence has to cover both that and true dead space, which is why
  // it names the consequence rather than guessing the cause.
  it('covers dead space and disabled columns with one honest sentence', () => {
    expect(a.onDragOver({ active: active('in_review'), over: null })).toBe(
      '“Ship it” is not over a column that can accept it. Release to leave it in In review.',
    )
  })

  it('says so when a raced hover lands on an illegal target', () => {
    expect(a.onDragOver({ active: active('backlog'), over: over('done') })).toBe(
      'Over Done. It can’t accept “Ship it”.',
    )
  })

  it('speaks "Other" for the catch-all column', () => {
    expect(a.onDragOver({ active: active('backlog'), over: over('__other__') })).toContain('Other')
    expect(a.onDragOver({ active: active('backlog'), over: over('__other__') })).not.toContain(
      '__other__',
    )
  })
})

describe('onDragEnd', () => {
  it('announces the SAVE, not the outcome, for a legal move', () => {
    const said = a.onDragEnd({ active: active('in_progress'), over: over('done') })
    expect(said).toBe('Dropped “Ship it” on Done. Saving the move from In progress to Done.')
    // The mutation still runs its confirm gates ("Complete anyway?") and can roll
    // back, so claiming the task MOVED here would be a lie. The real outcome
    // arrives on the toast, which is itself in a live region.
    expect(said).not.toMatch(/\bmoved\b/i)
  })

  it('reports a no-op drop back onto the same column', () => {
    expect(a.onDragEnd({ active: active('todo'), over: over('todo') })).toBe(
      'Dropped “Ship it” back in To do. Nothing changed.',
    )
  })

  it('reports a drop outside the columns', () => {
    expect(a.onDragEnd({ active: active('blocked'), over: null })).toBe(
      'Dropped “Ship it” outside the columns. It stays in Blocked.',
    )
  })

  it('reports a drop on a column that cannot accept the card', () => {
    expect(a.onDragEnd({ active: active('backlog'), over: over('done') })).toBe(
      'Dropped “Ship it” on Done, which can’t accept it. It stays in Backlog.',
    )
  })

  it('never leaks a task id or a raw status id', () => {
    const said = a.onDragEnd({ active: active('in_progress'), over: over('in_review') })
    expect(said).not.toMatch(/t1|in_progress|in_review/)
  })
})

describe('onDragCancel', () => {
  it('confirms where the card stayed', () => {
    expect(a.onDragCancel({ active: active('in_review'), over: null })).toBe(
      'Cancelled. “Ship it” stays in In review.',
    )
  })

  it('degrades when the payload is missing entirely', () => {
    const bare = { id: 't1', data: { current: undefined } } as never
    expect(a.onDragCancel({ active: bare, over: null })).toBe(
      'Cancelled. “this task” stays in its column.',
    )
  })
})
