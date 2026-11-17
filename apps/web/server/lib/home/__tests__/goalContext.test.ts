// The team's goals in an agent's turn: a lead sees the active goals (capped), a
// worker sees only its own task's goal, and a team with none adds nothing.

import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {
  agents,
  createSubtask,
  createTask,
  createTeamGoal,
  setTeamGoalHealth,
  teams,
  updateTeamGoal,
} from '@clawboo/db'
import type { TurnFraming } from '@clawboo/team-orchestration'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { getDb, getDbPath, resetDb } from '../../db'
import { buildServerTeamContext } from '../../teamChat/contextPreamble'
import { GOALS_IN_LEAD_TURN } from '../goalContext'

const LEADER: TurnFraming = { isLeader: true, isWorker: false, isUserFacing: true }
const WORKER: TurnFraming = { isLeader: false, isWorker: true, isUserFacing: false }
const PERSON = { kind: 'person' as const, id: 'local', name: 'You' }

describe('goals in the team preamble', () => {
  let home: string
  let prevHome: string | undefined
  let prevClawbooHome: string | undefined

  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), 'clawboo-goal-ctx-'))
    prevHome = process.env['HOME']
    prevClawbooHome = process.env['CLAWBOO_HOME']
    process.env['HOME'] = home
    process.env['CLAWBOO_HOME'] = path.join(home, '.clawboo')
    expect(getDbPath().startsWith(home)).toBe(true)
    const db = getDb()
    const now = Date.now()
    db.insert(teams)
      .values({ id: 'T', name: 'Team', icon: 'i', color: 'c', createdAt: now, updatedAt: now })
      .run()
    for (const id of ['lead', 'work'])
      db.insert(agents)
        .values({
          id,
          name: id,
          gatewayId: id,
          runtime: 'clawboo-native',
          teamId: 'T',
          createdAt: now,
          updatedAt: now,
        })
        .run()
  })

  afterEach(async () => {
    resetDb()
    if (prevHome === undefined) delete process.env['HOME']
    else process.env['HOME'] = prevHome
    if (prevClawbooHome === undefined) delete process.env['CLAWBOO_HOME']
    else process.env['CLAWBOO_HOME'] = prevClawbooHome
    await rm(home, { recursive: true, force: true })
  })

  function goal(title: string): string {
    const r = createTeamGoal(getDb(), 'T', { title }, PERSON)
    if (!r.ok) throw new Error(r.reason)
    return r.value.id
  }

  it('adds nothing for a team with no goals', () => {
    expect(buildServerTeamContext(getDb(), 'T', 'lead', LEADER) ?? '').not.toContain('[Team Goals')
  })

  it("lists a lead's active goals with health, date and progress", () => {
    const db = getDb()
    const g = goal('Launch the beta')
    setTeamGoalHealth(db, 'T', g, 'at_risk', PERSON)
    updateTeamGoal(db, 'T', g, { targetDate: Date.UTC(2026, 11, 1) })
    const done = goal('Old goal')
    updateTeamGoal(db, 'T', done, { status: 'done' })
    const t = createTask(db, { title: 'Docs', teamId: 'T', goalId: g })
    createTask(db, { title: 'Other', teamId: 'T' })
    expect(t.goalId).toBe(g)
    const ctx = buildServerTeamContext(db, 'T', 'lead', LEADER) ?? ''
    expect(ctx).toContain('[Team Goals, set by a person]')
    expect(ctx).toContain('- Launch the beta (at risk, due 2026-12-01, 0 of 1 tasks done)')
    expect(ctx).not.toContain('Old goal')
  })

  it('caps the goals a lead sees', () => {
    for (let i = 0; i < GOALS_IN_LEAD_TURN + 2; i++) goal(`Goal ${i}`)
    const ctx = buildServerTeamContext(getDb(), 'T', 'lead', LEADER) ?? ''
    expect(ctx).toContain('…and 2 more.')
    expect(ctx).not.toContain(`Goal ${GOALS_IN_LEAD_TURN}`)
  })

  it("gives a worker only its own task's goal", () => {
    const db = getDb()
    const g = goal('Launch the beta')
    goal('Something else')
    const parent = createTask(db, { title: 'Request', teamId: 'T', goalId: g })
    const child = createSubtask(db, parent.id, { title: 'Write docs' })
    const ctx = buildServerTeamContext(db, 'T', 'work', WORKER, null, child.id) ?? ''
    expect(ctx).toContain('[Goal of this task] Launch the beta')
    expect(ctx).not.toContain('Something else')
    expect(ctx).not.toContain('[Team Goals')
    expect(buildServerTeamContext(db, 'T', 'work', WORKER) ?? '').not.toContain(
      '[Goal of this task]',
    )
  })
})
