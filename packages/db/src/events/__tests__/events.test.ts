import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createDb, type ClawbooDb } from '../../db'
import { appendEvent } from '../appendEvent'
import { listEvents } from '../listEvents'

let dir: string
let db: ClawbooDb

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'clawboo-events-'))
  db = createDb(path.join(dir, 'test.db'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('orchestration event log', () => {
  it('append → list round-trip in seq ASC (causal) order', () => {
    appendEvent(db, {
      kind: 'task_created',
      taskId: 't1',
      teamId: 'team1',
      data: { title: 'A', status: 'todo' },
    })
    appendEvent(db, {
      kind: 'task_claimed',
      taskId: 't1',
      agentId: 'a1',
      data: { assigneeAgentId: 'a1' },
    })
    const evs = listEvents(db, { taskId: 't1' })
    expect(evs.map((e) => e.kind)).toEqual(['task_created', 'task_claimed'])
    expect(evs[0]!.seq).toBeLessThan(evs[1]!.seq)
    expect(JSON.parse(evs[0]!.data)).toEqual({ title: 'A', status: 'todo' })
  })

  it('scrubs secrets from data BEFORE storage', () => {
    appendEvent(db, {
      kind: 'tool_call',
      taskId: 't2',
      data: { name: 'x', input: { api_key: 'sk-supersecret123', path: 'ok' } },
    })
    const [e] = listEvents(db, { taskId: 't2' })
    expect(e!.data).not.toContain('sk-supersecret123')
    expect(e!.data).toContain('REDACTED')
    expect(e!.data).toContain('ok')
  })

  it('preserves token COUNTS (inputTokens/outputTokens are not secrets)', () => {
    appendEvent(db, {
      kind: 'cost',
      taskId: 't3',
      data: { costUsd: 0.1, inputTokens: 4200, outputTokens: 1100, model: 'claude' },
    })
    const d = JSON.parse(listEvents(db, { taskId: 't3' })[0]!.data) as Record<string, unknown>
    expect(d['inputTokens']).toBe(4200) // a number, not "[REDACTED]"
    expect(d['outputTokens']).toBe(1100)
    expect(d['costUsd']).toBe(0.1)
  })

  it('seq is monotonic + unique across SEPARATE connections (cross-process)', () => {
    const db2 = createDb(path.join(dir, 'test.db')) // second handle, same file
    const e1 = appendEvent(db, { kind: 'cost', data: {} })
    const e2 = appendEvent(db2, { kind: 'cost', data: {} })
    const e3 = appendEvent(db, { kind: 'cost', data: {} })
    expect(e2.seq).toBeGreaterThan(e1.seq)
    expect(e3.seq).toBeGreaterThan(e2.seq)
    expect(new Set([e1.seq, e2.seq, e3.seq]).size).toBe(3)
  })

  it('filters by kind / traceId / since and supports desc order', () => {
    appendEvent(db, { kind: 'span_start', traceId: 'tr1', ts: 1000, data: { name: 'run' } })
    appendEvent(db, { kind: 'tool_call', traceId: 'tr1', ts: 2000, data: {} })
    appendEvent(db, { kind: 'span_end', traceId: 'tr1', ts: 3000, data: { name: 'run' } })
    appendEvent(db, { kind: 'cost', traceId: 'tr2', ts: 4000, data: {} })
    expect(listEvents(db, { traceId: 'tr1' })).toHaveLength(3)
    expect(listEvents(db, { kinds: ['tool_call'] })).toHaveLength(1)
    expect(listEvents(db, { since: 3000 })).toHaveLength(2) // ts >= 3000 → span_end + cost
    expect(listEvents(db, { traceId: 'tr1', order: 'desc' })[0]!.kind).toBe('span_end')
  })

  it('coerces an unknown kind to error (best-effort — observability never drops)', () => {
    // @ts-expect-error — deliberately exercising the runtime coercion
    appendEvent(db, { kind: 'not_a_real_kind', data: {} })
    expect(listEvents(db, { kinds: ['error'] })).toHaveLength(1)
  })

  it('filters by agentId (the per-agent activity scope)', () => {
    appendEvent(db, { kind: 'tool_call', agentId: 'a1', data: {} })
    appendEvent(db, { kind: 'tool_result', agentId: 'a2', data: {} })
    appendEvent(db, { kind: 'tool_call', agentId: 'a1', data: {} })
    expect(listEvents(db, { agentId: 'a1' })).toHaveLength(2)
    expect(listEvents(db, { agentId: 'a2' })).toHaveLength(1)
  })

  it('afterSeq returns only events strictly after the cursor (the SSE tail)', () => {
    const e1 = appendEvent(db, { kind: 'tool_call', taskId: 't', data: {} })
    const e2 = appendEvent(db, { kind: 'tool_result', taskId: 't', data: {} })
    appendEvent(db, { kind: 'cost', taskId: 't', data: {} })
    const tail = listEvents(db, { taskId: 't', afterSeq: e1.seq })
    expect(tail.map((e) => e.kind)).toEqual(['tool_result', 'cost'])
    expect(tail.every((e) => e.seq > e1.seq)).toBe(true)
    // exhausted cursor → empty
    const last = listEvents(db, { taskId: 't' }).at(-1)!
    expect(listEvents(db, { taskId: 't', afterSeq: last.seq })).toHaveLength(0)
    expect(e2.seq).toBeGreaterThan(e1.seq)
  })
})
