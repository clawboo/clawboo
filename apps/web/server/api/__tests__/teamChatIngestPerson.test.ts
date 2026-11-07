// POST /api/teams/:id/chat hands the team engine the person a sign-in proxy
// vouched for (req.person, set only by the proxy identity lane), and never one
// a request body names. The engine's side, persisting it on the message, is
// covered in teamChat/__tests__/teamOrchestratorRoutineIngest.test.ts.

import {
  createDb,
  noteDelegationFailure,
  readDelegationFailure,
  teams,
  type ClawbooDb,
} from '@clawboo/db'
import type { Request, Response } from 'express'
import { beforeEach, describe, expect, it, vi } from 'vitest'

let db: ClawbooDb
const enqueued: Array<Record<string, unknown>> = []

vi.mock('../../lib/db', () => ({ getDb: () => db }))
vi.mock('../../lib/teamChat/resolveServerOrchestrated', () => ({
  resolveServerOrchestrated: () => true,
  serverOrchestratedSettingKey: (teamId: string) => `server-orchestrated:${teamId}`,
}))
vi.mock('../../lib/teamChat/teamOrchestrator', () => ({
  getTeamOrchestrator: () => ({
    enqueueUserMessage: async (input: Record<string, unknown>) => {
      enqueued.push(input)
      return { ok: true, targetAgentId: 'lead' }
    },
  }),
  hasTeamOrchestrator: () => false,
  isActiveTeamRoom: () => true,
}))

const { teamChatIngestPOST } = await import('../teams')

const ADA = { id: 'user-42', name: 'Ada', role: 'admin' }

function ingest(body: Record<string, unknown>, person: typeof ADA | null, teamId = 'T'): number {
  let status = 200
  const res = {
    status(c: number) {
      status = c
      return this
    },
    json() {
      return this
    },
  } as unknown as Response
  teamChatIngestPOST(
    { params: { id: teamId }, body, query: {}, headers: {}, person } as unknown as Request,
    res,
  )
  return status
}

beforeEach(() => {
  db = createDb(':memory:')
  enqueued.length = 0
  db.insert(teams)
    .values({ id: 'T', name: 'T', icon: 'x', color: '#000', createdAt: 1, updatedAt: 1 })
    .run()
})

describe('POST /api/teams/:id/chat', () => {
  it('builds no engine for a team that was deleted: a tab may still be open on it', () => {
    expect(ingest({ message: 'still there?' }, null, 'GONE')).toBe(404)
    expect(enqueued).toEqual([])
  })

  it('passes the verified person to the team engine with the message', () => {
    expect(ingest({ message: 'ship it' }, ADA)).toBe(202)
    expect(enqueued).toEqual([expect.objectContaining({ stimulus: 'ship it', person: ADA })])
  })

  it('passes no one when nothing vouched for the request, whatever the body says', () => {
    expect(ingest({ message: 'hi', person: ADA }, null)).toBe(202)
    expect(enqueued).toEqual([
      expect.objectContaining({ stimulus: 'hi', person: null, notFromPerson: true }),
    ])
  })

  it('marks a message only when no person is behind it', () => {
    expect(ingest({ message: 'hi', notFromPerson: true }, ADA)).toBe(202)
    expect(enqueued[0]).not.toHaveProperty('notFromPerson')
  })

  it("starts the team's failure breaker over: someone has looked, and try again must work", () => {
    noteDelegationFailure(db, 'T', 'a1', 'flaky')
    noteDelegationFailure(db, 'other', 'a1', 'flaky')
    expect(ingest({ message: 'try again' }, ADA)).toBe(202)
    expect(readDelegationFailure(db, 'T', 'a1', 'flaky').failures).toBe(0)
    expect(readDelegationFailure(db, 'other', 'a1', 'flaky').failures).toBe(1)
  })

  it('leaves the breaker alone for a caller: no person has looked', () => {
    noteDelegationFailure(db, 'T', 'a1', 'flaky')
    expect(ingest({ message: 'try again' }, null)).toBe(202)
    expect(readDelegationFailure(db, 'T', 'a1', 'flaky').failures).toBe(1)
    expect(enqueued).toEqual([expect.objectContaining({ stimulus: 'try again' })])
  })

  it('still delivers the message when the breaker cannot be cleared', () => {
    db.$client.exec('DROP TABLE delegation_failures')
    expect(ingest({ message: 'try again' }, ADA)).toBe(202)
    expect(enqueued).toEqual([expect.objectContaining({ stimulus: 'try again' })])
  })
})
