// What the page believes about the person's inbox. The server is the truth; marks
// sent from this page apply at once, and a read that left before a mark landed must
// not bring the task back.

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useAlertSignal } from '@/features/alerts/alertSignal'

import { inboxCount, resetInboxStore, unreadIds, useInboxStore } from '../inboxStore'

const snapshot = (over: Partial<Parameters<ReturnType<typeof store>['apply']>[0]> = {}) => ({
  unread: [],
  needsYou: [],
  approvals: [],
  through: 0,
  ...over,
})
const store = () => useInboxStore.getState()

function stubFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) =>
    handler(String(url), init),
  )
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

beforeEach(() => {
  resetInboxStore()
  vi.unstubAllGlobals()
})

describe('the badge count', () => {
  it('counts each task once, whether unread, needing the person, or both', () => {
    store().apply(
      snapshot({
        unread: [
          { id: 'a', seq: 3 },
          { id: 'b', seq: 2 },
        ],
        needsYou: ['b', 'c'],
        approvals: ['x'],
        through: 3,
      }),
    )
    expect(inboxCount(store(), [])).toBe(4)
  })

  it('counts a shell approval the Gateway delivered once, mirrored or not', () => {
    store().apply(snapshot({ approvals: ['x'] }))
    expect(inboxCount(store(), ['x', 'y'])).toBe(2)
  })

  it('is zero before the first read', () => {
    expect(inboxCount(store(), [])).toBe(0)
  })
})

describe('marking a task read', () => {
  it('clears it at once and tells the server what the page showed', async () => {
    const fetchMock = stubFetch(() => Response.json({ ok: true, unread: false }))
    store().apply(snapshot({ unread: [{ id: 'a', seq: 7 }], through: 7 }))
    expect(unreadIds(store())).toEqual(['a'])

    const done = store().markRead('a', 7)
    expect(unreadIds(store())).toEqual([])
    await done

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]!
    expect(String(url)).toContain('/api/board/a/read')
    expect(init?.method).toBe('POST')
    expect(JSON.parse(String(init?.body))).toEqual({ through: 7 })
  })

  it('a read that left before the mark landed does not bring it back', async () => {
    stubFetch(() => Response.json({ ok: true, unread: false }))
    store().apply(snapshot({ unread: [{ id: 'a', seq: 7 }], through: 7 }))
    await store().markRead('a', 7)
    store().apply(snapshot({ unread: [{ id: 'a', seq: 7 }], through: 7 }))
    expect(unreadIds(store())).toEqual([])
  })

  it('a newer change on the same task does come back', async () => {
    stubFetch(() => Response.json({ ok: true, unread: false }))
    store().apply(snapshot({ unread: [{ id: 'a', seq: 7 }], through: 7 }))
    await store().markRead('a', 7)
    store().apply(snapshot({ unread: [{ id: 'a', seq: 9 }], through: 9 }))
    expect(unreadIds(store())).toEqual(['a'])
  })

  it('shows it unread again when the server refused, and asks for a fresh read', async () => {
    stubFetch(() => new Response(null, { status: 500 }))
    store().apply(snapshot({ unread: [{ id: 'a', seq: 7 }], through: 7 }))
    const before = useAlertSignal.getState().inbox
    await store().markRead('a', 7)
    expect(unreadIds(store())).toEqual(['a'])
    expect(useAlertSignal.getState().inbox).toBeGreaterThan(before)
  })

  it('keeps it unread when the request never arrived', async () => {
    stubFetch(() => {
      throw new TypeError('network')
    })
    store().apply(snapshot({ unread: [{ id: 'a', seq: 7 }], through: 7 }))
    await store().markRead('a', 7)
    expect(unreadIds(store())).toEqual(['a'])
  })
})

