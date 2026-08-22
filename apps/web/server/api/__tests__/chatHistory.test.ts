// The chat-history endpoints read `sessionKey` straight off the query string,
// and the TYPE of a query value is the caller's choice: Express hands back an
// array for a repeated key and an object for a bracketed one. Everything
// downstream (the session-key parse, the database comparison) assumes a string,
// so these pin the narrowing at the boundary and the parse it feeds.

import type { Request, Response } from 'express'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../lib/db', () => ({ getDb: () => ({}) }))

import { chatHistoryDELETE, parseTeamSessionKey } from '../chatHistory'

type Res = {
  statusCode: number
  body: unknown
  status: (code: number) => Res
  json: (payload: unknown) => Res
}

function fakeRes(): Res {
  const res: Res = {
    statusCode: 200,
    body: undefined,
    status(code) {
      res.statusCode = code
      return res
    },
    json(payload) {
      res.body = payload
      return res
    },
  }
  return res
}

describe('chatHistoryDELETE session-key typing', () => {
  const call = async (sessionKey: unknown): Promise<Res> => {
    const res = fakeRes()
    const req = { query: { sessionKey } } as unknown as Request
    await chatHistoryDELETE(req, res as unknown as Response)
    return res
  }

  it('rejects a repeated key, which arrives as an array', async () => {
    const res = await call(['agent:a1:native', 'agent:a2:native'])
    expect(res.statusCode).toBe(400)
    expect(res.body).toEqual({ error: 'sessionKey required' })
  })

  it('rejects a bracketed key, which arrives as an object', async () => {
    const res = await call({ evil: 'agent:a1:native' })
    expect(res.statusCode).toBe(400)
  })

  it('rejects a missing key', async () => {
    expect((await call(undefined)).statusCode).toBe(400)
  })
})

describe('parseTeamSessionKey', () => {
  it('splits a team key into its ids', () => {
    expect(parseTeamSessionKey('agent:a1:team:t1')).toEqual({ agentId: 'a1', teamId: 't1' })
  })

  it('returns null for keys that are not team-shaped', () => {
    for (const key of ['', 'agent:a1:native', 'nope', 'agent:', 'agent::team:t1']) {
      expect(parseTeamSessionKey(key), key).toBeNull()
    }
  })

  it('takes the rightmost separator with ids on both sides', () => {
    expect(parseTeamSessionKey('agent:a:team:b:team:c')).toEqual({
      agentId: 'a:team:b',
      teamId: 'c',
    })
    // The trailing separator leaves an empty team id, so the parse falls back to
    // the previous one, and everything after it is the team id.
    expect(parseTeamSessionKey('agent:a:team:t1:team:')).toEqual({
      agentId: 'a',
      teamId: 't1:team:',
    })
  })

  it('rejects a key smuggling a line break', () => {
    expect(parseTeamSessionKey('agent:a1:team:t1\nx')).toBeNull()
  })

  it('stays linear on a key packed with separators', () => {
    const hostile = 'agent:' + 'a:team:'.repeat(50000)
    const started = performance.now()
    parseTeamSessionKey(hostile)
    expect(performance.now() - started).toBeLessThan(500)
  })
})
