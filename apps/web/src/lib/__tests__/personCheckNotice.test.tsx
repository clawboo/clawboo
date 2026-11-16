// A person the server's check did not recognise hears what happened and what to do,
// instead of a card that vanishes or a move that quietly lost its authority.

import { act, renderHook } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { server } from '@/__vitest__/mswServer'
import { useApprovalActions } from '@/features/approvals/useApprovalActions'
import { useApprovalsStore } from '@/stores/approvals'
import { useToastStore } from '@/stores/toast'

import { postTaskComment, updateStatusResult } from '../boardClient'
import {
  isPersonOnlyRefusal,
  notePersonCheck,
  PERSON_CHECK_MOVE,
  PERSON_CHECK_REFUSED,
  PERSON_CHECK_REPLY,
  primePersonCheckMode,
  resetPersonCheckNotices,
  VERIFIED_MOVE,
  VERIFIED_NOBODY,
  VERIFIED_REFUSED,
  VERIFIED_REPLY,
  watchForPersonCheckRefusal,
} from '../personCheckNotice'

const messages = () => useToastStore.getState().toasts.map((t) => t.message)
const flush = () => new Promise((r) => setTimeout(r, 0))

const refusal = (url = 'http://x/api/board/t1/retry') => {
  const res = new Response(JSON.stringify({ ok: false, error: 'person_only' }), { status: 403 })
  Object.defineProperty(res, 'url', { value: url })
  return res
}

beforeEach(() => {
  resetPersonCheckNotices()
  useToastStore.setState({ toasts: [] })
})

describe('the notices', () => {
  it('say what to do, in every case', () => {
    for (const text of [PERSON_CHECK_REFUSED, PERSON_CHECK_MOVE, PERSON_CHECK_REPLY])
      expect(text).toMatch(/Host header, or use https/)
  })

  it('show on a plain http page, where a browser has no crypto.randomUUID', () => {
    vi.stubGlobal('crypto', {})
    try {
      notePersonCheck(PERSON_CHECK_REFUSED)
    } finally {
      vi.unstubAllGlobals()
    }
    expect(messages()).toEqual([PERSON_CHECK_REFUSED])
  })

  it('say it once for a burst, and stay long enough to read', () => {
    notePersonCheck(PERSON_CHECK_MOVE)
    notePersonCheck(PERSON_CHECK_MOVE)
    const toasts = useToastStore.getState().toasts
    expect(toasts).toHaveLength(1)
    expect(toasts[0]?.ttlMs).toBeGreaterThan(5000)
  })
})

describe('watchForPersonCheckRefusal', () => {
  it('speaks up for a person_only refusal', async () => {
    watchForPersonCheckRefusal(refusal())
    await flush()
    expect(messages()).toEqual([PERSON_CHECK_REFUSED])
  })

  it('stays quiet about another 403, such as the origin guard', async () => {
    const res = new Response(JSON.stringify({ error: 'Cross-origin request blocked.' }), {
      status: 403,
    })
    watchForPersonCheckRefusal(res)
    await flush()
    expect(messages()).toEqual([])
    expect(await isPersonOnlyRefusal(res)).toBe(false)
  })

  it('stays quiet about the decision history, whose answer already reached the Gateway', async () => {
    watchForPersonCheckRefusal(refusal('http://x/api/approvals'))
    await flush()
    expect(messages()).toEqual([])
  })

  it('stays quiet about a read mark: opening a task asked for nothing', async () => {
    for (const url of ['http://x/api/board/t1/read', 'http://x/api/board/inbox/read']) {
      watchForPersonCheckRefusal(refusal(url))
    }
    await flush()
    expect(messages()).toEqual([])
  })

  it('leaves the body for the caller to read', async () => {
    const res = refusal()
    watchForPersonCheckRefusal(res)
    await flush()
    expect(await res.json()).toEqual({ ok: false, error: 'person_only' })
  })
})

