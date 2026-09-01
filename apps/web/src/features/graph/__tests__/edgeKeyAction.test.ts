// Backspace removes the SELECTED EDGE, and can never reach a node.
//
// React Flow's own `deleteKeyCode` stays null on purpose: its Backspace path
// runs through `applyNodeChanges` and splices an agent out of the local store
// with no confirmation and no server call, so the agent is untouched and
// silently returns on reload. This is the separate, edge-only path.

import { describe, expect, it } from 'vitest'

import { edgeKeyAction, isTypingTarget, readKeyEvent } from '../graphKeyAction'
import type { GraphKeyEvent } from '../graphKeyAction'

const key = (k: string, over: Partial<Record<string, boolean>> = {}) => ({
  key: k,
  altKey: false,
  shiftKey: false,
  ctrlKey: false,
  metaKey: false,
  typing: false,
  ...over,
})

describe('edgeKeyAction', () => {
  it('removes on Backspace and Delete', () => {
    expect(edgeKeyAction(key('Backspace'))).toBe('remove')
    expect(edgeKeyAction(key('Delete'))).toBe('remove')
  })

  it('does NOTHING while the user is typing', () => {
    // Without this a canvas-level listener eats the last character of every
    // search box and rename field on the surface.
    expect(edgeKeyAction(key('Backspace', { typing: true }))).toBeNull()
  })

  it('ignores modified keystrokes, which belong to the browser', () => {
    for (const mod of ['altKey', 'ctrlKey', 'metaKey', 'shiftKey']) {
      expect(edgeKeyAction(key('Backspace', { [mod]: true }))).toBeNull()
    }
  })

  it('ignores every other key', () => {
    for (const k of ['Enter', 'Escape', 'a', 'ArrowLeft', ' ']) {
      expect(edgeKeyAction(key(k))).toBeNull()
    }
  })
})

describe('isTypingTarget', () => {
  it('recognises the fields a canvas key listener must not steal from', () => {
    for (const tag of ['input', 'textarea', 'select']) {
      expect(isTypingTarget({ tagName: tag.toUpperCase() } as unknown as EventTarget)).toBe(true)
    }
    expect(
      isTypingTarget({ tagName: 'DIV', isContentEditable: true } as unknown as EventTarget),
    ).toBe(true)
  })

  it('lets an ordinary element through', () => {
    expect(isTypingTarget({ tagName: 'DIV' } as unknown as EventTarget)).toBe(false)
    expect(isTypingTarget(null)).toBe(false)
  })
})

// A native KeyboardEvent keeps `key` and the modifier flags on its prototype,
// so an object literal is the one shape that cannot reproduce how this is
// called. `Object.create` puts the fields exactly where the browser puts them.
function nativeShapedEvent(fields: Record<string, unknown>): GraphKeyEvent {
  return Object.create(fields) as GraphKeyEvent
}

describe('readKeyEvent', () => {
  const backspace = {
    key: 'Backspace',
    altKey: false,
    shiftKey: false,
    ctrlKey: false,
    metaKey: false,
  }

  it('spreading a prototype-backed event loses every field', () => {
    // Locks in the reason this helper exists rather than the helper itself.
    expect({ ...nativeShapedEvent(backspace) }).toEqual({})
  })

  it('reads fields a spread would drop', () => {
    expect(readKeyEvent(nativeShapedEvent(backspace))).toEqual(backspace)
  })

  it('removes on a prototype-backed Backspace', () => {
    const e = nativeShapedEvent(backspace)
    expect(edgeKeyAction({ ...readKeyEvent(e), typing: false })).toBe('remove')
  })

  it('still refuses a prototype-backed modified Backspace', () => {
    const e = nativeShapedEvent({ ...backspace, metaKey: true })
    expect(edgeKeyAction({ ...readKeyEvent(e), typing: false })).toBeNull()
  })
})
