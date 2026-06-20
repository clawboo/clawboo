// Observability REST: the trace reconstructs, the graph projects, the harness-bug
// filter works, and the fleet-health triage returns. Seeds the event log directly
// via appendEvent (the db layer) and drives the handlers with mock req/res.
// Sandboxes $HOME.

import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { appendEvent, createDb, listEvents } from '@clawboo/db'
import type { Request, Response } from 'express'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { getDbPath } from '../../lib/db'
import {
  obsErrorsGET,
  obsEventsGET,
  obsGraphGET,
  obsHealthGET,
  obsIngestPOST,
  obsStreamGET,
  obsTraceGET,
} from '../obs'

function mockRes(): { res: Response; statusCode: () => number; body: () => unknown } {
  let code = 200
  let payload: unknown
  const res = {
    status(c: number) {
      code = c
      return this
    },
    json(b: unknown) {
      payload = b
      return this
    },
  } as unknown as Response
  return { res, statusCode: () => code, body: () => payload }
}
const req = (query: Record<string, string> = {}, params: Record<string, string> = {}): Request =>
  ({ query, params, body: {} }) as unknown as Request

/** A mock SSE req/res that captures writes + the close handler (so timers stop). */
function mockSse(query: Record<string, string> = {}): {
  req: Request
  res: Response
  writes: () => string
  close: () => void
} {
  const chunks: string[] = []
  let closeHandler: (() => void) | null = null
  const res = {
    writeHead() {
      return this
    },
    write(s: string) {
      chunks.push(s)
      return true
    },
    flushHeaders() {},
    on() {
      return this
    },
  } as unknown as Response
  const reqObj = {
    query,
    params: {},
    headers: {},
    on(ev: string, cb: () => void) {
      if (ev === 'close') closeHandler = cb
    },
  } as unknown as Request
  return { req: reqObj, res, writes: () => chunks.join(''), close: () => closeHandler?.() }
}

function seed(): void {
  const db = createDb(getDbPath())
  const now = Date.now()
  // A two-agent mission under trace tr1.
  appendEvent(db, {
    kind: 'task_created',
    taskId: 'root',
    teamId: 'team1',
    traceId: 'tr1',
    data: { title: 'mission', status: 'todo' },
  })
  appendEvent(db, {
    kind: 'task_claimed',
    taskId: 'root',
    teamId: 'team1',
    traceId: 'tr1',
    agentId: 'a1',
    data: { assigneeAgentId: 'a1' },
  })
  appendEvent(db, {
    kind: 'task_created',
    taskId: 'sub',
    teamId: 'team1',
    traceId: 'tr1',
    data: { title: 'subtask', parentTaskId: 'root' },
  })
  appendEvent(db, {
    kind: 'task_claimed',
    taskId: 'sub',
    teamId: 'team1',
    traceId: 'tr1',
    agentId: 'a2',
    data: { assigneeAgentId: 'a2' },
  })
  appendEvent(db, {
    kind: 'span_start',
    taskId: 'sub',
    teamId: 'team1',
    traceId: 'tr1',
    spanId: 's1',
    agentId: 'a2',
    data: { name: 'run', spanKind: 'task' },
  })
  appendEvent(db, {
    kind: 'execution_started',
    taskId: 'sub',
    teamId: 'team1',
    traceId: 'tr1',
    agentId: 'a2',
    ts: now,
    data: { execId: 'x1' },
  })
  appendEvent(db, {
    kind: 'tool_call',
    taskId: 'sub',
    teamId: 'team1',
    traceId: 'tr1',
    parentSpanId: 's1',
    agentId: 'a2',
    data: { toolCallId: 'tc', name: 'edit' },
  })
  appendEvent(db, {
    kind: 'cost',
    taskId: 'sub',
    teamId: 'team1',
    traceId: 'tr1',
    parentSpanId: 's1',
    agentId: 'a2',
    data: { costUsd: 0.1, inputTokens: 10, outputTokens: 5 },
  })
  appendEvent(db, {
    kind: 'error',
    taskId: 'sub',
    teamId: 'team1',
    traceId: 'tr1',
    agentId: 'a2',
    data: {
      code: null,
      message: 'the warp core breached',
      errorClass: 'Unknown',
      harnessBug: true,
    },
  })
  appendEvent(db, {
    kind: 'span_end',
    taskId: 'sub',
    teamId: 'team1',
    traceId: 'tr1',
    spanId: 's1',
    agentId: 'a2',
    data: { name: 'run', status: 'error' },
  })
}

