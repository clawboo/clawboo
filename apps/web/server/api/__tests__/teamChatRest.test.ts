// parseTeamChatBinding reads the run's authoritative author identity + room
// from the TeamChat MCP attach URL — the anti-spoof binding (clawboo writes the
// URL, the model can't change it). Plus the team-chat REST read surface.

import { mkdtempSync, rmSync } from 'node:fs'
import type { IncomingMessage } from 'node:http'
import os from 'node:os'
import path from 'node:path'

import { createDb, postToRoom, resolveRoomForTeam } from '@clawboo/db'
import type { Request, Response } from 'express'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { getDbPath } from '../../lib/db'
import { releaseRoom, tryAcquireRoom } from '../../lib/teamChat/roomLock'
import { parseTeamChatBinding } from '../mcp'
import { teamChatExchangePOST, teamChatGET } from '../teamChat'

const req = (url: string): IncomingMessage => ({ url }) as IncomingMessage

describe('parseTeamChatBinding (anti-spoof URL binding)', () => {
  it('parses room team + author from the URL query', () => {
    expect(
      parseTeamChatBinding(req('/api/mcp/teamchat?roomTeamId=tm1&postAuthorAgentId=boo-1')),
    ).toEqual({
      agentId: 'boo-1',
      teamId: 'tm1',
      roomId: resolveRoomForTeam('tm1'),
    })
  })

  it('returns undefined when either binding param is missing (unbound)', () => {
    expect(parseTeamChatBinding(req('/api/mcp/teamchat?roomTeamId=tm1'))).toBeUndefined()
    expect(parseTeamChatBinding(req('/api/mcp/teamchat?postAuthorAgentId=boo-1'))).toBeUndefined()
    expect(parseTeamChatBinding(req('/api/mcp/teamchat'))).toBeUndefined()
    expect(parseTeamChatBinding(undefined)).toBeUndefined()
  })
})

describe('GET /api/team-chat', () => {
  // Sandbox CLAWBOO_HOME so the handler's getDbPath() never touches the real DB.
  let prevHome: string | undefined
  let dir: string
  beforeAll(() => {
    prevHome = process.env['CLAWBOO_HOME']
    dir = mkdtempSync(path.join(os.tmpdir(), 'clawboo-tcrest-'))
    process.env['CLAWBOO_HOME'] = dir
  })
  afterAll(() => {
    if (prevHome === undefined) delete process.env['CLAWBOO_HOME']
    else process.env['CLAWBOO_HOME'] = prevHome
    rmSync(dir, { recursive: true, force: true })
  })

  function mockRes(): Response & { _json?: unknown; _status: number } {
    const res = {
      _status: 200,
      status(code: number) {
        this._status = code
        return this
      },
      json(body: unknown) {
        ;(this as { _json?: unknown })._json = body
        return this
      },
    }
    return res as unknown as Response & { _json?: unknown; _status: number }
  }

  it('reads a team room (resolves roomId from teamId) in seq order', () => {
    // Seed the sandboxed DB the handler opens via getDbPath().
    const db = createDb(getDbPath())
    postToRoom(db, {
      roomId: resolveRoomForTeam('tm-rest'),
      teamId: 'tm-rest',
      authorAgentId: 'a',
      body: 'hi',
    })
    postToRoom(db, {
      roomId: resolveRoomForTeam('tm-rest'),
      teamId: 'tm-rest',
      authorAgentId: 'b',
      body: 'yo',
    })
    const res = mockRes()
    teamChatGET({ query: { teamId: 'tm-rest' } } as unknown as Request, res)
    expect(res._status).toBe(200)
    const body = (res as { _json?: { roomId: string; posts: { body: string }[]; nextSeq: number } })
      ._json
    expect(body?.roomId).toBe(resolveRoomForTeam('tm-rest'))
    expect(body?.posts.map((p) => p.body)).toEqual(['hi', 'yo'])
    expect(body?.nextSeq).toBe(2)
  })

  it('400s when neither teamId nor roomId is supplied', () => {
    const res = mockRes()
    teamChatGET({ query: {} } as unknown as Request, res)
    expect(res._status).toBe(400)
  })

  // The explicit kickoff endpoint is wired + validates (the full engine run with
  // real adapters is covered by runTeamExchange.test.ts with injected fakes).
  const reqEx = (body: unknown): Request =>
    ({ body, get: () => undefined, protocol: 'http', on: () => undefined }) as unknown as Request

  it('POST /exchange 400s when teamId is missing', async () => {
    const res = mockRes()
    await teamChatExchangePOST(reqEx({}), res)
    expect(res._status).toBe(400)
  })

  it('POST /exchange 404s for an unknown team', async () => {
    const res = mockRes()
    await teamChatExchangePOST(reqEx({ teamId: 'no-such-team' }), res)
    expect(res._status).toBe(404)
  })

  it('POST /exchange 409s when an exchange is already running for the room', async () => {
    const roomId = resolveRoomForTeam('tm-busy')
    expect(tryAcquireRoom(roomId)).toBe(true) // simulate an in-flight exchange holding the room
    try {
      const res = mockRes()
      await teamChatExchangePOST(reqEx({ teamId: 'tm-busy' }), res)
      expect(res._status).toBe(409)
    } finally {
      releaseRoom(roomId)
    }
  })
})
