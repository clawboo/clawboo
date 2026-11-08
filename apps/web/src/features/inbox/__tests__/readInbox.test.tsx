// A read the watcher gave up on counts as failed, so its snapshot must not land:
// the body can arrive just before the deadline or the page closing aborts it.

import { afterEach, describe, expect, it, vi } from 'vitest'

const SNAPSHOT = { unread: [{ id: 'a', seq: 3 }], needsYou: ['n'], approvals: [], through: 3 }
let onBody: () => void = () => {}

vi.mock('@clawboo/control-client', () => ({
  apiFetch: vi.fn(async () => ({
    ok: true,
    json: async () => {
      onBody()
      return SNAPSHOT
    },
  })),
}))

import { readInbox } from '../InboxBridge'
import { inboxCount, resetInboxStore, useInboxStore } from '../inboxStore'

afterEach(() => {
  onBody = () => {}
  resetInboxStore()
})

describe('readInbox', () => {
  it('holds what a live read said', async () => {
    expect(await readInbox(new AbortController().signal)).toBe(true)
    expect(useInboxStore.getState().unread).toEqual({ a: 3 })
    expect(inboxCount(useInboxStore.getState(), [])).toBe(2)
  })

  it('drops a snapshot whose read was aborted after its body arrived', async () => {
    const abort = new AbortController()
    onBody = () => abort.abort()
    expect(await readInbox(abort.signal)).toBe(false)
    expect(inboxCount(useInboxStore.getState(), [])).toBe(0)
    expect(useInboxStore.getState().unread).toEqual({})
    expect(useInboxStore.getState().needsYou).toEqual([])
    expect(useInboxStore.getState().revision).toBe(0)
  })
})
