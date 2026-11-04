// The phone layout: the dashboard at a phone's width, about 360 to 430 px.
//
// Below Tailwind's `sm` breakpoint the sidebar stops docking beside the content
// and opens as a drawer over it instead (see AppSidebar), and the screens a
// person uses away from the desk take the whole width: the board with Needs you
// and its approvals, and chat. `max-sm:` utilities and this query draw the same
// line, so the stylesheet and the code never disagree about which layout shows.

import { useSyncExternalStore } from 'react'
import { create } from 'zustand'

/** Narrower than this is a phone. Tailwind's `sm` starts here, so `max-sm:` agrees. */
export const PHONE_MAX_WIDTH = 640

/** Just under the breakpoint, so a fractional width (a zoomed page) still lands
 *  on one side of it, the side `max-sm:` puts it on. */
export const PHONE_LAYOUT_QUERY = `(max-width: ${PHONE_MAX_WIDTH - 0.02}px)`

function phoneQuery(): MediaQueryList | null {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return null
  return window.matchMedia(PHONE_LAYOUT_QUERY)
}

/** True while the window is phone width. For event handlers; render with the hook. */
export function isPhoneLayout(): boolean {
  return phoneQuery()?.matches ?? false
}

function subscribe(onChange: () => void): () => void {
  const query = phoneQuery()
  if (!query) return () => {}
  query.addEventListener('change', onChange)
  return () => query.removeEventListener('change', onChange)
}

/** True while the window is phone width; re-renders when it crosses the line. */
export function usePhoneLayout(): boolean {
  return useSyncExternalStore(subscribe, isPhoneLayout, () => false)
}

// ─── The sidebar drawer ──────────────────────────────────────────────────────
//
// Its own state, apart from the docked sidebar's collapsed preference: opening
// the drawer on a phone must not collapse or expand the sidebar the next time
// the same browser is wide.

interface PhoneNavState {
  open: boolean
}

export const usePhoneNav = create<PhoneNavState>(() => ({ open: false }))

export function openPhoneNav(): void {
  usePhoneNav.setState({ open: true })
}

export function closePhoneNav(): void {
  usePhoneNav.setState({ open: false })
}

export function togglePhoneNav(): void {
  usePhoneNav.setState((s) => ({ open: !s.open }))
}
