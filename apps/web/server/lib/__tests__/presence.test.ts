// The presence record: only a visible, focused tab's beat or a reported action
// makes a person present, for PRESENCE_TTL_MS; a hidden or unfocused tab never does.

import { describe, expect, it } from 'vitest'

import { PRESENCE_MAX_TABS, PRESENCE_TTL_MS, createPresence } from '../presence'

function clock(start = 1_000_000) {
  let t = start
  return { now: () => t, advance: (ms: number) => (t += ms) }
}

describe('presence', () => {
  it('has seen nobody before any beat', () => {
    const p = createPresence(clock())
    expect(p.state()).toEqual({
      present: false,
      lastSeenAt: null,
      lastActedAt: null,
      focusedTabs: 0,
    })
  })

  it('a visible, focused tab makes a person present until its beat is PRESENCE_TTL_MS old', () => {
    const c = clock()
    const p = createPresence(c)
    p.beat('tab-a', { visible: true, focused: true })
    expect(p.state()).toMatchObject({ present: true, focusedTabs: 1, lastSeenAt: 1_000_000 })
    c.advance(PRESENCE_TTL_MS - 1)
    expect(p.state().present).toBe(true)
    c.advance(1)
    expect(p.state()).toMatchObject({ present: false, focusedTabs: 0, lastSeenAt: 1_000_000 })
  })

  it('a hidden tab, or a visible one without focus, never counts', () => {
    const p = createPresence(clock())
    p.beat('hidden', { visible: false, focused: false })
    p.beat('hidden-but-focused', { visible: false, focused: true })
    p.beat('background-window', { visible: true, focused: false })
    expect(p.state()).toEqual({
      present: false,
      lastSeenAt: null,
      lastActedAt: null,
      focusedTabs: 0,
    })
  })

  it('the tab losing focus ends its presence at once, not after the TTL', () => {
    const c = clock()
    const p = createPresence(c)
    p.beat('tab-a', { visible: true, focused: true })
    c.advance(5_000)
    p.beat('tab-a', { visible: false, focused: false })
    expect(p.state()).toMatchObject({ present: false, focusedTabs: 0, lastSeenAt: 1_000_000 })
  })

  it('an action keeps a person present for PRESENCE_TTL_MS after the tab goes away', () => {
    const c = clock()
    const p = createPresence(c)
    p.beat('tab-a', { visible: true, focused: true, acted: true })
    c.advance(1_000)
    p.beat('tab-a', { visible: false, focused: false })
    expect(p.state()).toMatchObject({ present: true, focusedTabs: 0, lastActedAt: 1_000_000 })
    c.advance(PRESENCE_TTL_MS - 1_000)
    expect(p.state().present).toBe(false)
  })

  it('lastSeenAt is the later of the last focused beat and the last action', () => {
    const c = clock()
    const p = createPresence(c)
    p.beat('phone', { visible: true, focused: true, acted: true })
    c.advance(10_000)
    p.beat('tab-a', { visible: true, focused: true })
    expect(p.state()).toMatchObject({ lastSeenAt: 1_010_000, lastActedAt: 1_000_000 })
  })

  it('counts each focused tab once, however often it beats', () => {
    const c = clock()
    const p = createPresence(c)
    for (let i = 0; i < 5; i++) {
      p.beat('tab-a', { visible: true, focused: true })
      c.advance(1_000)
    }
    p.beat('tab-b', { visible: true, focused: true })
    expect(p.state().focusedTabs).toBe(2)
  })

  it('a wall clock set back does not stretch the window', () => {
    let wall = 10_000_000
    let mono = 0
    const p = createPresence({ now: () => wall, monotonic: () => mono })
    p.beat('tab-a', { visible: true, focused: true, acted: true })
    p.beat('tab-a', { visible: false, focused: false })
    wall -= 3_600_000 // the clock is stepped back an hour
    mono += PRESENCE_TTL_MS
    expect(p.state()).toMatchObject({ present: false, lastActedAt: 10_000_000 })
  })

  it('counts an action the server saw itself', () => {
    const c = clock()
    const p = createPresence(c)
    p.acted()
    expect(p.state()).toMatchObject({ present: true, focusedTabs: 0, lastActedAt: 1_000_000 })
    c.advance(PRESENCE_TTL_MS)
    expect(p.state().present).toBe(false)
  })

  it('remembers at most PRESENCE_MAX_TABS tabs, dropping the stalest', () => {
    const c = clock()
    const p = createPresence(c)
    p.beat('first', { visible: true, focused: true })
    for (let i = 0; i < PRESENCE_MAX_TABS; i++) {
      c.advance(1)
      p.beat(`tab-${i}`, { visible: true, focused: false })
    }
    // `first` was the stalest and went, so no focused tab is left.
    expect(p.state().focusedTabs).toBe(0)
  })
})
