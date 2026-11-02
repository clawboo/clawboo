// Moving an agent to another team. Changing `agents.team_id` alone left its
// old work pointing at the team it had left: a not-yet-started task bound to it
// would fire into the old team's chat, and its routines kept posting there.

import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {
  agents,
  getScheduledRun,
  getSetting,
  registerScheduledRun,
  roomMembers,
  rooms,
  setSetting,
  tasks,
  teams,
} from '@clawboo/db'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { moveAgentToTeam } from '../agentMove'
import { getDb, resetDb } from '../db'

let home: string

function seedTeam(id: string, opts: { leader?: string; archived?: boolean } = {}): void {
  const now = Date.now()
  getDb()
    .insert(teams)
    .values({
      id,
      name: id,
      icon: '🧪',
      color: '#fff',
      leaderAgentId: opts.leader ?? null,
      isArchived: opts.archived ? 1 : 0,
      createdAt: now,
      updatedAt: now,
    })
    .run()
}

function seedAgent(id: string, teamId: string | null): void {
  const now = Date.now()
  getDb()
    .insert(agents)
    .values({
      id,
      name: id,
      gatewayId: id,
      sourceId: 'clawboo-native',
      status: 'idle',
      teamId,
      createdAt: now,
      updatedAt: now,
    })
    .run()
}

function seedTask(
  id: string,
  status: string,
  opts: { assignee?: string | null; sdid?: string | null; teamId?: string } = {},
): void {
  const now = Date.now()
  getDb()
    .insert(tasks)
    .values({
      id,
      title: id,
      status,
      teamId: opts.teamId ?? 'old',
      assigneeAgentId: opts.assignee ?? null,
      sourceDelegationId: opts.sdid ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .run()
}

const taskRow = (id: string) => getDb().select().from(tasks).where(eq(tasks.id, id)).get()

beforeEach(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), 'clawboo-agent-move-'))
  process.env['CLAWBOO_HOME'] = home
  seedTeam('old', { leader: 'lead' })
  seedTeam('new')
  seedTeam('shelved', { archived: true })
  seedAgent('lead', 'old')
  seedAgent('a', 'old')
  seedAgent('ab', 'old')
})

afterEach(async () => {
  resetDb()
  delete process.env['CLAWBOO_HOME']
  await rm(home, { recursive: true, force: true }).catch(() => {})
})

