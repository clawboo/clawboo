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
  teams,
  type ClawbooDb,
} from '@clawboo/db'
import {
  BoundRecurringScheduleError,
  DuplicateFiringOwnerError,
  IllegalScheduleTransitionError,
  InvalidCronSpecError,
  InvalidRoutineTargetError,
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
  for (const [id, name, isArchived] of [
    ['team-1', 'Research', 0],
    ['team-2', 'Growth', 0],
    ['team-old', 'Retired', 1],
  ] as const) {
    db.insert(teams)
      .values({ id, name, icon: 'T', color: '#123456', isArchived, createdAt: now, updatedAt: now })
      .run()
  }
  for (const [id, name, teamId, archivedAt] of [
    ['agent-1', 'A1', 'team-1', null],
    ['agent-2', 'A2', 'team-2', null],
    ['solo', 'Solo', null, null],
    ['gone', 'Gone', 'team-1', now],
  ] as const) {
    db.insert(agents)
      .values({
        id,
        name,
        gatewayId: id,
        runtime: 'clawboo-native',
        teamId,
        archivedAt,
        createdAt: now,
        updatedAt: now,
      })
      .run()
  }
  source = new ClawbooRoutineScheduleSource({ getDb: () => db })
})

afterEach(() => {
  // This suite OWNS its connection (createDb at a fixture path), so resetDb()
  // cannot reach it: that only evicts the getDb() memo. Windows refuses to
  // remove a directory that still holds an open file, so close it before the
  // rm. Mirrors the ownership rule in lib/db.ts. (#140)
  db.$client.close()
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
      target: 'agent',
      teamId: 'team-1',
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
      target: 'agent',
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

  describe('routine targets', () => {
    it('a TEAM routine stores the team, keeps no agent, and reads back its instructions', async () => {
      const record = await source.write({
        kind: 'create',
        spec: {
          source: 'clawboo-routine',
          domain: 'team-task',
          target: 'team',
          teamId: 'team-2',
          cronSpec: '0 9 * * 1-5',
          label: 'Standup',
          taskTemplate: { description: 'Post a standup summary.' },
        },
      })
      expect(record).toMatchObject({
        target: 'team',
        agentId: '',
        teamId: 'team-2',
        label: 'Standup',
        description: 'Post a standup summary.',
      })
      const row = listScheduledRuns(db)[0]!
      expect(row).toMatchObject({ agentId: '', teamId: 'team-2' })
      expect(JSON.parse(row.taskTemplate)).toMatchObject({
        target: 'team',
        title: 'Standup',
        description: 'Post a standup summary.',
      })
    })

    it("an AGENT routine is filed on the agent's own team, and a teamless agent on none", async () => {
      const onTeam = await source.write({
        kind: 'create',
        spec: {
          source: 'clawboo-routine',
          domain: 'team-task',
          target: 'agent',
          agentId: 'agent-2',
          cronSpec: '0 9 * * *',
          label: 'Inbox',
        },
      })
      expect(onTeam).toMatchObject({ target: 'agent', agentId: 'agent-2', teamId: 'team-2' })

      const solo = await source.write({
        kind: 'create',
        spec: {
          source: 'clawboo-routine',
          domain: 'team-task',
          agentId: 'solo',
          teamId: null,
          cronSpec: '0 9 * * *',
          label: 'Solo chore',
        },
      })
      expect(solo).toMatchObject({ target: 'agent', agentId: 'solo', teamId: null })
    })

    it.each([
      ['a team routine with no team', { target: 'team' as const }],
      ['a team that does not exist', { target: 'team' as const, teamId: 'team-nope' }],
      ['an archived team', { target: 'team' as const, teamId: 'team-old' }],
      ['an agent routine with no agent', { target: 'agent' as const }],
      ['an agent that does not exist', { agentId: 'agent-nope' }],
      ['an agent that was removed', { agentId: 'gone' }],
      ['an agent paired with another team', { agentId: 'agent-1', teamId: 'team-2' }],
      ['a teamless agent paired with a team', { agentId: 'solo', teamId: 'team-1' }],
    ])('refuses %s, and writes nothing', async (_label, target) => {
      await expect(
        source.write({
          kind: 'create',
          spec: {
            source: 'clawboo-routine',
            domain: 'team-task',
            cronSpec: '0 9 * * *',
            label: 'x',
            ...target,
          },
        }),
      ).rejects.toBeInstanceOf(InvalidRoutineTargetError)
      expect(listScheduledRuns(db)).toHaveLength(0)
    })

    it('refuses a team routine bound to a board task', async () => {
      const task = createTask(db, { title: 'Bound', status: 'todo' })
      await expect(
        source.write({
          kind: 'create',
          spec: {
            source: 'clawboo-routine',
            domain: 'team-task',
            target: 'team',
            teamId: 'team-1',
            cronSpec: 'once@2099-01-01T00:00:00.000Z',
            teamTaskId: task.id,
          },
        }),
      ).rejects.toBeInstanceOf(InvalidRoutineTargetError)
    })

    it('update re-points an agent routine at a team and back', async () => {
      const created = await source.write({
        kind: 'create',
        spec: {
          source: 'clawboo-routine',
          domain: 'team-task',
          agentId: 'agent-1',
          cronSpec: '0 9 * * *',
          label: 'Digest',
        },
      })
      const id = created!.id

      const asTeam = await source.write({
        kind: 'update',
        id,
        patch: { target: 'team', teamId: 'team-2', agentId: null },
      })
      expect(asTeam).toMatchObject({ target: 'team', agentId: '', teamId: 'team-2' })

      const asAgent = await source.write({
        kind: 'update',
        id,
        patch: {
          target: 'agent',
          agentId: 'agent-1',
          teamId: 'team-1',
          label: 'Digest v2',
          taskTemplate: { description: 'Write the digest.' },
        },
      })
      expect(asAgent).toMatchObject({
        target: 'agent',
        agentId: 'agent-1',
        teamId: 'team-1',
        label: 'Digest v2',
        description: 'Write the digest.',
      })
    })

    it('an invalid re-point is refused and leaves the routine as it was', async () => {
      const created = await source.write({
        kind: 'create',
        spec: {
          source: 'clawboo-routine',
          domain: 'team-task',
          agentId: 'agent-1',
          cronSpec: '0 9 * * *',
          label: 'Digest',
        },
      })
      await expect(
        source.write({
          kind: 'update',
          id: created!.id,
          patch: { agentId: 'agent-1', teamId: 'team-2' },
        }),
      ).rejects.toBeInstanceOf(InvalidRoutineTargetError)
      expect(getScheduledRun(db, created!.sourceScheduleId)).toMatchObject({
        agentId: 'agent-1',
        teamId: 'team-1',
      })
    })

    it('a target inside the template patch is validated like any re-point', async () => {
      const created = await source.write({
        kind: 'create',
        spec: {
          source: 'clawboo-routine',
          domain: 'team-task',
          agentId: 'agent-1',
          cronSpec: '0 9 * * *',
          label: 'Digest',
        },
      })
      // 'team' with the routine's own team (team-1) is a valid re-point.
      const moved = await source.write({
        kind: 'update',
        id: created!.id,
        patch: { taskTemplate: { target: 'team' } },
      })
      expect(moved).toMatchObject({ target: 'team', agentId: '', teamId: 'team-1' })
      await expect(
        source.write({
          kind: 'update',
          id: created!.id,
          patch: { taskTemplate: { target: 'everyone' } },
        }),
      ).rejects.toBeInstanceOf(InvalidRoutineTargetError)
    })

    it('an unknown top-level target is refused, not read as an agent routine', async () => {
      const created = await source.write({
        kind: 'create',
        spec: {
          source: 'clawboo-routine',
          domain: 'team-task',
          agentId: 'agent-1',
          cronSpec: '0 9 * * *',
          label: 'Digest',
        },
      })
      await expect(
        source.write({
          kind: 'update',
          id: created!.id,
          patch: { target: 'Team' as never, teamId: 'team-1' },
        }),
      ).rejects.toBeInstanceOf(InvalidRoutineTargetError)
      expect(getScheduledRun(db, created!.sourceScheduleId)).toMatchObject({
        agentId: 'agent-1',
        teamId: 'team-1',
      })
    })

    it('a template patch cannot bind a board task after registration', async () => {
      const task = createTask(db, {
        title: 'Someone else',
        status: 'todo',
        scheduledBy: 'openclaw',
      })
      const created = await source.write({
        kind: 'create',
        spec: {
          source: 'clawboo-routine',
          domain: 'team-task',
          agentId: 'agent-1',
          cronSpec: '0 9 * * *',
          label: 'Digest',
        },
      })
      const updated = await source.write({
        kind: 'update',
        id: created!.id,
        patch: { taskTemplate: { teamTaskId: task.id } },
      })
      expect(updated?.teamTaskId).toBeUndefined()
      expect(
        JSON.parse(getScheduledRun(db, created!.sourceScheduleId)!.taskTemplate),
      ).not.toHaveProperty('teamTaskId')
    })
  })
})
