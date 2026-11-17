// Home on the Tasks tools: an agent reads its own team's goals, KPIs and pages,
// reports an agent-source KPI with its run and task, suggests a KPI, writes a page
// revision and drafts a goal update. It never publishes, sets health or defines a
// KPI, and an unidentified caller gets the reads only.

import {
  agents,
  createDb,
  createTeamGoal,
  createTeamKpi,
  getTeamGoal,
  listGoalUpdates,
  listKpiValues,
  listPageRevisions,
  listSuggestedKpis,
  setTeamHomeSettings,
  teams,
  type ClawbooDb,
} from '@clawboo/db'
import { beforeEach, describe, expect, it } from 'vitest'

import { callText, connectInMemory, listToolNames } from '../../testing'
import { createTasksServer, type TasksServerOptions } from '../server'

let db: ClawbooDb
const PERSON = { kind: 'person' as const, id: 'local', name: 'You' }
const BOUND: TasksServerOptions = {
  boundScope: { teamId: 'A', agentId: 'coder', executionId: 'ex-1', taskId: 'task-1' },
}

beforeEach(() => {
  db = createDb(':memory:')
  const now = Date.now()
  for (const id of ['A', 'B'])
    db.insert(teams)
      .values({ id, name: `Team ${id}`, icon: 'i', color: 'c', createdAt: now, updatedAt: now })
      .run()
  db.insert(agents)
    .values({
      id: 'coder',
      name: 'Coder',
      gatewayId: 'g',
      teamId: 'A',
      createdAt: now,
      updatedAt: now,
    })
    .run()
})

const connect = (opts?: TasksServerOptions) => connectInMemory(createTasksServer(db, opts))

function goal(teamId: string, title: string): string {
  const r = createTeamGoal(db, teamId, { title }, PERSON)
  if (!r.ok) throw new Error(r.reason)
  return r.value.id
}

describe('Home on the Tasks tools', () => {
  it('lists only the bound team’s goals, and another team’s goal is not found', async () => {
    goal('A', 'Ours')
    const theirs = goal('B', 'Theirs')
    const client = await connect(BOUND)
    const listed = JSON.parse(
      (await callText(client, 'list_goals', { teamId: 'B' })).text,
    ) as Array<{ title: string }>
    expect(listed.map((g) => g.title)).toEqual(['Ours'])
    expect((await callText(client, 'get_goal', { goalId: theirs })).isError).toBe(true)
  })

  it('reports an agent-source KPI with the run and task, and refuses the rest', async () => {
    const agentKpi = createTeamKpi(db, 'A', { name: 'Signups', source: 'agent' }, PERSON)
    const personKpi = createTeamKpi(db, 'A', { name: 'NPS', source: 'person' }, PERSON)
    const otherTeam = createTeamKpi(db, 'B', { name: 'Theirs', source: 'agent' }, PERSON)
    if (!agentKpi.ok || !personKpi.ok || !otherTeam.ok) throw new Error('setup')
    const client = await connect(BOUND)
    const ok = await callText(client, 'report_kpi', {
      kpiId: agentKpi.value.id,
      value: 12,
      sourceUrl: 'https://example.com/report',
    })
    expect(ok.isError).toBe(false)
    expect(listKpiValues(db, agentKpi.value.id)[0]).toMatchObject({
      value: 12,
      executionId: 'ex-1',
      taskId: 'task-1',
      sourceUrl: 'https://example.com/report',
      reportedBy: { kind: 'agent', id: 'coder', name: 'Coder' },
    })
    expect(
      (await callText(client, 'report_kpi', { kpiId: personKpi.value.id, value: 1 })).isError,
    ).toBe(true)
    expect(
      (await callText(client, 'report_kpi', { kpiId: otherTeam.value.id, value: 1 })).isError,
    ).toBe(true)
    const kpis = JSON.parse((await callText(client, 'list_kpis', {})).text) as Array<{
      name: string
      youMayReport: boolean
    }>
    expect(kpis.find((k) => k.name === 'Signups')?.youMayReport).toBe(true)
    expect(kpis.find((k) => k.name === 'NPS')?.youMayReport).toBe(false)
  })

  it('drafts an update without publishing it or setting health', async () => {
    const g = goal('A', 'Launch')
    const client = await connect(BOUND)
    const out = await callText(client, 'draft_goal_update', {
      goalId: g,
      body: 'Half done',
      health: 'at_risk',
    })
    expect(out.isError).toBe(false)
    expect(listGoalUpdates(db, g)[0]).toMatchObject({
      state: 'draft',
      health: 'at_risk',
      executionId: 'ex-1',
    })
    expect(getTeamGoal(db, 'A', g)?.health).toBeNull()
  })

  it('suggests a KPI and writes page revisions', async () => {
    const client = await connect(BOUND)
    await callText(client, 'suggest_kpi', { name: 'Leads', why: 'We need a funnel number' })
    expect(listSuggestedKpis(db, ['A']).map((k) => k.name)).toEqual(['Leads'])
    const made = JSON.parse(
      (await callText(client, 'write_page', { title: 'Notes', body: 'one' })).text,
    ) as {
      page: { id: string }
    }
    await callText(client, 'write_page', { pageId: made.page.id, body: 'two' })
    expect(
      listPageRevisions(db, made.page.id).map((r) => [r.revision, r.body, r.executionId]),
    ).toEqual([
      [2, 'two', 'ex-1'],
      [1, 'one', 'ex-1'],
    ])
  })

  it('serves an unidentified caller the reads only', async () => {
    const names = await listToolNames(await connect({ unverifiedCaller: true }))
    for (const read of ['list_goals', 'get_goal', 'list_kpis', 'list_pages', 'read_page'])
      expect(names).toContain(read)
    for (const write of [
      'report_kpi',
      'suggest_kpi',
      'write_page',
      'draft_goal_update',
      'write_home_summary',
    ])
      expect(names).not.toContain(write)
  })

  it('offers write_home_summary to the lead only, inside the team’s switch', async () => {
    expect(await listToolNames(await connect(BOUND))).not.toContain('write_home_summary')
    const lead = await connect({ ...BOUND, isLeadAgent: () => true })
    expect(await listToolNames(lead)).toContain('write_home_summary')
    const off = await callText(lead, 'write_home_summary', { text: 'All calm.' })
    expect(off.isError).toBe(true)
    setTeamHomeSettings(db, 'A', { leadWritesStatus: true })
    expect((await callText(lead, 'write_home_summary', { text: 'All calm.' })).isError).toBe(false)
  })
})
