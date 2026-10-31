// The 1:1 chat routes, for every agent the server runs. The ingest must accept a
// Claude Code, Codex or Hermes agent (it used to 404 them, which left their page's
// message box with nowhere to send) and refuse an OpenClaw one, whose 1:1 chat is
// the Gateway's. The user turn and the stream both use the agent's own 1:1 key,
// the one the registry hands the browser, or the reply would land in a chat
// nobody is looking at. The turn itself is mocked: a real one would start a CLI.

import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { agents, chatMessages, type ClawbooDb } from '@clawboo/db'
import { eq } from 'drizzle-orm'

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

import { getDb, resetDb } from '../../lib/db'
import { agentChatIngestPOST, agentChatStreamGET } from '../agentChat'

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

describe('1:1 chat routes', () => {
  let home: string
  let prevHome: string | undefined
  let db: ClawbooDb

  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), 'clawboo-agentchat-route-'))
    prevHome = process.env['HOME']
    process.env['HOME'] = home
    db = getDb()
    driven.length = 0
  })
  afterEach(async () => {
    resetDb()
    if (prevHome === undefined) delete process.env['HOME']
    else process.env['HOME'] = prevHome
    await rm(home, { recursive: true, force: true })
  })

  function seedAgent(id: string, runtime: string): void {
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
        teamId: null,
        createdAt: now,
        updatedAt: now,
      })
      .run()
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
})