describe('moveAgentToTeam', () => {
  it('moves the agent and everything tied to its old team, in one step', () => {
    const db = getDb()
    // Not started and bound to `a`: handed back, left on the old board.
    seedTask('todo-a', 'todo', { sdid: 'deleg:1:agent:a' })
    seedTask('backlog-a', 'backlog', { assignee: 'a' })
    // A prefix of another agent's id is not a match.
    seedTask('todo-ab', 'todo', { sdid: 'deleg:2:agent:ab' })
    // The record of finished work stays as it is.
    seedTask('done-a', 'done', { assignee: 'a', sdid: 'deleg:4:agent:a' })

    const agentRoutine = registerScheduledRun(db, {
      agentId: 'a',
      teamId: 'old',
      cronSpec: '0 9 * * *',
      taskTemplate: '{}',
      nextRunAt: Date.now() + 60_000,
    })
    const teamRoutine = registerScheduledRun(db, {
      agentId: '',
      teamId: 'old',
      cronSpec: '0 9 * * *',
      taskTemplate: '{}',
      nextRunAt: Date.now() + 60_000,
    })
    // Bound to one old-team task: its fire would still run that task.
    const boundRoutine = registerScheduledRun(db, {
      agentId: 'a',
      teamId: 'old',
      cronSpec: 'once@2099-01-01T09:00:00.000Z',
      taskTemplate: JSON.stringify({ title: 'Ship it', kind: 'research', teamTaskId: 'todo-ab' }),
      nextRunAt: Date.now() + 60_000,
    })
    if (!agentRoutine.ok || !teamRoutine.ok || !boundRoutine.ok) throw new Error('seed')

    const now = Date.now()
    db.insert(rooms)
      .values({ id: 'r1', teamId: 'old', name: 'Room', createdAt: now, updatedAt: now })
      .run()
    db.insert(roomMembers).values({ roomId: 'r1', agentId: 'a', createdAt: now }).run()
    setSetting(db, 'native-team-session:a:old', 'sess-1')
    setSetting(db, 'native-team-session:a:old:room:r1', 'sess-2')
    setSetting(db, 'native-team-session:a:elsewhere', 'sess-3')

    const result = moveAgentToTeam(db, { agentId: 'a', toTeamId: 'new', booZeroId: null })

    expect(result).toEqual({
      ok: true,
      fromTeamId: 'old',
      toTeamId: 'new',
      tasksHandedBack: 2,
      routinesMoved: 1,
      routinesPaused: 1,
    })
    expect(db.select().from(agents).where(eq(agents.id, 'a')).get()?.teamId).toBe('new')

    expect(taskRow('todo-a')).toMatchObject({
      teamId: 'old',
      status: 'todo',
      sourceDelegationId: null,
    })
    expect(taskRow('backlog-a')).toMatchObject({ assigneeAgentId: null, status: 'backlog' })
    expect(taskRow('todo-ab')?.sourceDelegationId).toBe('deleg:2:agent:ab')
    expect(taskRow('done-a')).toMatchObject({ assigneeAgentId: 'a', status: 'done' })

    expect(getScheduledRun(db, agentRoutine.run.id)?.teamId).toBe('new')
    expect(getScheduledRun(db, teamRoutine.run.id)?.teamId).toBe('old')
    expect(getScheduledRun(db, boundRoutine.run.id)).toMatchObject({
      teamId: 'old',
      status: 'paused',
    })

    expect(db.select().from(roomMembers).where(eq(roomMembers.agentId, 'a')).all()).toEqual([])
    expect(getSetting(db, 'native-team-session:a:old')).toBeNull()
    expect(getSetting(db, 'native-team-session:a:old:room:r1')).toBeNull()
    expect(getSetting(db, 'native-team-session:a:elsewhere')).toBe('sess-3')
  })

  it('refuses a team lead, Boo Zero and an agent with a task in progress, changing nothing', () => {
    const db = getDb()
    expect(moveAgentToTeam(db, { agentId: 'lead', toTeamId: 'new', booZeroId: null })).toEqual({
      ok: false,
      status: 409,
      error: 'agent_leads_team',
    })
    expect(moveAgentToTeam(db, { agentId: 'a', toTeamId: 'new', booZeroId: 'a' })).toMatchObject({
      error: 'agent_is_boo_zero',
    })

    seedTask('running-a', 'in_progress', { assignee: 'a' })
    seedTask('todo-a', 'todo', { sdid: 'deleg:1:agent:a' })
    expect(moveAgentToTeam(db, { agentId: 'a', toTeamId: 'new', booZeroId: null })).toMatchObject({
      ok: false,
      error: 'agent_busy',
    })
    // In review counts too: a failed check with retries left sends the task
    // back to in progress with the same assignee.
    db.update(tasks).set({ status: 'done' }).where(eq(tasks.id, 'running-a')).run()
    seedTask('review-a', 'in_review', { assignee: 'a' })
    expect(moveAgentToTeam(db, { agentId: 'a', toTeamId: 'new', booZeroId: null })).toMatchObject({
      ok: false,
      error: 'agent_busy',
    })
    expect(db.select().from(agents).where(eq(agents.id, 'a')).get()?.teamId).toBe('old')
    expect(taskRow('todo-a')?.sourceDelegationId).toBe('deleg:1:agent:a')
  })

  it('refuses a missing or archived team, the same team and an unknown agent', () => {
    const db = getDb()
    const move = (agentId: string, toTeamId: string) =>
      moveAgentToTeam(db, { agentId, toTeamId, booZeroId: null })
    expect(move('a', 'nope')).toMatchObject({ status: 404, error: 'team_not_found' })
    expect(move('a', 'shelved')).toMatchObject({ status: 409, error: 'team_archived' })
    expect(move('a', 'old')).toMatchObject({ status: 400, error: 'same_team' })
    expect(move('ghost', 'new')).toMatchObject({ status: 404, error: 'agent_not_found' })
  })
})
