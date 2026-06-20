// The routine source against a real sandboxed sqlite ledger: create lands in
// scheduled_runs (managed, team-task domain), the de-dup refusal surfaces as
// the typed DuplicateFiringOwnerError, pause/resume/remove/run round-trip, and
// the read projection maps runtime via the agents table.

import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  agents,
  createDb,
  createTask,
  getScheduledRun,
  listScheduledRuns,
  type ClawbooDb,
} from '@clawboo/db'
import {
  BoundRecurringScheduleError,
  DuplicateFiringOwnerError,
  IllegalScheduleTransitionError,
  InvalidCronSpecError,
  UnknownScheduleError,
} from '@clawboo/scheduler'

import { ClawbooRoutineScheduleSource } from '../clawbooRoutineScheduleSource'

let dir: string
let dbPath: string
let db: ClawbooDb
let source: ClawbooRoutineScheduleSource

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'clawboo-routine-source-'))
  dbPath = path.join(dir, 'test.db')
  db = createDb(dbPath)
  const now = Date.now()
  db.insert(agents)
    .values({
      id: 'agent-1',
      name: 'A1',
      gatewayId: 'a1',
      runtime: 'clawboo-native',
      createdAt: now,
      updatedAt: now,
    })
    .run()
  source = new ClawbooRoutineScheduleSource({ getDbPath: () => dbPath })
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('ClawbooRoutineScheduleSource', () => {
  it('create lands in scheduled_runs and reads back as a managed team-task record', async () => {
    const record = await source.write({
      kind: 'create',
      spec: {
        source: 'clawboo-routine',
        domain: 'team-task',
        agentId: 'agent-1',
        cronSpec: '0 9 * * 1',
        label: 'Weekly report',
        teamId: 'team-1',
        taskTemplate: { kind: 'research', priority: 2 },
      },
    })

    expect(record).toMatchObject({
      source: 'clawboo-routine',
      domain: 'team-task',
      manageability: 'managed',
      owner: 'clawboo',
      runtime: 'clawboo-native',
      agentId: 'agent-1',
      label: 'Weekly report',
      cronSpec: '0 9 * * 1',
      status: 'idle',
      tenantId: null,
    })
    expect(record?.nextRunAt).toBeGreaterThan(Date.now() - 1000)

    const rows = listScheduledRuns(db)
    expect(rows).toHaveLength(1)
    expect(JSON.parse(rows[0]!.taskTemplate)).toMatchObject({
      title: 'Weekly report',
      kind: 'research',
      priority: 2,
    })

    const { records, status } = await source.read()
    expect(records).toHaveLength(1)
    expect(status).toMatchObject({ sourceId: 'clawboo-routine', ok: true, degraded: false })
  })

  it('DE-DUP: binding a routine to a foreign-owned team task throws the typed refusal', async () => {
    const task = createTask(db, { title: 'Gateway-owned', scheduledBy: 'openclaw' })
    await expect(
      source.write({
        kind: 'create',
        spec: {
          source: 'clawboo-routine',
          domain: 'team-task',
          agentId: 'agent-1',
          // A bound routine must be one-shot (once@); the ownership conflict still applies.
          cronSpec: 'once@2099-01-01T00:00:00.000Z',
          label: 'Conflicting',
          teamTaskId: task.id,
        },
      }),
    ).rejects.toBeInstanceOf(DuplicateFiringOwnerError)
    expect(listScheduledRuns(db)).toHaveLength(0)
  })

  it('an invalid cron spec is refused with the typed error', async () => {
    await expect(
      source.write({
        kind: 'create',
        spec: {
          source: 'clawboo-routine',
          domain: 'team-task',
          agentId: 'agent-1',
          cronSpec: 'nope nope',
        },
      }),
    ).rejects.toBeInstanceOf(InvalidCronSpecError)
  })

  it('pause / resume / run / remove round-trip the ledger', async () => {
    const record = await source.write({
      kind: 'create',
      spec: {
        source: 'clawboo-routine',
        domain: 'team-task',
        agentId: 'agent-1',
        cronSpec: '0 9 * * *',
        label: 'Chore',
      },
    })
    const id = record!.id

    const paused = await source.write({ kind: 'pause', id })
    expect(paused?.status).toBe('paused')
    // Paused rows can't be force-fired.
    await expect(source.write({ kind: 'run', id })).rejects.toBeInstanceOf(
      IllegalScheduleTransitionError,
    )

    const resumed = await source.write({ kind: 'resume', id })
    expect(resumed?.status).toBe('idle')
    expect(resumed?.nextRunAt).toBeGreaterThan(0)

    expect(await source.write({ kind: 'run', id })).toBeNull()
    expect(getScheduledRun(db, record!.sourceScheduleId)?.status).toBe('queued')

    // Can't remove what doesn't exist; can remove what does.
    await expect(
      source.write({ kind: 'remove', id: 'clawboo-routine:missing' }),
    ).rejects.toBeInstanceOf(UnknownScheduleError)
    // Note: 'queued' rows still delete cleanly.
    expect(await source.write({ kind: 'remove', id })).toBeNull()
    expect(listScheduledRuns(db)).toHaveLength(0)
  })

  it('update patches the spec + recomputes nextRunAt', async () => {
    const record = await source.write({
      kind: 'create',
      spec: {
        source: 'clawboo-routine',
        domain: 'team-task',
        agentId: 'agent-1',
        cronSpec: '0 9 * * *',
        label: 'Chore',
      },
    })
    const updated = await source.write({
      kind: 'update',
      id: record!.id,
      patch: { cronSpec: '*/5 * * * *', label: 'Renamed chore' },
    })
    expect(updated).toMatchObject({ cronSpec: '*/5 * * * *', label: 'Renamed chore' })
    expect(updated?.nextRunAt).toBeGreaterThan(0) // an idle row stays armed
  })

  it('patching a cronSpec on a PAUSED (disarmed) row leaves nextRunAt NULL', async () => {
    const record = await source.write({
      kind: 'create',
      spec: {
        source: 'clawboo-routine',
        domain: 'team-task',
        agentId: 'agent-1',
        cronSpec: '0 9 * * *',
        label: 'Chore',
      },
    })
    await source.write({ kind: 'pause', id: record!.id })
    await source.write({ kind: 'update', id: record!.id, patch: { cronSpec: '*/5 * * * *' } })
    // A paused/error row is DISARMED — changing its spec must not silently re-arm
    // it (resume re-arms via safeNext). next_run_at stays null.
    expect(getScheduledRun(db, record!.sourceScheduleId)?.nextRunAt).toBeNull()
  })

  it('refuses a RECURRING schedule bound to an existing team task (one-shot only)', async () => {
    const task = createTask(db, { title: 'Bound', status: 'todo' })
    await expect(
      source.write({
        kind: 'create',
        spec: {
          source: 'clawboo-routine',
          domain: 'team-task',
          agentId: 'agent-1',
          cronSpec: '0 9 * * *', // recurring → would fire once then park in error
          teamTaskId: task.id,
        },
      }),
    ).rejects.toBeInstanceOf(BoundRecurringScheduleError)
    expect(listScheduledRuns(db)).toHaveLength(0)
  })

  it('allows a ONE-SHOT (once@) schedule bound to an existing team task', async () => {
    const task = createTask(db, { title: 'Bound once', status: 'todo' })
    const record = await source.write({
      kind: 'create',
      spec: {
        source: 'clawboo-routine',
        domain: 'team-task',
        agentId: 'agent-1',
        cronSpec: 'once@2099-01-01T00:00:00.000Z',
        teamTaskId: task.id,
      },
    })
    expect(record?.teamTaskId).toBe(task.id)
    expect(listScheduledRuns(db)).toHaveLength(1)
  })
})