describe('a write that went through without a person’s authority', () => {
  it('says so for a move', async () => {
    server.use(
      http.patch('/api/board/t1', () =>
        HttpResponse.json({ ok: true, task: { id: 't1' }, byPerson: false }),
      ),
    )
    expect((await updateStatusResult('t1', 'blocked')).ok).toBe(true)
    expect(messages()).toEqual([PERSON_CHECK_MOVE])
  })

  it('says nothing for a person’s move', async () => {
    server.use(
      http.patch('/api/board/t1', () => HttpResponse.json({ ok: true, task: { id: 't1' } })),
    )
    await updateStatusResult('t1', 'blocked')
    expect(messages()).toEqual([])
  })

  it('says so for a reply', async () => {
    server.use(
      http.post('/api/board/t1/comments', () =>
        HttpResponse.json({ ok: true, comment: { id: 'c1' }, byPerson: false }),
      ),
    )
    await postTaskComment('t1', 'hello')
    expect(messages()).toEqual([PERSON_CHECK_REPLY])
  })
})

// A tab with no Gateway connection answers through the server. A refusal there is
// not a Gateway that could not be reached, and the card must say which.
describe('a command card answered through the server', () => {
  const answer = async (id: string) => {
    useApprovalsStore
      .getState()
      .addPending({ id, command: 'ls', agentId: 'a', expiresAtMs: Date.now() + 60_000 } as never)
    const { result } = renderHook(() => useApprovalActions())
    await act(async () => {
      await result.current.handleApproval(id, 'deny')
    })
    return useApprovalsStore.getState().pendingApprovals.get(id)?.error
  }

  it('says what to do when the person check refused it', async () => {
    server.use(
      http.post('/api/tools/approvals/ap-1/resolve', () =>
        HttpResponse.json({ ok: false, error: 'person_only' }, { status: 403 }),
      ),
    )
    expect(await answer('ap-1')).toBe(PERSON_CHECK_REFUSED)
  })

  it('still names the Gateway when that is what failed', async () => {
    server.use(
      http.post('/api/tools/approvals/ap-2/resolve', () =>
        HttpResponse.json({ error: 'the Gateway did not accept that decision' }, { status: 502 }),
      ),
    )
    expect(await answer('ap-2')).toMatch(/could not reach the Gateway/)
  })
})

describe('on a server that counts only a person its sign-in proxy signed for', () => {
  const identity = (body: Record<string, unknown>) =>
    server.use(http.get('/api/access/identity', () => HttpResponse.json(body)))

  it('says to open Clawboo through the proxy, not to fix a Host header', async () => {
    identity({ personCheck: 'verified', person: { id: 'user-42', name: 'Ada', role: null } })
    await primePersonCheckMode()
    notePersonCheck(PERSON_CHECK_REFUSED)
    notePersonCheck(PERSON_CHECK_MOVE)
    notePersonCheck(PERSON_CHECK_REPLY)
    expect(messages()).toEqual([VERIFIED_REFUSED, VERIFIED_MOVE, VERIFIED_REPLY])
    for (const text of messages()) {
      expect(text).toMatch(/address your sign-in proxy serves/)
      expect(text).not.toMatch(/Host header/)
    }
  })

  it('says once, when the page opens with nobody signed in, that nothing here acts as you', async () => {
    identity({ personCheck: 'verified', person: null })
    await primePersonCheckMode()
    await primePersonCheckMode()
    expect(messages()).toEqual([VERIFIED_NOBODY])
  })

  it('keeps the usual notices on a server that reads the page, and says nothing at open', async () => {
    identity({ personCheck: 'page', person: null })
    await primePersonCheckMode()
    expect(messages()).toEqual([])
    notePersonCheck(PERSON_CHECK_REFUSED)
    expect(messages()).toEqual([PERSON_CHECK_REFUSED])
  })

  it('keeps the usual notices when the read fails, or on an older server', async () => {
    server.use(http.get('/api/access/identity', () => new HttpResponse(null, { status: 500 })))
    await primePersonCheckMode()
    notePersonCheck(PERSON_CHECK_REFUSED)
    expect(messages()).toEqual([PERSON_CHECK_REFUSED])
  })

  it('a refusal watched on any response gets the verified words too', async () => {
    identity({ personCheck: 'verified', person: { id: 'user-42', name: 'Ada', role: null } })
    await primePersonCheckMode()
    watchForPersonCheckRefusal(refusal())
    await flush()
    expect(messages()).toEqual([VERIFIED_REFUSED])
  })
})
