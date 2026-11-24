// The 1:1 chat routes, for every agent the server runs. The ingest must accept a
// Claude Code, Codex or Hermes agent (it used to 404 them, which left their page's
// message box with nowhere to send) and refuse an OpenClaw one, whose 1:1 chat is
// the Gateway's. The user turn and the stream both use the agent's own 1:1 key,
// the one the registry hands the browser, or the reply would land in a chat
// nobody is looking at. A message id starts one turn, ever: the same id sent again
// starts none, and an id another chat holds is refused. The heads read gives each
// chat's newest row id, where its stream picks up. The turn itself is mocked: a
// real one would start a CLI.

import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { agents, chatMessages, latestChatMessageId, teams, type ClawbooDb } from '@clawboo/db'
import { eq } from 'drizzle-orm'
import express from 'express'

const driven = vi.hoisted(() => [] as Array<{ agentId: string; message: string }>)

vi.mock('../../lib/agentChat/driveAgentChat', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/agentChat/driveAgentChat')>()
  return {
    ...actual,
    driveAgentChat: async (p: { agentId: string; message: string }) => {
      driven.push({ agentId: p.agentId, message: p.message })
    },
  }
})

import { getDb, getDbPath, resetDb } from '../../lib/db'
import type { RoleScope } from '../../lib/roles/guard'
import { agentChatHeadsGET, agentChatIngestPOST, agentChatStreamGET } from '../agentChat'

type Res = {
  statusCode: number
  body: unknown
  status: (c: number) => Res
  json: (b: unknown) => Res
}

