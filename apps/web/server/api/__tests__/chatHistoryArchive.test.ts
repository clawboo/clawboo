// Two ways a conversation ends, and the difference between them.
//
// A RESET means "start fresh": the messages move aside and stay recoverable.
// A DELETE means the agent is gone: the conversation goes with it, archives too.
// Both have to end the conversation the MODEL is holding, or a supposedly fresh
// chat answers from turns the person can no longer see.

import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { chatMessages, getSetting, setSetting, type ClawbooDb } from '@clawboo/db'

import { getDb, resetDb } from '../../lib/db'
import { nativeChatSessionSettingKey } from '../../lib/agentChat/driveAgentChat'
import { nativeTeamSessionSettingKey } from '../../lib/teamChat/nativeTeamSession'
import { chatHistoryARCHIVE, chatHistoryDELETE } from '../chatHistory'

type Handler = typeof chatHistoryARCHIVE
const call = async (handler: Handler, sessionKey: string): Promise<unknown> => {
  let body: unknown
  const req = { query: { sessionKey } } as unknown as Parameters<Handler>[0]
  const res = {
    json: (payload: unknown) => {
      body = payload
      return res
    },
    status: () => res,
  } as unknown as Parameters<Handler>[1]
  await handler(req, res)
  return body
}

let home: string
let prevHome: string | undefined
let db: ClawbooDb

beforeEach(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), 'clawboo-chat-archive-'))
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

const write = (sessionKey: string, text: string): void => {
  db.insert(chatMessages)
    .values({
      sessionKey,
      gatewayUrl: '',
      entryId: `${sessionKey}:${text}`,
      timestampMs: Date.now(),
      data: JSON.stringify({ kind: 'user', text }),
    })
    .run()
}
const all = () => db.select().from(chatMessages).all()
const live = (key: string) => all().filter((r) => r.sessionKey === key)

describe('archive', () => {
  it('keeps every message, under a key the chat no longer reads', async () => {
    write('agent:a1:native', 'hello')
    write('agent:a1:native', 'goodbye')

    const body = await call(chatHistoryARCHIVE, 'agent:a1:native')

    expect(body).toMatchObject({ ok: true, archived: 2 })
    expect(live('agent:a1:native')).toHaveLength(0)
    expect(all()).toHaveLength(2)
    expect(all().every((r) => r.sessionKey.startsWith('agent:a1:native#reset:'))).toBe(true)
  })

  it('ends the conversation the model is holding, for a 1:1 chat', async () => {
    // Without this the "fresh" chat answers from the archived turns.
    const pointer = nativeChatSessionSettingKey('a1')
    setSetting(db, pointer, 'native-abc123')
    await call(chatHistoryARCHIVE, 'agent:a1:native')
    expect(getSetting(db, pointer)).toBe('')
  })

  it('ends it for a team chat too, per teammate', async () => {
    const pointer = nativeTeamSessionSettingKey('a1', 't1')
    setSetting(db, pointer, 'native-team-abc')
    await call(chatHistoryARCHIVE, 'agent:a1:team:t1')
    expect(getSetting(db, pointer)).toBe('')
  })

  it('leaves another conversation alone', async () => {
    write('agent:a1:native', 'mine')
    write('agent:a2:native', 'theirs')
    await call(chatHistoryARCHIVE, 'agent:a1:native')
    expect(live('agent:a2:native')).toHaveLength(1)
  })

  it('does nothing to an already-empty chat', async () => {
    expect(await call(chatHistoryARCHIVE, 'agent:a1:native')).toMatchObject({ archived: 0 })
    expect(all()).toHaveLength(0)
  })

  it('rejects a key that is not a single string', async () => {
    const res = {
      statusCode: 0,
      status(c: number) {
        this.statusCode = c
        return this
      },
      json() {
        return this
      },
    }
    await chatHistoryARCHIVE(
      { query: { sessionKey: ['a', 'b'] } } as unknown as Parameters<Handler>[0],
      res as unknown as Parameters<Handler>[1],
    )
    expect(res.statusCode).toBe(400)
  })
})

describe('delete', () => {
  it('takes the archives with it, so a deleted agent leaves nothing behind', async () => {
    write('agent:a1:native', 'first')
    await call(chatHistoryARCHIVE, 'agent:a1:native')
    write('agent:a1:native', 'second')

    await call(chatHistoryDELETE, 'agent:a1:native')

    expect(all()).toHaveLength(0)
  })

  it('never reaches a different agent whose key shares the prefix', async () => {
    write('agent:a1:native', 'mine')
    write('agent:a1:native-2', 'theirs')
    await call(chatHistoryARCHIVE, 'agent:a1:native-2')

    await call(chatHistoryDELETE, 'agent:a1:native')

    expect(all()).toHaveLength(1)
    expect(all()[0]?.sessionKey).toContain('agent:a1:native-2#reset:')
  })
})
