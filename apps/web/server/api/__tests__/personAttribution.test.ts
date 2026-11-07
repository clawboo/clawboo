// What a person did, recorded with who they are: board moves and comments, the
// approval history the dashboard reports, team chat and 1:1 chat messages.
//
// The person is `req.person`, which only the proxy identity lane sets, from a
// token it verified. A request without one records no name, and nothing in a
// request body can supply one.

import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { agents, approvalHistory, chatMessages, listEvents, taskComments } from '@clawboo/db'
import { eq } from 'drizzle-orm'
import type { Request, Response } from 'express'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../lib/agentChat/driveAgentChat', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/agentChat/driveAgentChat')>()
  return { ...actual, driveAgentChat: async () => undefined }
})

import { getDb, getDbPath, resetDb } from '../../lib/db'
import { persistTeamChatEntry } from '../../lib/teamChat/persistTeamChatEntry'
import { agentChatIngestPOST } from '../agentChat'
import { approvalsPOST } from '../approvals'
import { chatHistoryPOST } from '../chatHistory'
import { boardCommentPOST, boardCreatePOST, boardLinkDepPOST, boardUpdatePATCH } from '../board'

const ADA = { id: 'user-42', name: 'Ada', role: 'admin' }

function mockRes(): { res: Response; body: () => unknown; code: () => number } {
  let status = 200
  let payload: unknown
  const res = {
    status(c: number) {
      status = c
      return this
    },
    json(b: unknown) {
      payload = b
      return this
    },
  } as unknown as Response
  return { res, body: () => payload, code: () => status }
}

