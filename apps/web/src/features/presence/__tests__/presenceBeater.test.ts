// The dashboard's presence beat: a tab beats only while visible, focused and
// touched recently; a hidden or background tab sends nothing, and leaving says so once.

import { describe, expect, it } from 'vitest'

import {
  GLANCE_MS,
  INPUT_IDLE_MS,
  createPresenceBeater,
  type PresenceBeatBody,
} from '../presenceBeater'

function setup(start: { visible: boolean; focused: boolean }) {
  let t = 1_000_000
  const page = { ...start }
  const sent: PresenceBeatBody[] = []
  const beater = createPresenceBeater({
    tabId: 'tab-1',
    send: (body) => sent.push(body),
    now: () => t,
    isVisible: () => page.visible,
    hasFocus: () => page.focused,
  })
  return { beater, sent, page, advance: (ms: number) => (t += ms) }
}

describe('presence beat', () => {
  it('a hidden tab never sends anything, however long it runs', () => {
    const { beater, sent } = setup({ visible: false, focused: false })
    beater.changed()
    for (let i = 0; i < 50; i++) beater.tick()
    expect(sent).toEqual([])
  })

  it('a visible tab without focus (a window in the background) sends nothing', () => {
    const { beater, sent } = setup({ visible: true, focused: false })
    beater.changed()
    beater.tick()
    beater.input()
    expect(sent).toEqual([])
  })

  it('a visible, focused tab beats on load and on every tick', () => {
    const { beater, sent } = setup({ visible: true, focused: true })
    beater.changed()
    beater.tick()
    beater.tick()
    expect(sent).toEqual([
      { tabId: 'tab-1', visible: true, focused: true },
      { tabId: 'tab-1', visible: true, focused: true },
      { tabId: 'tab-1', visible: true, focused: true },
    ])
  })

  it('says once that the tab was hidden, then goes quiet', () => {
    const { beater, sent, page } = setup({ visible: true, focused: true })
    beater.changed()
    page.visible = false
    beater.changed()
    beater.tick()
    beater.tick()
    expect(sent.map((b) => b.focused)).toEqual([true, false])
    expect(sent[1]).toEqual({ tabId: 'tab-1', visible: false, focused: false })
  })

  it('carries an action on the next beat, once', () => {
    const { beater, sent } = setup({ visible: true, focused: true })
    beater.changed()
    beater.input()
    beater.input()
    beater.tick()
    beater.tick()
    expect(sent.map((b) => b.acted ?? false)).toEqual([false, true, false])
  })

  it('stops counting a focused tab nobody has touched for INPUT_IDLE_MS, and is back on the next input', () => {
    const { beater, sent, advance } = setup({ visible: true, focused: true })
    beater.changed()
    advance(INPUT_IDLE_MS)
    beater.tick()
    beater.tick()
    expect(sent.map((b) => b.focused)).toEqual([true, false])
    beater.input()
    expect(sent.at(-1)).toEqual({ tabId: 'tab-1', visible: true, focused: true, acted: true })
  })

  it('a page load nobody touches counts only for GLANCE_MS', () => {
    const { beater, sent, advance } = setup({ visible: true, focused: true })
    beater.changed()
    advance(GLANCE_MS - 1)
    beater.tick()
    advance(1)
    beater.tick()
    expect(sent.map((b) => b.focused)).toEqual([true, true, false])
  })

  it('input after a load keeps the tab counting for INPUT_IDLE_MS', () => {
    const { beater, sent, advance } = setup({ visible: true, focused: true })
    beater.changed()
    beater.input()
    advance(INPUT_IDLE_MS - 1)
    beater.tick()
    expect(sent.at(-1)).toMatchObject({ focused: true })
  })

  it('switching back without touching anything counts only for GLANCE_MS', () => {
    const { beater, sent, page, advance } = setup({ visible: true, focused: true })
    beater.changed()
    page.focused = false
    beater.changed()
    advance(INPUT_IDLE_MS)
    page.focused = true
    beater.changed()
    expect(sent.at(-1)).toMatchObject({ focused: true })
    advance(GLANCE_MS)
    beater.tick()
    expect(sent.at(-1)).toMatchObject({ focused: false })
  })

  it('a person switching back after a long break counts at once, before any click', () => {
    const { beater, sent, page, advance } = setup({ visible: true, focused: true })
    beater.changed()
    page.visible = false
    page.focused = false
    beater.changed()
    advance(INPUT_IDLE_MS + 60_000)
    page.visible = true
    page.focused = true
    beater.changed()
    expect(sent.at(-1)).toEqual({ tabId: 'tab-1', visible: true, focused: true })
  })

  it('a click just before leaving rides on the beat that says the tab was left', () => {
    const { beater, sent, page } = setup({ visible: true, focused: true })
    beater.changed()
    beater.input()
    page.focused = false
    beater.changed()
    expect(sent.at(-1)).toEqual({ tabId: 'tab-1', visible: true, focused: false, acted: true })
  })

  it('focus coming back sends at once, without waiting for the tick', () => {
    const { beater, sent, page } = setup({ visible: true, focused: false })
    beater.changed()
    page.focused = true
    beater.changed()
    expect(sent).toEqual([{ tabId: 'tab-1', visible: true, focused: true }])
  })

  it('leaving the page says the person is gone, only if it had said they were here', () => {
    const away = setup({ visible: false, focused: false })
    away.beater.left()
    expect(away.sent).toEqual([])

    const here = setup({ visible: true, focused: true })
    here.beater.changed()
    here.beater.left()
    expect(here.sent.at(-1)).toEqual({ tabId: 'tab-1', visible: true, focused: false })
  })
})
