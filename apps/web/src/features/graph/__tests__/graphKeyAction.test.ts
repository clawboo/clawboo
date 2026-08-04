// The graph's keyboard shortcut matrix. Pure so it can be pinned here; the
// handler that consumes it lives on the GhostGraph wrapper, which no test
// renders (React Flow is never mounted in this suite).

import { describe, expect, it } from 'vitest'

import { graphKeyAction, type GraphKeyEvent } from '../graphKeyAction'

const key = (k: string, mods: Partial<GraphKeyEvent> = {}): GraphKeyEvent => ({
  key: k,
  altKey: false,
  shiftKey: false,
  ctrlKey: false,
  metaKey: false,
  ...mods,
})

describe('graphKeyAction', () => {
  it('opens the context menu on the standard APG keys', () => {
    expect(graphKeyAction(key('ContextMenu'))).toBe('context-menu')
    expect(graphKeyAction(key('F10', { shiftKey: true }))).toBe('context-menu')
  })

  // macOS keyboards have no Menu key and the OS swallows Shift+F10, so the
  // Alt+Enter alias is the only reachable shortcut there.
  it('offers Alt+Enter as the macOS-reachable alias', () => {
    expect(graphKeyAction(key('Enter', { altKey: true }))).toBe('context-menu')
  })

  it('activates on plain Enter or Space', () => {
    expect(graphKeyAction(key('Enter'))).toBe('activate')
    expect(graphKeyAction(key(' '))).toBe('activate')
  })

  it('ignores modified variants that mean something else', () => {
    expect(graphKeyAction(key('F10'))).toBeNull()
    expect(graphKeyAction(key('Enter', { ctrlKey: true }))).toBeNull()
    expect(graphKeyAction(key('Enter', { metaKey: true }))).toBeNull()
    expect(graphKeyAction(key(' ', { metaKey: true }))).toBeNull()
    expect(graphKeyAction(key('F10', { shiftKey: true, metaKey: true }))).toBeNull()
  })

  // Arrow keys belong to React Flow's own node-move handler; claiming them here
  // would break moving a selected node.
  it('leaves arrows and ordinary typing to React Flow', () => {
    expect(graphKeyAction(key('ArrowDown'))).toBeNull()
    expect(graphKeyAction(key('ArrowUp'))).toBeNull()
    expect(graphKeyAction(key('a'))).toBeNull()
    expect(graphKeyAction(key('Escape'))).toBeNull()
  })
})