function makeRes(): Res {
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

function ingest(agentId: string, body: Record<string, unknown>): Res {
  const res = makeRes()
  agentChatIngestPOST(
    { params: { agentId }, body, headers: {} } as unknown as Parameters<
      typeof agentChatIngestPOST
    >[0],
    res as unknown as Parameters<typeof agentChatIngestPOST>[1],
  )
  return res
}

function heads(query: Record<string, unknown>, roleScope?: RoleScope): Res {
  const res = makeRes()
  agentChatHeadsGET(
    { query, headers: {}, ...(roleScope ? { roleScope } : {}) } as unknown as Parameters<
      typeof agentChatHeadsGET
    >[0],
    res as unknown as Parameters<typeof agentChatHeadsGET>[1],
  )
  return res
}

/** The stored rows the stream sends from `since`, as their texts. */
function streamTexts(agentId: string, since: number): string[] {
  const written: string[] = []
  const closers: Array<() => void> = []
  const req = {
    params: { agentId },
    query: { since: String(since) },
    headers: {},
    on: (ev: string, fn: () => void) => {
      if (ev === 'close') closers.push(fn)
    },
  }
  const res = {
    writeHead: () => res,
    write: (chunk: string) => {
      written.push(chunk)
      return true
    },
    flushHeaders: () => undefined,
    on: (ev: string, fn: () => void) => {
      if (ev === 'close') closers.push(fn)
    },
  }
  agentChatStreamGET(
    req as unknown as Parameters<typeof agentChatStreamGET>[0],
    res as unknown as Parameters<typeof agentChatStreamGET>[1],
  )
  for (const close of closers) close()
  return written
    .filter((chunk) => chunk.startsWith('data: {') && chunk.includes('"text"'))
    .map((chunk) => (JSON.parse(chunk.slice('data: '.length)) as { text: string }).text)
}

describe('1:1 chat routes', () => {
  let home: string
  const prev: Record<string, string | undefined> = {}
  let db: ClawbooDb

  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), 'clawboo-agentchat-route-'))
    for (const k of ['HOME', 'CLAWBOO_HOME']) prev[k] = process.env[k]
    process.env['HOME'] = home
    process.env['CLAWBOO_HOME'] = path.join(home, '.clawboo')
    resetDb()
    expect(getDbPath().startsWith(home)).toBe(true)
    db = getDb()
    driven.length = 0
  })
  afterEach(async () => {
    vi.restoreAllMocks()
    resetDb()
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    await rm(home, { recursive: true, force: true })
  })

  function seedAgent(
    id: string,
    runtime: string,
    opts: { teamId?: string | null; archivedAt?: number } = {},
  ): void {
    const now = Date.now()
    db.insert(agents)
      .values({
        id,
        name: id,
        gatewayId: id,
        sourceId: runtime,
        sourceAgentId: id,
        runtime,
        status: 'idle',
        teamId: opts.teamId ?? null,
        ...(opts.archivedAt ? { archivedAt: opts.archivedAt } : {}),
        createdAt: now,
        updatedAt: now,
      })
      .run()
  }

  /** A stored row in a chat, as a reply would be. */
  function seedRow(sessionKey: string, entryId: string, text = entryId): number {
    return Number(
      db
        .insert(chatMessages)
        .values({
          sessionKey,
          gatewayUrl: 'native',
          entryId,
          timestampMs: 1,
          data: JSON.stringify({ entryId, sessionKey, text }),
        })
        .run().lastInsertRowid,
    )
  }

  function texts(sessionKey: string): string[] {
    return db
      .select()
      .from(chatMessages)
      .where(eq(chatMessages.sessionKey, sessionKey))
      .all()
      .map((r) => (JSON.parse(r.data as string) as { text: string }).text)
  }

  it.each(['claude-code', 'codex', 'hermes'])(
    'accepts a %s agent and stores the turn under its own 1:1 key',
    (runtime) => {
      seedAgent('a1', runtime)
      const res = ingest('a1', { message: 'hello', entryId: 'e-1' })
      expect(res.statusCode).toBe(202)
      expect(texts(`agent:a1:${runtime}`)).toEqual(['hello'])
      expect(texts('agent:a1:native')).toEqual([])
      expect(driven).toEqual([{ agentId: 'a1', message: 'hello' }])
    },
  )

  it('keeps a native agent on its historical key', () => {
    seedAgent('n1', 'clawboo-native')
    expect(ingest('n1', { message: 'hi' }).statusCode).toBe(202)
    expect(texts('agent:n1:native')).toEqual(['hi'])
  })

  it('refuses an OpenClaw agent, whose 1:1 chat is the Gateway', () => {
    seedAgent('oc', 'openclaw')
    expect(ingest('oc', { message: 'hi' }).statusCode).toBe(404)
    expect(driven).toEqual([])
  })

  it("streams the agent's own 1:1 key", () => {
    seedAgent('cc', 'claude-code')
    for (const sessionKey of ['agent:cc:claude-code', 'agent:cc:native']) {
      db.insert(chatMessages)
        .values({
          sessionKey,
          gatewayUrl: 'native',
          entryId: `row-${sessionKey}`,
          timestampMs: 1,
          data: JSON.stringify({ entryId: `row-${sessionKey}`, sessionKey, text: sessionKey }),
        })
        .run()
    }

    const written: string[] = []
    const closers: Array<() => void> = []
    const req = {
      params: { agentId: 'cc' },
      query: { since: '0' },
      headers: {},
      on: (ev: string, fn: () => void) => {
        if (ev === 'close') closers.push(fn)
      },
    }
    const res = {
      writeHead: () => res,
      write: (chunk: string) => {
        written.push(chunk)
        return true
      },
      flushHeaders: () => undefined,
      on: (ev: string, fn: () => void) => {
        if (ev === 'close') closers.push(fn)
      },
    }
    agentChatStreamGET(
      req as unknown as Parameters<typeof agentChatStreamGET>[0],
      res as unknown as Parameters<typeof agentChatStreamGET>[1],
    )
    for (const close of closers) close()

    const out = written.join('')
    expect(out).toContain('"text":"agent:cc:claude-code"')
    expect(out).not.toContain('"text":"agent:cc:native"')
  })

  describe('one turn per message id', () => {
    it('answers with the id, and the same id sent again starts no second turn', () => {
      seedAgent('a1', 'codex')
      const first = ingest('a1', { message: 'hello', entryId: 'e-1' })
      expect(first.statusCode).toBe(202)
      expect(first.body).toEqual({ ok: true, entryId: 'e-1' })

      const again = ingest('a1', { message: 'hello', entryId: 'e-1' })
      expect(again.statusCode).toBe(202)
      expect(again.body).toEqual({ ok: true, entryId: 'e-1', duplicate: true })
      expect(driven).toHaveLength(1)
      expect(texts('agent:a1:codex')).toEqual(['hello'])
    })

    it('refuses an id another chat holds, and starts no turn', () => {
      seedAgent('a1', 'codex')
      seedAgent('a2', 'hermes')
      expect(ingest('a2', { message: 'theirs', entryId: 'e-shared' }).statusCode).toBe(202)
      driven.length = 0

      const res = ingest('a1', { message: 'mine', entryId: 'e-shared' })
      expect(res.statusCode).toBe(409)
      expect(res.body).toEqual({ error: 'entry_id_in_use' })
      expect(driven).toEqual([])
      expect(texts('agent:a1:codex')).toEqual([])
      expect(texts('agent:a2:hermes')).toEqual(['theirs'])
    })

    it('makes an id when none is sent, returns it, and never reads its own id as a repeat', () => {
      seedAgent('a1', 'codex')
      seedAgent('a2', 'hermes')
      // Two messages in one millisecond, in two chats: the ids are unique across both.
      vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000)
      const one = ingest('a1', { message: 'first' })
      const two = ingest('a2', { message: 'second' })
      const three = ingest('a1', { message: 'third' })
      for (const res of [one, two, three]) expect(res.statusCode).toBe(202)
      const ids = [one, two, three].map((res) => (res.body as { entryId: string }).entryId)
      expect(ids[0]).toBe('user-1800000000000')
      expect(new Set(ids).size).toBe(3)
      for (const res of [one, two, three]) expect(res.body).not.toHaveProperty('duplicate')
      expect(driven).toHaveLength(3)
      expect(texts('agent:a1:codex')).toEqual(['first', 'third'])
      expect(texts('agent:a2:hermes')).toEqual(['second'])
    })

    it('runs the turn when the message could not be stored, as it always has', () => {
      seedAgent('a1', 'codex')
      vi.spyOn(db, 'insert').mockImplementationOnce(() => {
        throw new Error('disk I/O error')
      })
      const res = ingest('a1', { message: 'hello', entryId: 'e-1' })
      expect(res.statusCode).toBe(202)
      expect(res.body).toEqual({ ok: true, entryId: 'e-1' })
      expect(driven).toHaveLength(1)
    })

    it('two requests with one id at the same time start exactly one turn', async () => {
      seedAgent('a1', 'codex')
      const app = express()
      app.use(express.json())
      app.post('/api/agents/:agentId/chat', agentChatIngestPOST)
      const server = app.listen(0, '127.0.0.1')
      await once(server, 'listening')
      try {
        const { port } = server.address() as AddressInfo
        const post = async (): Promise<{ status: number; body: Record<string, unknown> }> => {
          const r = await fetch(`http://127.0.0.1:${port}/api/agents/a1/chat`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ message: 'hello', entryId: 'e-race' }),
          })
          return { status: r.status, body: (await r.json()) as Record<string, unknown> }
        }
        const answers = await Promise.all([post(), post(), post()])
        expect(answers.map((a) => a.status)).toEqual([202, 202, 202])
        expect(answers.filter((a) => a.body['duplicate'] === true)).toHaveLength(2)
        expect(driven).toHaveLength(1)
        expect(texts('agent:a1:codex')).toEqual(['hello'])
      } finally {
        server.close()
        await once(server, 'close')
      }
    })
  })

  describe('chat heads', () => {
    beforeEach(() => {
      seedAgent('cc', 'claude-code')
      seedAgent('nat', 'clawboo-native')
      seedAgent('quiet', 'hermes')
      seedAgent('oc', 'openclaw')
      seedAgent('gone', 'codex', { archivedAt: 1 })
      seedRow('agent:cc:claude-code', 'cc-1')
      seedRow('agent:nat:native', 'nat-1')
      seedRow('agent:cc:claude-code', 'cc-2')
      seedRow('agent:oc:main', 'oc-1')
    })

    it('gives each named server-run chat its newest row id, the head its stream uses', () => {
      const res = heads({ agents: 'cc,nat,quiet,oc,missing' })
      expect(res.statusCode).toBe(200)
      expect(res.body).toEqual({
        heads: {
          cc: latestChatMessageId(db, ['agent:cc:claude-code']),
          nat: latestChatMessageId(db, ['agent:nat:native']),
          quiet: 0,
        },
      })
      expect((res.body as { heads: Record<string, number> }).heads['cc']).toBeGreaterThan(0)
    })

    it('with no list, gives every server-run chat whose agent is not archived', () => {
      const res = heads({})
      expect(Object.keys((res.body as { heads: object }).heads).sort()).toEqual([
        'cc',
        'nat',
        'quiet',
      ])
      // Named, an archived agent's chat still reads.
      expect(heads({ agents: 'gone' }).body).toEqual({ heads: { gone: 0 } })
      expect(heads({ agents: '' }).body).toEqual({ heads: {} })
    })

    it('a stream from the head sends exactly what comes after it', () => {
      const head = (heads({ agents: 'cc' }).body as { heads: Record<string, number> }).heads['cc']!
      expect(streamTexts('cc', head)).toEqual([])
      seedRow('agent:cc:claude-code', 'cc-3', 'after the head')
      seedRow('agent:nat:native', 'nat-2', 'another chat')
      expect(streamTexts('cc', head)).toEqual(['after the head'])
    })

    it('keeps a guest to the chats of their own teams', () => {
      db.insert(teams)
        .values({ id: 't1', name: 't1', icon: 'x', color: '#000', createdAt: 0, updatedAt: 0 })
        .run()
      db.update(agents).set({ teamId: 't1' }).where(eq(agents.id, 'cc')).run()
      expect(heads({}, { teams: new Set(['t1']) }).body).toEqual({
        heads: { cc: latestChatMessageId(db, ['agent:cc:claude-code']) },
      })
    })

    it('refuses a list too long, an id it cannot be, and a repeated list', () => {
      const many = Array.from({ length: 201 }, (_, i) => `a${i}`).join(',')
      expect(heads({ agents: many }).statusCode).toBe(400)
      expect(heads({ agents: many }).body).toEqual({ error: 'too_many_agents', max: 200 })
      expect(
        heads({ agents: Array.from({ length: 200 }, (_, i) => `a${i}`).join(',') }).statusCode,
      ).toBe(200)
      expect(heads({ agents: 'cc,../etc' }).body).toEqual({ error: 'invalid_agent_id' })
      expect(heads({ agents: ['cc', 'nat'] }).body).toEqual({ error: 'invalid_agents' })
    })
  })
})
