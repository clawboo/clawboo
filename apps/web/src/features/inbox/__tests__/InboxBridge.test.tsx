// The badge comes from the app's one event tail: a wake reads the inbox once, and
// nothing reads it on a timer. Mounted at the app root, whichever view is open and
// whether or not browser alerts are switched on.

import { act, cleanup, render } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { server } from '@/__vitest__/mswServer'
import { useAlertSignal } from '@/features/alerts/alertSignal'

import { InboxBridge } from '../InboxBridge'
import { inboxCount, resetInboxStore, useInboxStore } from '../inboxStore'

let reads = 0
let answer: { unread: Array<{ id: string; seq: number }>; through: number } = {
  unread: [],
  through: 0,
}
let status = 200

const flush = async (): Promise<void> => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0)
  })
}

async function settle(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

/** Give the (real) request time to land while the clock stays put. */
async function landed(expected: number): Promise<void> {
  await vi.waitFor(() => expect(reads).toBe(expected), { timeout: 2000, interval: 5 })
  await act(async () => {
    await new Promise<void>((r) => setImmediate(r))
    await new Promise<void>((r) => setImmediate(r))
    await new Promise<void>((r) => setImmediate(r))
  })
}

beforeEach(() => {
  reads = 0
  status = 200
  answer = { unread: [], through: 0 }
  resetInboxStore()
  useAlertSignal.setState({ seq: 0, inbox: 0, inboxEvent: 0, boardActivity: 0, boardReads: 0 })
  server.use(
    http.get('/api/board/inbox', () => {
      reads += 1
      if (status !== 200) return new HttpResponse(null, { status })
      return HttpResponse.json({ ...answer, needsYou: [], approvals: [] })
    }),
  )
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('InboxBridge', () => {
  it('reads once when the app opens, then waits for the tail', async () => {
    answer = { unread: [{ id: 'a', seq: 3 }], through: 3 }
    render(<InboxBridge />)
    await landed(1)
    expect(inboxCount(useInboxStore.getState(), [])).toBe(1)

    // A long quiet stretch reads nothing: there is no timer behind the badge.
    await settle(10 * 60_000)
    await flush()
    expect(reads).toBe(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('a new comment from someone else raises the badge, by way of the tail', async () => {
    render(<InboxBridge />)
    await landed(1)
    expect(inboxCount(useInboxStore.getState(), [])).toBe(0)

    answer = { unread: [{ id: 'a', seq: 9 }], through: 9 }
    act(() => useAlertSignal.getState().noteBoardActivity(9))
    await settle(1000)
    await landed(2)
    expect(inboxCount(useInboxStore.getState(), [])).toBe(1)
  })

  it('a burst of events costs one read', async () => {
    render(<InboxBridge />)
    await landed(1)
    act(() => {
      useAlertSignal.getState().noteBoardActivity(1)
      useAlertSignal.getState().noteBoardActivity(2)
      useAlertSignal.getState().noteInboxEvent(50)
      useAlertSignal.getState().noteBoardActivity(3)
    })
    await settle(1000)
    await landed(2)
    await settle(60_000)
    await flush()
    expect(reads).toBe(2)
  })

  it('wakes when the person read something in another browser', async () => {
    answer = { unread: [{ id: 'a', seq: 3 }], through: 3 }
    render(<InboxBridge />)
    await landed(1)
    expect(inboxCount(useInboxStore.getState(), [])).toBe(1)

    answer = { unread: [], through: 3 }
    act(() => useAlertSignal.getState().noteBoardActivity(3, 500))
    await settle(1000)
    await landed(2)
    expect(inboxCount(useInboxStore.getState(), [])).toBe(0)
  })

  it('wakes for a run ending or an approval, not only for a task change', async () => {
    render(<InboxBridge />)
    await landed(1)
    act(() => useAlertSignal.getState().noteInboxEvent(70))
    await settle(1000)
    await landed(2)
  })

  it('tries a failed read again and keeps what it knew', async () => {
    answer = { unread: [{ id: 'a', seq: 3 }], through: 3 }
    render(<InboxBridge />)
    await landed(1)

    status = 500
    act(() => useAlertSignal.getState().noteBoardActivity(4))
    await settle(1000)
    await landed(2)
    expect(inboxCount(useInboxStore.getState(), [])).toBe(1)

    status = 200
    answer = { unread: [], through: 4 }
    await settle(5000)
    await landed(3)
    expect(inboxCount(useInboxStore.getState(), [])).toBe(0)
  })

  describe('in a hidden tab', () => {
    let hidden = false
    const setHidden = (value: boolean): void => {
      hidden = value
      act(() => {
        document.dispatchEvent(new Event('visibilitychange'))
      })
    }
    beforeEach(() => {
      hidden = false
      vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden)
    })

    it('reads nothing while hidden, however busy the board, and once on its return', async () => {
      render(<InboxBridge />)
      await landed(1)
      setHidden(true)
      for (let seq = 1; seq <= 5; seq++) {
        act(() => useAlertSignal.getState().noteBoardActivity(seq))
        await settle(1000)
      }
      await flush()
      expect(reads).toBe(1)

      answer = { unread: [{ id: 'a', seq: 5 }], through: 5 }
      setHidden(false)
      await landed(2)
      expect(inboxCount(useInboxStore.getState(), [])).toBe(1)
      await settle(60_000)
      await flush()
      expect(reads).toBe(2)
    })

    it('reads nothing on its return when it missed nothing', async () => {
      render(<InboxBridge />)
      await landed(1)
      setHidden(true)
      setHidden(false)
      await settle(5000)
      await flush()
      expect(reads).toBe(1)
    })

    it('a tab opened in the background reads when it comes to the front', async () => {
      hidden = true
      render(<InboxBridge />)
      await settle(5000)
      await flush()
      expect(reads).toBe(0)
      setHidden(false)
      await landed(1)
    })
  })

  it('a bridge that has gone does not apply the answer it was waiting for', async () => {
    let release = (): void => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    server.use(
      http.get('/api/board/inbox', async () => {
        reads += 1
        await held
        return HttpResponse.json({
          unread: [{ id: 'stale', seq: 1 }],
          through: 1,
          needsYou: [],
          approvals: [],
        })
      }),
    )
    const view = render(<InboxBridge />)
    await landed(1)
    view.unmount()
    release()
    await act(async () => {
      for (let i = 0; i < 5; i += 1) await new Promise<void>((r) => setImmediate(r))
    })
    expect(useInboxStore.getState().revision).toBe(0)
    expect(useInboxStore.getState().unread).toEqual({})
  })

  it('stops when unmounted', async () => {
    const view = render(<InboxBridge />)
    await landed(1)
    act(() => useAlertSignal.getState().noteBoardActivity(9))
    view.unmount()
    await settle(60_000)
    await flush()
    expect(reads).toBe(1)
  })
})
