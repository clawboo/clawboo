// Observability REST: the trace reconstructs, the graph projects, the harness-bug
// filter works, and the fleet-health triage returns. Seeds the event log directly
// via appendEvent (the db layer) and drives the handlers with mock req/res.
// Sandboxes $HOME.

import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { agents, appendEvent, createApproval, resolveApproval, teams } from '@clawboo/db'
import type { Request, Response } from 'express'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { getDb, resetDb } from '../../lib/db'
import {
  DASHBOARD_EVENT_WINDOW,
  obsErrorsGET,
  obsEventsGET,
  obsGraphGET,
  obsHealthGET,
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
function mockSse(
  query: Record<string, string> = {},
  headers: Record<string, string> = {},
): {
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
    headers,
    on(ev: string, cb: () => void) {
      if (ev === 'close') closeHandler = cb
    },
  } as unknown as Request
  return { req: reqObj, res, writes: () => chunks.join(''), close: () => closeHandler?.() }
}

interface StreamFrame {
  id: number
  row: {
    seq: number
    kind: string
    agentId: string | null
    teamId: string | null
    taskId: string | null
    data: string
  }
}

/** The `id:` + `data:` event frames in a captured stream, comments skipped. */
function frames(out: string): StreamFrame[] {
  return out
    .split('\n\n')
    .filter((block) => block.startsWith('id: '))
    .map((block) => {
      const [idLine, dataLine] = block.split('\n')
      return {
        id: Number(idLine!.slice('id: '.length)),
        row: JSON.parse(dataLine!.slice('data: '.length)) as StreamFrame['row'],
      }
    })
}

