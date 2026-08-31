// Starting fresh, and reading a conversation that is never cleared.
//
// The reset must end what the MODEL carries without moving a single message, and
// the history route must hand back the most RECENT page. Those two go together: the
// route used to return the oldest N, which nobody noticed while every reset emptied
// the transcript. Now that conversations grow without bound, that page is what a
// person opens their chat on.

import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { chatMessages, getSetting, setSetting, type ClawbooDb } from '@clawboo/db'
import type { Request, Response } from 'express'

import { getDb, resetDb } from '../../lib/db'
import { nativeChatSessionSettingKey } from '../../lib/agentChat/driveAgentChat'
import { nativeTeamSessionSettingKey } from '../../lib/teamChat/nativeTeamSession'
import { chatHistoryGET, chatHistoryRESETCONTEXT } from '../chatHistory'

type Res = {
  statusCode: number
  body: unknown
  status: (c: number) => Res
  json: (b: unknown) => Res
}
function fakeRes(): Res {
  const res: Res = {
    statusCode: 200,
    body: undefined,
    status(c) {
      res.statusCode = c
      return res
    },
    json(b) {
      res.body = b
      return res
    },
  }
  return res
}

let home: string
let prevHome: string | undefined
let db: ClawbooDb

beforeEach(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), 'clawboo-chat-ctx-'))
  prevHome = process.env['HOME']
  process.env['HOME'] = home
  db = getDb()
})
afterEach(async () => {
  // Close BEFORE removing the dir: Windows refuses to remove a directory that
  // still holds an open file.
  resetDb()
  if (prevHome === undefined) delete process.env['HOME']
  else process.env['HOME'] = prevHome
  await rm(home, { recursive: true, force: true })
})

const write = (sessionKey: string, text: string, ts: number): void => {
  db.insert(chatMessages)
    .values({
      sessionKey,
      gatewayUrl: '',
      entryId: `${sessionKey}:${text}`,
      timestampMs: ts,
      data: JSON.stringify({ entryId: `${sessionKey}:${text}`, kind: 'user', text }),
    })
    .run()
}

const resetContext = async (body: unknown): Promise<Res> => {
  const res = fakeRes()
  await chatHistoryRESETCONTEXT({ body } as unknown as Request, res as unknown as Response)
  return res
}

const load = async (query: Record<string, string>): Promise<Res> => {
  const res = fakeRes()
  await chatHistoryGET({ query } as unknown as Request, res as unknown as Response)
  return res
}

describe('starting fresh', () => {
  it('moves no message and adds exactly one divider', async () => {
    write('agent:a1:native', 'hello', 1)
    write('agent:a1:native', 'goodbye', 2)

    const res = await resetContext({ sessionKeys: ['agent:a1:native'] })

    const rows = db.select().from(chatMessages).all()
    expect(rows).toHaveLength(3)
    // Every original message is still under the SAME key, untouched.
    expect(rows.filter((r) => r.sessionKey === 'agent:a1:native')).toHaveLength(3)
    expect((res.body as { entry: { text: string } }).entry.text).toContain('Starting fresh')
  })

  it('ends the conversation the model is holding, for a 1:1 chat', async () => {
    const pointer = nativeChatSessionSettingKey('a1')
    setSetting(db, pointer, 'native-abc123')
    await resetContext({ sessionKeys: ['agent:a1:native'] })
    expect(getSetting(db, pointer)).toBe('')
  })

  it('ends it for every teammate in a room, but shows one divider', async () => {
    const p1 = nativeTeamSessionSettingKey('a1', 't1')
    const p2 = nativeTeamSessionSettingKey('a2', 't1')
    setSetting(db, p1, 'x')
    setSetting(db, p2, 'y')

    await resetContext({
      sessionKeys: ['agent:a1:team:t1', 'agent:a2:team:t1'],
      noticeSessionKey: 'agent:a1:team:t1',
    })

    expect(getSetting(db, p1)).toBe('')
    expect(getSetting(db, p2)).toBe('')
    const dividers = db.select().from(chatMessages).all()
    expect(dividers).toHaveLength(1)
    expect(dividers[0]?.sessionKey).toBe('agent:a1:team:t1')
  })

  it('rejects an empty or malformed key list', async () => {
    expect((await resetContext({})).statusCode).toBe(400)
    expect((await resetContext({ sessionKeys: [] })).statusCode).toBe(400)
    expect((await resetContext({ sessionKeys: [42] })).statusCode).toBe(400)
  })

  it('refuses to put the divider on a session it was not asked to reset', async () => {
    const res = await resetContext({
      sessionKeys: ['agent:a1:native'],
      noticeSessionKey: 'agent:someone-else:native',
    })
    expect(res.statusCode).toBe(400)
    expect(db.select().from(chatMessages).all()).toHaveLength(0)
  })
})

describe('reading a long conversation', () => {
  const seed = (n: number) => {
    for (let i = 1; i <= n; i++) write('agent:a1:native', `m${i}`, i)
  }
  const textsOf = (res: Res) =>
    (res.body as { entries: { text: string }[] }).entries.map((e) => e.text)

  it('opens on the MOST RECENT page, not the oldest', async () => {
    // The bug this replaces: 250 messages loaded m1..m200 and the recent ones were
    // simply absent from the chat.
    seed(250)
    const res = await load({ sessionKey: 'agent:a1:native', limit: '200' })
    const texts = textsOf(res)
    expect(texts).toHaveLength(200)
    expect(texts[texts.length - 1]).toBe('m250')
    expect(texts[0]).toBe('m51')
  })

  it('returns the page oldest-first, so the chat renders in order', async () => {
    seed(5)
    expect(textsOf(await load({ sessionKey: 'agent:a1:native' }))).toEqual([
      'm1',
      'm2',
      'm3',
      'm4',
      'm5',
    ])
  })

  it('walks backwards a page at a time and stops at the start', async () => {
    seed(250)
    const first = await load({ sessionKey: 'agent:a1:native', limit: '200' })
    const body = first.body as { hasMore: boolean; nextBefore: number }
    expect(body.hasMore).toBe(true)

    const second = await load({
      sessionKey: 'agent:a1:native',
      limit: '200',
      before: String(body.nextBefore),
    })
    const texts = textsOf(second)
    expect(texts).toEqual(['m1', ...Array.from({ length: 49 }, (_, i) => `m${i + 2}`)])
    // Reached the beginning, so there is nothing further back to offer.
    expect((second.body as { hasMore: boolean }).hasMore).toBe(false)
    expect((second.body as { nextBefore: number | null }).nextBefore).toBeNull()
  })

  it('reports no more when the whole conversation fits on one page', async () => {
    seed(5)
    const res = await load({ sessionKey: 'agent:a1:native' })
    expect((res.body as { hasMore: boolean }).hasMore).toBe(false)
    expect((res.body as { nextBefore: number | null }).nextBefore).toBeNull()
  })

  it('ignores a cursor that is not a number rather than returning nothing', async () => {
    seed(3)
    const res = await load({ sessionKey: 'agent:a1:native', before: 'not-a-number' })
    expect(textsOf(res)).toHaveLength(3)
  })
})