describe('two marks of the same task at once', () => {
  /** Requests that stay out until the test refuses them, oldest first. */
  function heldRefusals(): () => void {
    const held: Array<() => void> = []
    stubFetch(
      () => new Promise((resolve) => held.push(() => resolve(new Response(null, { status: 500 })))),
    )
    return () => held.shift()?.()
  }

  it('both refused: it stays unread, whichever answers first', async () => {
    const refuse = heldRefusals()
    store().apply(snapshot({ unread: [{ id: 'a', seq: 7 }], through: 7 }))
    const first = store().markRead('a', 7)
    const second = store().markRead('a', 7)
    refuse()
    await first
    refuse()
    await second
    expect(unreadIds(store())).toEqual(['a'])
    store().apply(snapshot({ unread: [{ id: 'a', seq: 7 }], through: 7 }))
    expect(unreadIds(store())).toEqual(['a'])
  })

  it('an older refusal leaves a newer mark alone', async () => {
    const refuse = heldRefusals()
    store().apply(snapshot({ unread: [{ id: 'a', seq: 7 }], through: 7 }))
    const older = store().markRead('a', 5)
    const newer = store().markRead('a', 7)
    refuse()
    await older
    expect(store().marks).toEqual({ a: 7 })
    refuse()
    await newer
    expect(store().marks).toEqual({})
  })

  it('says whether the server took it', async () => {
    stubFetch(() => Response.json({ ok: true, unread: false }))
    await expect(store().markRead('a', 7)).resolves.toBe(true)
    stubFetch(() => new Response(null, { status: 403 }))
    await expect(store().markRead('b', 7)).resolves.toBe(false)
  })

  it('two refused marks of the whole board leave nothing hidden', async () => {
    const refuse = heldRefusals()
    store().apply(snapshot({ unread: [{ id: 'a', seq: 5 }], through: 5 }))
    const first = store().markAllRead({ through: 5 })
    const second = store().markAllRead({ through: 5 })
    refuse()
    await first
    refuse()
    await second
    expect(store().allMark).toBe(0)
    expect(unreadIds(store())).toEqual(['a'])
  })

  it('a refused mark of one team leaves the whole board’s mark alone', async () => {
    stubFetch(() => Response.json({ ok: true }))
    await store().markAllRead({ through: 3 })
    stubFetch(() => new Response(null, { status: 500 }))
    await store().markAllRead({ through: 5, teamId: 'T', shown: [{ id: 'a', seq: 5 }] })
    expect(store().allMark).toBe(3)
    expect(store().marks).toEqual({})
  })
})

describe('a read landing', () => {
  it('moves the revision the list follows, and only that does', async () => {
    stubFetch(() => Response.json({ ok: true, unread: false }))
    const start = store().revision
    await store().markRead('a', 7)
    expect(store().revision).toBe(start)
    store().apply(snapshot())
    expect(store().revision).toBe(start + 1)
  })
})

describe('marking everything read', () => {
  it('clears what the page knew of and leaves what arrived after', async () => {
    const fetchMock = stubFetch(() => Response.json({ ok: true }))
    store().apply(
      snapshot({
        unread: [
          { id: 'a', seq: 5 },
          { id: 'b', seq: 6 },
        ],
        through: 6,
      }),
    )
    const done = store().markAllRead({ through: 6 })
    expect(unreadIds(store())).toEqual([])
    await expect(done).resolves.toBe(true)
    const [url, init] = fetchMock.mock.calls[0]!
    expect(String(url)).toContain('/api/board/inbox/read')
    expect(JSON.parse(String(init?.body))).toEqual({ through: 6 })

    store().apply(
      snapshot({
        unread: [
          { id: 'a', seq: 5 },
          { id: 'c', seq: 8 },
        ],
        through: 8,
      }),
    )
    expect(unreadIds(store())).toEqual(['c'])
  })

  it('sends the team, and waits for the server rather than guessing which tasks', async () => {
    const fetchMock = stubFetch(() => Response.json({ ok: true }))
    store().apply(snapshot({ unread: [{ id: 'a', seq: 5 }], through: 5 }))
    await store().markAllRead({ through: 5, teamId: 'T' })
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]?.body))).toEqual({
      through: 5,
      teamId: 'T',
    })
    expect(unreadIds(store())).toEqual(['a'])
  })

  it('clears what the page showed of that team at once', async () => {
    stubFetch(() => Response.json({ ok: true }))
    store().apply(
      snapshot({
        unread: [
          { id: 'a', seq: 5 },
          { id: 'other-team', seq: 4 },
        ],
        through: 5,
      }),
    )
    const done = store().markAllRead({ through: 5, teamId: 'T', shown: [{ id: 'a', seq: 5 }] })
    expect(unreadIds(store())).toEqual(['other-team'])
    await done
    expect(unreadIds(store())).toEqual(['other-team'])
  })

  it('takes a team’s marks back when the server refused', async () => {
    stubFetch(() => new Response(null, { status: 500 }))
    store().apply(snapshot({ unread: [{ id: 'a', seq: 5 }], through: 5 }))
    await store().markAllRead({ through: 5, teamId: 'T', shown: [{ id: 'a', seq: 5 }] })
    expect(unreadIds(store())).toEqual(['a'])
  })

  it('takes them back when the server refused', async () => {
    stubFetch(() => new Response(null, { status: 500 }))
    store().apply(snapshot({ unread: [{ id: 'a', seq: 5 }], through: 5 }))
    await expect(store().markAllRead({ through: 5 })).resolves.toBe(false)
    expect(unreadIds(store())).toEqual(['a'])
  })
})