const req = (
  body: unknown,
  params: Record<string, string> = {},
  person: typeof ADA | null = null,
): Request =>
  // The dashboard's own page: these are a person's writes (see personCheck.test.ts).
  ({
    body,
    params,
    query: {},
    headers: { 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors' },
    person,
  }) as unknown as Request

function eventData(kind: string): Record<string, unknown>[] {
  return listEvents(getDb(), { limit: 1000 })
    .filter((e) => e.kind === kind)
    .map((e) => JSON.parse(e.data) as Record<string, unknown>)
}

let home: string
const prev: Record<string, string | undefined> = {}
beforeEach(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), 'clawboo-person-attribution-'))
  for (const name of ['HOME', 'CLAWBOO_HOME']) {
    prev[name] = process.env[name]
    process.env[name] = home
  }
  expect(getDbPath().startsWith(home)).toBe(true)
})
afterEach(async () => {
  resetDb()
  for (const [name, value] of Object.entries(prev)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  await rm(home, { recursive: true, force: true }).catch(() => {})
})

function createTask(title: string, person: typeof ADA | null): string {
  const r = mockRes()
  boardCreatePOST(req({ title, teamId: 'team-1' }, {}, person), r.res)
  return (r.body() as { task: { id: string } }).task.id
}

describe('task edits', () => {
  it("records the person on a task's creation, its moves and its links", () => {
    const a = createTask('Root', ADA)
    const b = createTask('Child', null)
    boardUpdatePATCH(req({ status: 'in_progress' }, { taskId: a }, ADA), mockRes().res)
    boardLinkDepPOST(req({ dependsOnTaskId: a }, { taskId: b }, ADA), mockRes().res)

    const created = eventData('task_created')
    expect(created.find((d) => d['title'] === 'Root')).toMatchObject({ person: ADA })
    expect(created.find((d) => d['title'] === 'Child')).not.toHaveProperty('person')
    expect(eventData('status_changed')).toEqual([
      { to: 'in_progress', by: 'person', actor: { kind: 'person' }, person: ADA },
    ])
    expect(eventData('dep_linked')).toEqual([
      { dependsOnTaskId: a, actor: { kind: 'person' }, person: ADA },
    ])
  })

  it('records no one on a move nothing vouched for', () => {
    const a = createTask('Root', null)
    boardUpdatePATCH(req({ status: 'in_progress' }, { taskId: a }), mockRes().res)
    expect(eventData('status_changed')).toEqual([
      { to: 'in_progress', by: 'person', actor: { kind: 'person' } },
    ])
  })
})

describe('task comments', () => {
  it('stores the person on the comment and its event', async () => {
    const a = createTask('Root', null)
    const r = mockRes()
    await boardCommentPOST(
      req({ body: 'looks good', authorType: 'agent' }, { taskId: a }, ADA),
      r.res,
    )
    const row = getDb().select().from(taskComments).where(eq(taskComments.taskId, a)).get()
    expect(JSON.parse(row?.person ?? 'null')).toEqual(ADA)
    expect(eventData('comment_added')[0]).toMatchObject({ person: ADA })
  })

  it('stores no one for a comment nothing vouched for', async () => {
    const a = createTask('Root', null)
    await boardCommentPOST(
      req({ body: 'hi', authorType: 'agent', person: ADA }, { taskId: a }),
      mockRes().res,
    )
    const row = getDb().select().from(taskComments).where(eq(taskComments.taskId, a)).get()
    expect(row?.person).toBeNull()
    expect(eventData('comment_added')[0]).not.toHaveProperty('person')
  })
})

describe('approval history the dashboard reports', () => {
  function seedAgent(id: string): void {
    const now = Date.now()
    getDb()
      .insert(agents)
      .values({ id, name: id, gatewayId: id, status: 'idle', createdAt: now, updatedAt: now })
      .run()
  }
  const details = (agentId: string) =>
    JSON.parse(
      getDb().select().from(approvalHistory).where(eq(approvalHistory.agentId, agentId)).get()
        ?.details ?? 'null',
    ) as Record<string, unknown> | null

  it('writes the verified person, and drops a resolvedBy the client sent', async () => {
    seedAgent('ag-1')
    seedAgent('ag-2')
    const claimed = { id: 'someone-else', name: 'Mallory', role: 'admin' }
    await approvalsPOST(
      req(
        { agentId: 'ag-1', action: 'deny', toolName: 'exec', details: { resolvedBy: claimed } },
        {},
        ADA,
      ),
      mockRes().res,
    )
    await approvalsPOST(
      req({
        agentId: 'ag-2',
        action: 'deny',
        toolName: 'exec',
        details: { resolvedBy: claimed, cmd: 'ls' },
      }),
      mockRes().res,
    )
    expect(details('ag-1')).toEqual({ resolvedBy: ADA })
    expect(details('ag-2')).toEqual({ cmd: 'ls' })
  })
})

describe('chat messages', () => {
  it('a team chat user entry carries the person', () => {
    persistTeamChatEntry(getDb(), {
      teamId: 'team-1',
      agentId: 'boo',
      text: 'ship it',
      role: 'user',
      kind: 'user',
      entryId: 'e-team',
      person: ADA,
    })
    persistTeamChatEntry(getDb(), {
      teamId: 'team-1',
      agentId: 'boo',
      text: 'and this',
      role: 'user',
      kind: 'user',
      entryId: 'e-team-anon',
    })
    const data = (entryId: string) =>
      JSON.parse(
        getDb().select().from(chatMessages).where(eq(chatMessages.entryId, entryId)).get()?.data ??
          'null',
      ) as Record<string, unknown>
    expect(data('e-team')).toMatchObject({ text: 'ship it', person: ADA })
    expect(data('e-team-anon')).not.toHaveProperty('person')
  })

  it('a 1:1 chat user entry carries the person, never one from the body', () => {
    const now = Date.now()
    getDb()
      .insert(agents)
      .values({
        id: 'n1',
        name: 'n1',
        gatewayId: 'n1',
        sourceId: 'clawboo-native',
        runtime: 'clawboo-native',
        status: 'idle',
        createdAt: now,
        updatedAt: now,
      })
      .run()
    const ingest = (body: Record<string, unknown>, person: typeof ADA | null) => {
      const r = mockRes()
      agentChatIngestPOST(req(body, { agentId: 'n1' }, person), r.res)
      expect(r.code()).toBe(202)
    }
    ingest({ message: 'hello', entryId: 'e-1' }, ADA)
    ingest({ message: 'again', entryId: 'e-2', person: ADA }, null)
    const data = (entryId: string) =>
      JSON.parse(
        getDb().select().from(chatMessages).where(eq(chatMessages.entryId, entryId)).get()?.data ??
          'null',
      ) as Record<string, unknown>
    expect(data('e-1')).toMatchObject({ text: 'hello', person: ADA })
    expect(data('e-2')).not.toHaveProperty('person')
  })

  it('drops a person from chat entries a client posts to /api/chat-history', async () => {
    const entry = {
      entryId: 'e-posted',
      role: 'user',
      kind: 'user',
      text: 'hi',
      sessionKey: 'agent:oc:main',
      runId: null,
      source: 'local-send',
      timestampMs: 1,
      sequenceKey: 1,
      confirmed: true,
      fingerprint: 'e-posted',
      person: { id: 'someone-else', name: 'Mallory', role: 'admin' },
    }
    const r = mockRes()
    await chatHistoryPOST(
      req({ sessionKey: 'agent:oc:main', gatewayUrl: '', entries: [entry] }, {}, ADA),
      r.res,
    )
    expect(r.body()).toMatchObject({ ok: true })
    const stored = JSON.parse(
      getDb().select().from(chatMessages).where(eq(chatMessages.entryId, 'e-posted')).get()?.data ??
        'null',
    ) as Record<string, unknown>
    expect(stored).toMatchObject({ text: 'hi' })
    expect(stored).not.toHaveProperty('person')
  })
})
