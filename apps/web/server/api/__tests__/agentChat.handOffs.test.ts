// What the 1:1 ingest hands a chat turn: the team named with @Team, the person's own
// words, and who sent it. The turn itself is tested in chatHandOffs.test.ts; this pins
// the route's half, which nothing else would notice being dropped.

import { readdirSync, readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { agents, LOCAL_PERSON } from '@clawboo/db'
import type { Request, Response } from 'express'

const { runChatTurn, stopChatTurn } = vi.hoisted(() => ({
  runChatTurn: vi.fn(async () => undefined),
  stopChatTurn: vi.fn(async () => undefined),
}))

vi.mock('../../lib/agentChat/chatHandOffs', () => ({
  runChatTurn,
  stopChatTurn,
  chatHandOffFrames: () => [],
  chatHandsOff: () => false,
}))

const { agentChatIngestPOST, agentChatStopPOST } = await import('../agentChat')
const { getDb, getDbPath, resetDb } = await import('../../lib/db')

/** What each turn was handed, without the database, which is too big to print. */
function turns(): Array<Record<string, unknown>> {
  return (runChatTurn.mock.calls as unknown as Array<[Record<string, unknown>]>).map(
    ([{ agentId, message, namedTeamId, words, requestedBy, messageId }]) => ({
      agentId,
      message,
      namedTeamId,
      words,
      requestedBy,
      messageId,
    }),
  )
}

function post(
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
  person?: { id: string; name: string | null; role: string | null },
) {
  const res = { status: vi.fn().mockReturnThis(), json: vi.fn() }
  agentChatIngestPOST(
    {
      params: { agentId: 'bz' },
      body,
      headers,
      socket: { localPort: 18790 },
      ...(person ? { person } : {}),
    } as unknown as Request,
    res as unknown as Response,
  )
  return res
}

describe('POST /api/agents/:agentId/chat hands the turn what hand-offs need', () => {
  let home: string
  const prev: Record<string, string | undefined> = {}

  beforeEach(async () => {
    runChatTurn.mockClear()
    home = await mkdtemp(path.join(os.tmpdir(), 'clawboo-chat-ingest-'))
    for (const k of ['HOME', 'CLAWBOO_HOME']) prev[k] = process.env[k]
    process.env['HOME'] = home
    process.env['CLAWBOO_HOME'] = path.join(home, '.clawboo')
    resetDb()
    expect(getDbPath().startsWith(home)).toBe(true)
    const now = Date.now()
    getDb()
      .insert(agents)
      .values({
        id: 'bz',
        name: 'Boo Zero',
        gatewayId: 'bz',
        sourceId: 'codex',
        runtime: 'codex',
        createdAt: now,
        updatedAt: now,
      })
      .run()
  })
  afterEach(async () => {
    resetDb()
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    await rm(home, { recursive: true, force: true })
  })

  it('the team named with @Team, and the words the person wrote', () => {
    const res = post({
      message: 'rules\n\nfix it',
      displayText: '@Growth fix it',
      teamId: 'team-1',
      entryId: 'entry-1',
    })

    expect(res.status).toHaveBeenCalledWith(202)
    expect(turns()).toEqual([
      {
        agentId: 'bz',
        message: 'rules\n\nfix it',
        namedTeamId: 'team-1',
        words: '@Growth fix it',
        requestedBy: null,
        messageId: 'entry-1',
      },
    ])
  })

  it('the message id, which makes one main task per team across a retry of it', () => {
    post({ message: 'fix it', entryId: 'entry-1' })
    post({ message: 'fix it', entryId: 'entry-1' })

    expect(turns().map((t) => t['messageId'])).toEqual(['entry-1', 'entry-1'])
  })

  it('who asked, from the dashboard: the local person', () => {
    post({ message: 'fix it' }, { 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors' })
    expect(turns()[0]!['requestedBy']).toMatchObject({ id: LOCAL_PERSON.id })
  })

  it('who asked, through a sign-in proxy: the person it vouched for', () => {
    const person = { id: 'alex', name: 'Alex', role: null }
    post({ message: 'fix it' }, {}, person)
    expect(turns()[0]!['requestedBy']).toEqual(person)
  })

  it('only the person check reads the dashboard: no route asks it directly', () => {
    const server = path.resolve(__dirname, '../..')
    const callers = readdirSync(server, { recursive: true, encoding: 'utf8' })
      .filter((f) => f.endsWith('.ts') && !f.includes('__tests__'))
      .filter((f) => readFileSync(path.join(server, f), 'utf8').includes('isDashboardRequest'))
    expect(callers.map((f) => f.split(path.sep).pop()).sort()).toEqual([
      'auth.ts',
      'dashboardRequest.ts',
    ])
  })

  it('no team when none was named, or the field is not a string', () => {
    post({ message: 'fix it' })
    post({ message: 'fix it', teamId: 7 })

    expect(turns().map((t) => t['namedTeamId'])).toEqual([null, null])
  })

  it('who sent it: nobody it can vouch for from outside the dashboard', () => {
    post({ message: 'fix it' })
    expect(turns()[0]!['requestedBy']).toBeNull()
  })

  it("Stop goes through the chat's own stop, which holds what comes after it", async () => {
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() }
    await agentChatStopPOST(
      { params: { agentId: 'bz' } } as unknown as Request,
      res as unknown as Response,
    )
    expect(stopChatTurn).toHaveBeenCalledTimes(1)
    expect((stopChatTurn.mock.calls as unknown as Array<[unknown, string]>)[0]![1]).toBe('bz')
  })
})
