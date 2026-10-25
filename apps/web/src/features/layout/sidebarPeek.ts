// The collapsed sidebar's hover peek. Collapsed, the sidebar leaves nothing on
// screen; the expand toggle sits at the start of the current view's header.
// Hovering that toggle lays the sidebar over the content (the peek) and leaving
// it hides the sidebar again. The toggle lives in whichever header is showing,
// so the peek state is shared here rather than held by the sidebar.

import type React from 'react'
import { create } from 'zustand'
import { hasOpenLayer } from '@/features/shared/useDismissableLayer'

/** Where the hovered toggle sits, so the peek's own toggle lands right on it. */
export interface PeekAnchor {
  left: number
  top: number
}

interface PeekState {
  peek: boolean
  anchor: PeekAnchor | null
}

export const useSidebarPeek = create<PeekState>(() => ({ peek: false, anchor: null }))

const HIDE_DELAY_MS = 220
const RECHECK_MS = 300

let hideTimer: ReturnType<typeof setTimeout> | null = null
// Where the pointer last was. The panel slides in under a pointer that may not
// move again, so its own mouseenter can't be trusted to fire; the hide check
// reads the position instead.
let pointer: { x: number; y: number } | null = null
let panel: HTMLElement | null = null

export function setPeekPanel(el: HTMLElement | null): void {
  panel = el
}

export function notePointer(p: { x: number; y: number } | null): void {
  pointer = p
}

function pointerOverPanel(): boolean {
  const r = panel?.getBoundingClientRect()
  return (
    !!pointer &&
    !!r &&
    pointer.x >= r.left &&
    pointer.x <= r.right &&
    pointer.y >= r.top &&
    pointer.y <= r.bottom
  )
}

export function clearPeekHide(): void {
  if (hideTimer != null) {
    clearTimeout(hideTimer)
    hideTimer = null
  }
}

export function openPeek(e: React.MouseEvent<HTMLElement>): void {
  pointer = { x: e.clientX, y: e.clientY }
  const r = e.currentTarget.getBoundingClientRect()
  clearPeekHide()
  useSidebarPeek.setState({ peek: true, anchor: { left: r.left, top: r.top } })
}

export function schedulePeekHide(): void {
  clearPeekHide()
  const tick = (): void => {
    // Stay up while the pointer is back over the panel, or while something
    // opened from it (a menu, a modal) is still open: hiding would leave that
    // layer orphaned or unclickable.
    if (pointerOverPanel() || hasOpenLayer()) {
      hideTimer = setTimeout(tick, RECHECK_MS)
      return
    }
    hideTimer = null
    useSidebarPeek.setState({ peek: false })
  }
  hideTimer = setTimeout(tick, HIDE_DELAY_MS)
}

export function closePeek(): void {
  clearPeekHide()
  useSidebarPeek.setState({ peek: false })
}