function seed(): void {
  const db = getDb()
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
  let prevClawbooHome: string | undefined

  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), 'clawboo-obs-rest-'))
    await mkdir(path.join(home, '.openclaw', 'clawboo'), { recursive: true })
    await mkdir(path.join(home, '.clawboo'), { recursive: true })
    prevHome = process.env['HOME']
    // `resolveClawbooDir` reads CLAWBOO_HOME BEFORE falling back to $HOME, so
    // sandboxing $HOME alone leaves the suite writing into a developer's real
    // database whenever that supported override happens to be exported.
    prevClawbooHome = process.env['CLAWBOO_HOME']
    process.env['HOME'] = home
    process.env['CLAWBOO_HOME'] = path.join(home, '.clawboo')
  })
  afterEach(async () => {
    // Close BEFORE removing the dir: Windows refuses to remove a directory
    // that still holds an open file. (#140)
    resetDb()
    if (prevHome === undefined) delete process.env['HOME']
    else process.env['HOME'] = prevHome
    if (prevClawbooHome === undefined) delete process.env['CLAWBOO_HOME']
    else process.env['CLAWBOO_HOME'] = prevClawbooHome
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

  it('GET /api/obs/errors orders by ts (index-backed) and still reads newest-first', () => {
    const db = getDb()
    for (const [taskId, ts] of [
      ['old', 1_000],
      ['newest', 9_000],
      ['mid', 5_000],
    ] as const) {
      appendEvent(db, {
        kind: 'error',
        taskId,
        agentId: 'a1',
        ts,
        data: { message: taskId, errorClass: 'Timeout', harnessBug: false },
      })
    }
    const res = mockRes()
    obsErrorsGET(req({}), res.res)
    const body = res.body() as { errors: { taskId: string }[] }
    expect(body.errors.map((e) => e.taskId)).toEqual(['newest', 'mid', 'old'])
  })

  it('GET /api/obs/events clamps limit (a negative one must not drain the table)', () => {
    seed()
    const res = mockRes()
    // SQLite reads a NEGATIVE limit as UNBOUNDED, so forwarding this raw let one
    // request pull every row of a never-pruned table on the synchronous
    // connection that also serves the event loop.
    obsEventsGET(req({ limit: '-1' }), res.res)
    expect(res.statusCode()).toBe(200)
    const body = res.body() as { events: unknown[] }
    expect(body.events.length).toBeGreaterThan(0)
    expect(body.events.length).toBeLessThanOrEqual(DASHBOARD_EVENT_WINDOW)

    const capped = mockRes()
    obsEventsGET(req({ limit: '2' }), capped.res)
    expect((capped.body() as { events: unknown[] }).events).toHaveLength(2)
  })

  // ── The dashboard read window ─────────────────────────────────────────────
  // Both dashboards fold a WINDOW of an append-only, never-pruned log. Two
  // independent things have to hold, so they get independent tests:
  //   • the window is the NEWEST rows (an ASC `limit` silently pins both views
  //     to the oldest N events forever, the bug these guard against), and
  //   • the window is folded CHRONOLOGICALLY (the reducers are order-sensitive,
  //     so the descending read has to be reversed before projecting).
  describe('dashboard read window', () => {
    /** Fill the window with old events so a later one falls outside an ASC read. */
    function seedFiller(count: number, teamId: string): void {
      const db = getDb()
      for (let i = 0; i < count; i += 1) {
        appendEvent(db, {
          kind: 'tool_call',
          teamId,
          taskId: 'ancient-task',
          agentId: 'ancient-agent',
          data: { toolCallId: `tc-${i}`, name: 'noop' },
        })
      }
    }

    it('GET /api/obs/health reflects activity past the window (never freezes)', () => {
      // Oldest: far enough back that the newest-N window must evict it.
      appendEvent(getDb(), {
        kind: 'execution_started',
        teamId: 'teamW',
        taskId: 'ancient-task',
        agentId: 'evicted-agent',
        data: { execId: 'x-ancient' },
      })
      seedFiller(DASHBOARD_EVENT_WINDOW, 'teamW')
      // Newest: fresh activity arriving AFTER the window is already full. An ASC
      // read cannot see it, so fleet health would report the fleet as it was.
      appendEvent(getDb(), {
        kind: 'execution_started',
        teamId: 'teamW',
        taskId: 'fresh-task',
        agentId: 'fresh-agent',
        ts: Date.now(),
        data: { execId: 'x-fresh' },
      })

      const res = mockRes()
      obsHealthGET(req({ teamId: 'teamW' }), res.res)
      const body = res.body() as { agents: { agentId: string; status: string }[] }
      const ids = body.agents.map((a) => a.agentId)
      expect(ids, 'the newest agent must fall inside the window').toContain('fresh-agent')
      // Pins the FAR edge too. Without this the assertions above hold for any
      // limit >= 2, so DASHBOARD_EVENT_WINDOW would not actually be constrained.
      expect(ids, 'an agent older than the window must be evicted').not.toContain('evicted-agent')
      expect(body.agents.find((a) => a.agentId === 'fresh-agent')!.status).toBe('working')
    })

    it('GET /api/obs/graph reflects tasks created past the window (never freezes)', () => {
      seedFiller(DASHBOARD_EVENT_WINDOW, 'teamW')
      const db = getDb()
      appendEvent(db, {
        kind: 'task_created',
        teamId: 'teamW',
        taskId: 'fresh-task',
        data: { title: 'fresh', status: 'todo' },
      })
      appendEvent(db, {
        kind: 'task_claimed',
        teamId: 'teamW',
        taskId: 'fresh-task',
        agentId: 'fresh-agent',
        data: { assigneeAgentId: 'fresh-agent' },
      })

      const res = mockRes()
      obsGraphGET(req({ teamId: 'teamW' }), res.res)
      const g = res.body() as { tasks: { id: string; title: string | null; status: string }[] }
      const fresh = g.tasks.find((t) => t.id === 'fresh-task')
      expect(fresh, 'the newest task must fall inside the window').toBeTruthy()
      expect(fresh!.title).toBe('fresh')
      expect(fresh!.status).toBe('in_progress')
    })

    it('GET /api/obs/graph folds chronologically and stays scoped to the team', () => {
      const db = getDb()
      // A task on ANOTHER team must never leak in. Without this, dropping the
      // teamId filter from the shared helper would pass every other test here,
      // because each one seeds a single team.
      appendEvent(db, {
        kind: 'task_created',
        teamId: 'teamOther',
        taskId: 'foreign',
        data: { title: 'foreign', status: 'todo' },
      })
      appendEvent(db, {
        kind: 'task_created',
        teamId: 'teamO',
        taskId: 't1',
        data: { title: 'ordered', status: 'todo' },
      })
      appendEvent(db, {
        kind: 'task_claimed',
        teamId: 'teamO',
        taskId: 't1',
        agentId: 'a1',
        data: { assigneeAgentId: 'a1' },
      })
      appendEvent(db, {
        kind: 'status_changed',
        teamId: 'teamO',
        taskId: 't1',
        data: { from: 'in_progress', to: 'done' },
      })

      const res = mockRes()
      obsGraphGET(req({ teamId: 'teamO' }), res.res)
      const g = res.body() as { tasks: { id: string; status: string }[] }
      expect(
        g.tasks.map((t) => t.id),
        'another team must not leak in',
      ).not.toContain('foreign')
      // Status is last-write-wins, so the fold direction is directly observable:
      // chronological ends at `done`; a newest-first fold would end at `todo`
      // (the earliest event applied last).
      expect(g.tasks.find((t) => t.id === 't1')!.status).toBe('done')
    })

    it('GET /api/obs/health pairs execution start/complete in chronological order', () => {
      const db = getDb()
      appendEvent(db, {
        kind: 'execution_started',
        teamId: 'teamO',
        taskId: 't1',
        agentId: 'a1',
        data: { execId: 'x1' },
      })
      appendEvent(db, {
        kind: 'execution_completed',
        teamId: 'teamO',
        taskId: 't1',
        agentId: 'a1',
        data: { execId: 'x1', status: 'succeeded' },
      })

      const res = mockRes()
      obsHealthGET(req({ teamId: 'teamO' }), res.res)
      const body = res.body() as { agents: { agentId: string; status: string }[] }
      // The execution closed, so the agent is idle. Folded newest-first the
      // completion would be seen first (clamped to 0) and the start would leave
      // the counter open, reporting a finished agent as still `working`.
      expect(body.agents.find((a) => a.agentId === 'a1')!.status).toBe('idle')
    })
  })

  // ─── The approval lifecycle on the stream ──────────────────────────────────
  // What a client that stops polling the approval queue relies on: the desktop's
  // notifier and mirror, a link sidecar, a phone's push trigger. The events come
  // from the real approval writers in @clawboo/db, not from seeded rows.
  describe('GET /api/obs/stream: approval events', () => {
    const SECRET = 'quarterly-layoffs-draft.txt'
    const APPROVAL_KINDS = 'approval_requested,approval_resolved'

    beforeEach(() => {
      const db = getDb()
      const now = Date.now()
      db.insert(teams)
        .values({
          id: 'team-A',
          name: 'Ops',
          icon: 'x',
          color: '#000',
          createdAt: now,
          updatedAt: now,
        })
        .run()
      db.insert(agents)
        .values({
          id: 'boo-A',
          name: 'Boo',
          gatewayId: 'boo-A',
          status: 'idle',
          teamId: 'team-A',
          createdAt: now,
          updatedAt: now,
        })
        .run()
    })
    afterEach(() => {
      vi.useRealTimers()
    })

    const ask = () =>
      createApproval(getDb(), {
        toolName: 'files_delete',
        agentId: 'boo-A',
        args: { path: SECRET },
        reason: `wants to delete ${SECRET}`,
        taskId: 'task-9',
      })

    /** Unrelated traffic from the same agent, the kind a narrowed client skips. */
    const chatter = (n: number): void => {
      for (let i = 0; i < n; i++)
        appendEvent(getDb(), {
          kind: 'tool_call',
          agentId: 'boo-A',
          teamId: 'team-A',
          data: { toolCallId: `tc-${i}`, name: 'read_file' },
        })
    }

    /** The newest `seq`: the cursor a client takes to watch only new events. */
    const head = (): number => {
      const res = mockRes()
      obsEventsGET(req({ order: 'desc', limit: '1' }), res.res)
      return (res.body() as { events: { seq: number }[] }).events[0]?.seq ?? 0
    }

    const open = (query: Record<string, string> = {}, headers: Record<string, string> = {}) => {
      const s = mockSse(query, headers)
      obsStreamGET(s.req, s.res)
      return s
    }

    const kindsOf = (out: string): string[] => frames(out).map((f) => f.row.kind)

    it('delivers both events live to an unscoped client, in order, with the agent and team', () => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
      seed() // history from before the client connected, which it does not ask for
      const s = open({ since: String(head()) })
      expect(frames(s.writes())).toEqual([])

      const a = ask()
      vi.advanceTimersByTime(750)
      expect(kindsOf(s.writes())).toEqual(['approval_requested'])
      resolveApproval(getDb(), a.id, 'allow_once')
      vi.advanceTimersByTime(750)
      s.close()

      const got = frames(s.writes())
      expect(got.map((f) => f.row.kind)).toEqual(['approval_requested', 'approval_resolved'])
      expect(got[0]!.id).toBeLessThan(got[1]!.id)
      for (const f of got) {
        expect(f.id).toBe(f.row.seq)
        expect(f.row).toMatchObject({ agentId: 'boo-A', teamId: 'team-A', taskId: 'task-9' })
        expect(JSON.parse(f.row.data)).toMatchObject({
          approvalId: a.id,
          kind: 'tool',
          toolName: 'files_delete',
        })
      }
      expect(JSON.parse(got[1]!.row.data)).toMatchObject({ decision: 'allow_once' })
      expect(s.writes(), 'the arguments and the reason never ride along').not.toContain(SECRET)
    })

    it('resumes after Last-Event-ID: a client that saw the request gets only the answer', () => {
      const a = ask()
      const first = open()
      first.close()
      const seen = frames(first.writes())
      expect(seen.map((f) => f.row.kind)).toEqual(['approval_requested'])

      resolveApproval(getDb(), a.id, 'deny') // answered while the client was away
      const again = open({}, { 'last-event-id': String(seen.at(-1)!.id) })
      again.close()
      const resumed = frames(again.writes())
      expect(resumed.map((f) => f.row.kind)).toEqual(['approval_resolved'])
      expect(JSON.parse(resumed[0]!.row.data)).toMatchObject({ approvalId: a.id, decision: 'deny' })
    })

    it('kinds narrows the stream to the approval lifecycle', () => {
      seed()
      chatter(3)
      const a = ask()
      chatter(3)
      resolveApproval(getDb(), a.id, 'allow_once')
      chatter(3)

      const s = open({ kinds: APPROVAL_KINDS })
      s.close()
      const got = frames(s.writes())
      expect(got.map((f) => f.row.kind)).toEqual(['approval_requested', 'approval_resolved'])
      expect(got.map((f) => (JSON.parse(f.row.data) as { approvalId: string }).approvalId)).toEqual(
        [a.id, a.id],
      )
    })

    it('a narrowed client that reconnects behind other traffic gets the answer on its first read', () => {
      const a = ask()
      const first = open({ kinds: APPROVAL_KINDS })
      first.close()
      const lastSeen = frames(first.writes()).at(-1)!.id

      // More than one read's worth (500 rows) of other events before the answer.
      // Filtered on the client instead, the answer would wait behind them.
      chatter(600)
      resolveApproval(getDb(), a.id, 'allow_once')

      const again = open({ kinds: APPROVAL_KINDS }, { 'last-event-id': String(lastSeen) })
      again.close()
      expect(kindsOf(again.writes())).toEqual(['approval_resolved'])
    })

    it('a narrowed, team-scoped client loses nothing while it skips past other traffic', () => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
      const s = open({ teamId: 'team-A', kinds: APPROVAL_KINDS, afterSeq: String(head()) })
      chatter(5)
      vi.advanceTimersByTime(750) // nothing matches: the cursor moves past the chatter
      const a = ask()
      chatter(5)
      vi.advanceTimersByTime(750)
      resolveApproval(getDb(), a.id, 'deny')
      vi.advanceTimersByTime(750)
      s.close()
      expect(kindsOf(s.writes())).toEqual(['approval_requested', 'approval_resolved'])
    })

    it('a full read does not skip ahead: the rest arrives on the next poll', () => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
      chatter(600)
      const s = open()
      expect(frames(s.writes())).toHaveLength(500)
      vi.advanceTimersByTime(750)
      s.close()
      const got = frames(s.writes())
      expect(got).toHaveLength(600)
      expect(new Set(got.map((f) => f.id)).size).toBe(600)
    })

    it('takes afterSeq as the cursor, the name /api/obs/events uses', () => {
      const a = ask()
      const requested = head()
      resolveApproval(getDb(), a.id, 'allow_once')

      const s = open({ afterSeq: String(requested) })
      s.close()
      expect(kindsOf(s.writes())).toEqual(['approval_resolved'])

      // A browser reconnects to the same URL with the last id it saw, which wins.
      const resumed = open({ afterSeq: '0' }, { 'last-event-id': String(head()) })
      resumed.close()
      expect(frames(resumed.writes())).toEqual([])
    })

    it('a malformed Last-Event-ID falls back to the query cursor instead of replaying from 0', () => {
      const a = ask()
      const requested = head()
      resolveApproval(getDb(), a.id, 'allow_once')

      const s = open({ since: String(requested) }, { 'last-event-id': 'not-a-seq' })
      s.close()
      expect(kindsOf(s.writes())).toEqual(['approval_resolved'])
    })
  })
})
