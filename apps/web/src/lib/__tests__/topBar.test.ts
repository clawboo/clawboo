import { describe, expect, it } from 'vitest'

import { NAV_VIEWS } from '@/stores/view'

import { NAV_WITH_INLINE_STAR, shouldShowGlobalTopBar } from '../topBar'

// Guards the double-Star regression: new dashboard tabs (board/runtimes/memory/
// governance/obs) each host the GitHub Star pill inline, so the global AppTopBar
// must NOT also render for them (else two Star buttons). The rule is "AppTopBar
// shows only for `welcome`"; every other view hosts the Star inline.

describe('shouldShowGlobalTopBar', () => {
  it('shows the global AppTopBar ONLY for the welcome view', () => {
    expect(shouldShowGlobalTopBar({ type: 'welcome' })).toBe(true)
  })

  it('hides it for agent / booZero / groupChat (they host the Star inline)', () => {
    expect(shouldShowGlobalTopBar({ type: 'agent', agentId: 'a1' })).toBe(false)
    expect(shouldShowGlobalTopBar({ type: 'booZero' })).toBe(false)
    expect(shouldShowGlobalTopBar({ type: 'groupChat', teamId: 't1' })).toBe(false)
  })

  it('hides it for EVERY nav view — each dashboard hosts its own inline Star (no duplicate)', () => {
    for (const view of NAV_VIEWS) {
      expect(shouldShowGlobalTopBar({ type: 'nav', view })).toBe(false)
    }
  })

  it('the inline-star set covers every nav view (so a new tab can never be left out)', () => {
    expect(NAV_WITH_INLINE_STAR.size).toBe(NAV_VIEWS.length)
    for (const view of NAV_VIEWS) expect(NAV_WITH_INLINE_STAR.has(view)).toBe(true)
  })
})