describe('observability REST', () => {
  let home: string
  let prevHome: string | undefined

  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), 'clawboo-obs-rest-'))
    await mkdir(path.join(home, '.openclaw', 'clawboo'), { recursive: true })
    prevHome = process.env['HOME']
    process.env['HOME'] = home
  })
  afterEach(async () => {
    if (prevHome === undefined) delete process.env['HOME']
    else process.env['HOME'] = prevHome
    await rm(home, { recursive: true, force: true }).catch(() => {})
  })

  it('GET /api/obs/traces/:traceId reconstructs the full trace', () => {
    seed()
    const res = mockRes()
    obsTraceGET(req({}, { traceId: 'tr1' }), res.res)
    const body = res.body() as { traceId: string; events: { kind: string }[] }
    expect(body.traceId).toBe('tr1')
    const kinds = body.events.map((e) => e.kind)
    expect(kinds[0]).toBe('task_created')
    for (const k of ['span_start', 'tool_call', 'cost', 'error', 'span_end'])
      expect(kinds).toContain(k)
  })

  it('GET /api/obs/graph projects tasks + delegation edges', () => {
    seed()
    const res = mockRes()
    obsGraphGET(req({ teamId: 'team1' }), res.res)
    const g = res.body() as {
      tasks: { id: string }[]
      taskEdges: { source: string; target: string; kind: string }[]
      agentEdges: unknown[]
    }
    expect(g.tasks.map((t) => t.id).sort()).toEqual(['root', 'sub'])
    expect(g.taskEdges).toContainEqual(
      expect.objectContaining({ source: 'root', target: 'sub', kind: 'delegation' }),
    )
    expect(g.agentEdges).toContainEqual(expect.objectContaining({ source: 'a1', target: 'a2' }))
  })

  it('GET /api/obs/errors?harnessBug=true filters to harness bugs', () => {
    seed()
    const res = mockRes()
    obsErrorsGET(req({ harnessBug: 'true' }), res.res)
    const body = res.body() as {
      errors: { harnessBug: boolean; errorClass: string }[]
      harnessBugCount: number
    }
    expect(body.errors).toHaveLength(1)
    expect(body.errors[0]!.errorClass).toBe('Unknown')
    expect(body.harnessBugCount).toBe(1)
  })

  it('GET /api/obs/health returns the fleet triage', () => {
    seed()
    const res = mockRes()
    obsHealthGET(req({ teamId: 'team1' }), res.res)
    const body = res.body() as { agents: { agentId: string; status: string }[] }
    const a2 = body.agents.find((a) => a.agentId === 'a2')
    expect(a2).toBeTruthy()
    // a2 has an open execution (started, never completed) with a recent ts → working.
    expect(['working', 'stalled', 'zombie']).toContain(a2!.status)
  })

  it('GET /api/obs/events filters by agentId (the per-agent activity scope)', () => {
    seed()
    const res = mockRes()
    obsEventsGET(req({ agentId: 'a2' }), res.res)
    const body = res.body() as { events: { agentId: string }[] }
    expect(body.events.length).toBeGreaterThan(0)
    expect(body.events.every((e) => e.agentId === 'a2')).toBe(true)
  })

  it('serves unconditionally (200, never a feature-gated 404) — obs is always on', () => {
    seed()
    const res = mockRes()
    obsEventsGET(req({}), res.res)
    // No flag gate exists: the handler returns 200 with the event feed (a 404
    // here would mean a gate was reintroduced, contradicting the always-on docs).
    expect(res.statusCode()).toBe(200)
    expect((res.body() as { events: unknown[] }).events.length).toBeGreaterThan(0)
  })

  it('POST /api/obs/ingest persists the whitelisted runtime events', () => {
    const res = mockRes()
    const r = {
      query: {},
      params: {},
      body: {
        events: [
          { kind: 'tool_call', taskId: 'sub', agentId: 'a2', data: { name: 'edit' } },
          {
            kind: 'tool_result',
            taskId: 'sub',
            agentId: 'a2',
            data: { name: 'edit', output: 'ok', isError: false },
          },
          { kind: 'error', taskId: 'sub', agentId: 'a2', data: { message: 'boom', fatal: true } },
        ],
      },
    } as unknown as Request
    obsIngestPOST(r, res.res)
    expect((res.body() as { count: number }).count).toBe(3)
    const kinds = listEventsForTask('sub')
    for (const k of ['tool_call', 'tool_result', 'error']) expect(kinds).toContain(k)
  })

  it('POST /api/obs/ingest rejects non-runtime (board-lifecycle) kinds', () => {
    const res = mockRes()
    const r = {
      query: {},
      params: {},
      body: {
        events: [
          { kind: 'task_created', taskId: 'lc', data: {} },
          { kind: 'status_changed', taskId: 'lc', data: {} },
          { kind: 'tool_call', taskId: 'lc', data: { name: 'x' } },
        ],
      },
    } as unknown as Request
    obsIngestPOST(r, res.res)
    expect((res.body() as { count: number }).count).toBe(1) // only the tool_call
    expect(listEventsForTask('lc')).toEqual(['tool_call'])
  })

  it('GET /api/obs/stream writes the connected preamble + scoped events', () => {
    seed()
    const s = mockSse({ taskId: 'sub' })
    obsStreamGET(s.req, s.res)
    s.close() // stop the poll + keepalive intervals
    const out = s.writes()
    expect(out).toContain(': connected')
    expect(out).toContain('"kind":"tool_call"')
    expect(out).toMatch(/id: \d+/)
  })

  it('GET /api/obs/stream respects the since cursor (no backfill past it)', () => {
    seed()
    const s = mockSse({ taskId: 'sub', since: '999999999' })
    obsStreamGET(s.req, s.res)
    s.close()
    expect(s.writes()).not.toContain('data:')
  })
})

function listEventsForTask(taskId: string): string[] {
  return listEvents(createDb(getDbPath()), { taskId }).map((e) => e.kind)
}
