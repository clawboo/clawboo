// The mounted presence beat, through real DOM events: a focused, visible tab
// posts beats; hiding it posts one last beat and then silence, whatever the timer
// does; a tab that was hidden all along never posts at all.

import { render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const apiFetch = vi.fn((_path: string, _init?: RequestInit) =>
  Promise.resolve(new Response('{}', { status: 200 })),
)
vi.mock('@clawboo/control-client', () => ({
  apiFetch: (path: string, init?: RequestInit) => apiFetch(path, init),
}))

import { PresenceBeat } from '../PresenceBeat'
import { PRESENCE_BEAT_MS } from '../presenceBeater'

let visibility: DocumentVisibilityState = 'visible'
let focused = true

function beats(): Array<Record<string, unknown>> {
  return apiFetch.mock.calls.map(([path, init]) => {
    expect(path).toBe('/api/system/presence')
    expect(init?.method).toBe('POST')
    return JSON.parse(String(init?.body)) as Record<string, unknown>
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  apiFetch.mockClear()
  visibility = 'visible'
  focused = true
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility)
  vi.spyOn(document, 'hasFocus').mockImplementation(() => focused)
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('PresenceBeat', () => {
  it('beats while the tab is visible and focused, and goes quiet once it is hidden', () => {
    const { unmount } = render(<PresenceBeat />)
    expect(beats()).toEqual([expect.objectContaining({ visible: true, focused: true })])

    vi.advanceTimersByTime(PRESENCE_BEAT_MS)
    expect(beats()).toHaveLength(2)

    visibility = 'hidden'
    focused = false
    document.dispatchEvent(new Event('visibilitychange'))
    expect(beats().at(-1)).toMatchObject({ visible: false, focused: false })
    const sent = beats().length

    vi.advanceTimersByTime(PRESENCE_BEAT_MS * 10)
    expect(beats()).toHaveLength(sent)
    unmount()
  })

  it('a tab hidden from the start never posts, however long it stays open', () => {
    visibility = 'hidden'
    focused = false
    const { unmount } = render(<PresenceBeat />)
    vi.advanceTimersByTime(PRESENCE_BEAT_MS * 10)
    window.dispatchEvent(new Event('blur'))
    expect(apiFetch).not.toHaveBeenCalled()
    unmount()
  })

  it('a click marks the next beat as an action', () => {
    const { unmount } = render(<PresenceBeat />)
    window.dispatchEvent(new Event('pointerdown'))
    vi.advanceTimersByTime(PRESENCE_BEAT_MS)
    expect(beats().at(-1)).toMatchObject({ focused: true, acted: true })
    unmount()
  })

  it('stops beating when unmounted', () => {
    const { unmount } = render(<PresenceBeat />)
    unmount()
    const sent = apiFetch.mock.calls.length
    vi.advanceTimersByTime(PRESENCE_BEAT_MS * 5)
    expect(apiFetch.mock.calls.length).toBe(sent)
  })
})
