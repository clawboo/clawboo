// Home's data layer against a real SQLite file with populated tables: goal links
// on every create path and on read, goals, updates, KPIs, pages, the lead's
// status line, and the overview reads.

import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createDb, type ClawbooDb } from '../../db'
import {
  createCappedSubtask,
  createHandOffUnderRequest,
  createSubtask,
  createTask,
  getTask,
} from '../../board/repository'
import {
  agents,
  budgets,
  costRecords,
  executionProcesses,
  orchestrationEvents,
  teamKpiValues,
  tasks,
  teams,
} from '../../schema'
import {
  archiveTeamGoal,
  createTeamGoal,
  getTeamGoal,
  goalHealthHistory,
  reorderTeamGoals,
  setTeamGoalHealth,
  updateTeamGoal,
} from '../goals'
import {
  acceptKpiSuggestion,
  addPersonKpiValue,
  createTeamKpi,
  dismissKpiSuggestion,
  kpiTiles,
  listTeamKpis,
  reportAgentKpiValue,
  suggestTeamKpi,
} from '../kpis'
import { loadGoalTeams, loadTaskLinkRows, resolveGoalLinks } from '../links'
import { computeMetric, statusSentence, teamSnapshot } from '../metrics'
import { allTeamsHome, goalDetail, teamHome } from '../overview'
import {
  agentWritePage,
  archiveTeamPage,
  createTeamPage,
  listPageRevisions,
  listTeamPages,
  revertTeamPage,
  updateTeamPage,
} from '../pages'
import {
  getHomeSummary,
  LEAD_STATUS_MIN_GAP_MS,
  setTeamHomeSettings,
  takeLeadStatusAsk,
  writeHomeSummary,
} from '../summary'
import { DAY_MS, MAX_KPI_VALUES_PER_DAY, type HomeActor } from '../types'
import {
  createPublishedUpdate,
  discardGoalUpdate,
  draftGoalUpdate,
  listGoalUpdates,
  publishGoalUpdate,
} from '../updates'

let dir: string
let db: ClawbooDb

const PERSON: HomeActor = { kind: 'person', id: 'local', name: 'You' }
const BEA: HomeActor = { kind: 'agent', id: 'bea', name: 'Bea' }
const CY: HomeActor = { kind: 'agent', id: 'cy', name: 'Cy' }

/** Finish a task the way the board leaves it, at `at`. */
function finish(taskId: string, status: 'done' | 'cancelled' = 'done', at = Date.now()): void {
  db.update(tasks).set({ status, completedAt: at, updatedAt: at }).where(eq(tasks.id, taskId)).run()
}

function goal(teamId: string, title: string, extra: { parentGoalId?: string } = {}): string {
  const r = createTeamGoal(db, teamId, { title, ...extra }, PERSON)
  if (!r.ok) throw new Error(r.reason)
  return r.value.id
}

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'clawboo-home-'))
  db = createDb(path.join(dir, 'test.db'))
  const now = Date.now()
  for (const id of ['T', 'U'])
    db.insert(teams)
      .values({ id, name: `Team ${id}`, icon: 'x', color: '#000', createdAt: now, updatedAt: now })
      .run()
  db.update(teams).set({ leaderAgentId: 'bea' }).where(eq(teams.id, 'T')).run()
  for (const [id, teamId] of [
    ['bea', 'T'],
    ['cy', 'T'],
    ['dee', 'U'],
  ] as const)
    db.insert(agents)
      .values({ id, name: id, gatewayId: id, teamId, createdAt: now, updatedAt: now })
      .run()
  // Other teams' and unrelated rows, so every read below runs on populated tables.
  createTask(db, { title: 'Unrelated on U', teamId: 'U' })
  createTask(db, { title: 'Unrelated on T', teamId: 'T' })
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('goal links', () => {
  it('copies a request goal to the main task and every hand-off under it', () => {
    const g = goal('T', 'Launch')
    const request = {
      title: 'Ship the beta',
      description: 'Ship the beta',
      leadAgentId: 'bea',
      key: 'main:T:1',
      goalId: g,
    }
    const first = createHandOffUnderRequest(db, request, { title: 'Write docs', teamId: 'T' })
    if (!first.ok) throw new Error(first.reason)
    expect(first.mainTask?.goalId).toBe(g)
    expect(first.task.goalId).toBe(g)
    // A second hand-off of the same turn files under the same main task.
    const second = createHandOffUnderRequest(db, request, { title: 'Fix bugs', teamId: 'T' })
    if (!second.ok) throw new Error(second.reason)
    expect(second.task.goalId).toBe(g)
    // A subtask of a hand-off inherits too, through the capped and uncapped paths.
    const capped = createCappedSubtask(db, second.task.id, { title: 'Repro' })
    if (!capped.ok) throw new Error(capped.reason)
    expect(capped.task.goalId).toBe(g)
    expect(createSubtask(db, capped.task.id, { title: 'Deeper' }).goalId).toBe(g)
  })

  it('takes the nearest goal: a parent that names its own beats the request', () => {
    const launch = goal('T', 'Launch')
    const docs = goal('T', 'Docs')
    const main = createTask(db, { title: 'Main', teamId: 'T', goalId: launch })
    const mid = createSubtask(db, main.id, { title: 'Mid', goalId: docs })
    expect(createSubtask(db, mid.id, { title: 'Leaf' }).goalId).toBe(docs)
  })

  it('drops a goal of another team, explicit or inherited', () => {
    const onU = goal('U', 'U goal')
    expect(createTask(db, { title: 'X', teamId: 'T', goalId: onU }).goalId).toBeNull()
    const parent = createTask(db, { title: 'On U', teamId: 'U', goalId: onU })
    // A hand-off filed on T under U's work does not serve U's goal.
    expect(createSubtask(db, parent.id, { title: 'On T', teamId: 'T' }).goalId).toBeNull()
  })

  it('resolves on read work made before its request had a goal', () => {
    const main = createTask(db, { title: 'Request', teamId: 'T' })
    db.update(tasks).set({ isMainTask: 1 }).where(eq(tasks.id, main.id)).run()
    const child = createSubtask(db, main.id, { title: 'Child' })
    const grandchild = createSubtask(db, child.id, { title: 'Grandchild' })
    expect(child.goalId).toBeNull()
    const g = goal('T', 'Later goal')
    db.update(tasks).set({ goalId: g }).where(eq(tasks.id, main.id)).run()
    const rows = loadTaskLinkRows(db, ['T'])
    const links = resolveGoalLinks(db, rows, loadGoalTeams(db))
    expect(links.get(main.id)).toEqual({ goalId: g, via: 'own' })
    expect(links.get(child.id)).toEqual({ goalId: g, via: 'request' })
    expect(links.get(grandchild.id)).toEqual({ goalId: g, via: 'request' })
  })

  it('reads a stored goal of another team as none', () => {
    const onU = goal('U', 'U goal')
    const t = createTask(db, { title: 'Moved', teamId: 'T' })
    db.update(tasks).set({ goalId: onU }).where(eq(tasks.id, t.id)).run()
    const links = resolveGoalLinks(db, loadTaskLinkRows(db, ['T']), loadGoalTeams(db))
    expect(links.get(t.id)).toBeNull()
  })
})

describe('goals', () => {
  it('keeps parents one level deep, on the same team', () => {
    const top = goal('T', 'Top')
    const child = goal('T', 'Child', { parentGoalId: top })
    expect(createTeamGoal(db, 'T', { title: 'Grand', parentGoalId: child }, PERSON)).toEqual({
      ok: false,
      reason: 'parent_has_parent',
    })
    expect(updateTeamGoal(db, 'T', top, { parentGoalId: goal('T', 'Other') })).toEqual({
      ok: false,
      reason: 'goal_has_children',
    })
    expect(createTeamGoal(db, 'U', { title: 'Cross', parentGoalId: top }, PERSON)).toEqual({
      ok: false,
      reason: 'invalid_parent',
    })
    expect(updateTeamGoal(db, 'T', top, { parentGoalId: top })).toEqual({
      ok: false,
      reason: 'invalid_parent',
    })
  })

  it('archiving frees the children and keeps the tasks linked', () => {
    const top = goal('T', 'Top')
    const child = goal('T', 'Child', { parentGoalId: top })
    const t = createTask(db, { title: 'Work', teamId: 'T', goalId: top })
    expect(archiveTeamGoal(db, 'T', top).ok).toBe(true)
    expect(getTeamGoal(db, 'T', child)?.parentGoalId).toBeNull()
    expect(getTask(db, t.id)?.goalId).toBe(top)
  })

  it('reorders, keeping unnamed goals after the named ones', () => {
    const a = goal('T', 'A')
    const b = goal('T', 'B')
    const c = goal('T', 'C')
    const r = reorderTeamGoals(db, 'T', [c, 'nope', a])
    if (!r.ok) throw new Error(r.reason)
    expect(r.value.map((g) => g.id)).toEqual([c, a, b])
  })

  it('records every health change, and a goal of another team is not found', () => {
    const g = goal('T', 'G')
    setTeamGoalHealth(db, 'T', g, 'at_risk', PERSON)
    setTeamGoalHealth(db, 'T', g, null, PERSON)
    expect(goalHealthHistory(db, g).map((h) => h.health)).toEqual([null, 'at_risk'])
    expect(setTeamGoalHealth(db, 'U', g, 'on_track', PERSON)).toEqual({
      ok: false,
      reason: 'goal_not_found',
    })
  })
})

describe('goal updates', () => {
  it('an agent drafts and never publishes; a person publishes with its health', () => {
    const g = goal('T', 'G')
    const draft = draftGoalUpdate(db, {
      goalId: g,
      teamId: 'T',
      body: 'On track so far',
      health: 'on_track',
      agent: BEA,
      executionId: 'ex-1',
    })
    if (!draft.ok) throw new Error(draft.reason)
    expect(draft.value.state).toBe('draft')
    expect(getTeamGoal(db, 'T', g)?.health).toBeNull()
    const published = publishGoalUpdate(
      db,
      'T',
      draft.value.id,
      { body: 'Edited by a person' },
      PERSON,
    )
    if (!published.ok) throw new Error(published.reason)
    expect(published.value.update.body).toBe('Edited by a person')
    expect(published.value.update.publishedBy).toEqual(PERSON)
    expect(published.value.goal.health).toBe('on_track')
    expect(goalHealthHistory(db, g)[0]?.updateId).toBe(draft.value.id)
    expect(publishGoalUpdate(db, 'T', draft.value.id, {}, PERSON)).toEqual({
      ok: false,
      reason: 'not_draft',
    })
    const kinds = db
      .select({ kind: orchestrationEvents.kind })
      .from(orchestrationEvents)
      .all()
      .map((e) => e.kind)
    expect(kinds).toContain('goal_update_drafted')
    expect(kinds).toContain('goal_update_published')
  })

  it('a second draft by the same agent replaces its first; other agents stack', () => {
    const g = goal('T', 'G')
    const first = draftGoalUpdate(db, { goalId: g, teamId: 'T', body: 'One', agent: BEA })
    draftGoalUpdate(db, { goalId: g, teamId: 'T', body: 'Two', agent: BEA })
    draftGoalUpdate(db, { goalId: g, teamId: 'T', body: 'Cy', agent: CY })
    const states = listGoalUpdates(db, g).map((u) => [u.body, u.state])
    expect(states).toContainEqual(['One', 'discarded'])
    expect(states).toContainEqual(['Two', 'draft'])
    expect(states).toContainEqual(['Cy', 'draft'])
    expect(first.ok).toBe(true)
  })

  it('refuses another team, and a discarded draft cannot be published', () => {
    const g = goal('T', 'G')
    expect(draftGoalUpdate(db, { goalId: g, teamId: 'U', body: 'x', agent: BEA })).toEqual({
      ok: false,
      reason: 'goal_not_found',
    })
    const d = draftGoalUpdate(db, { goalId: g, teamId: 'T', body: 'x', agent: BEA })
    if (!d.ok) throw new Error(d.reason)
    expect(discardGoalUpdate(db, 'T', d.value.id).ok).toBe(true)
    expect(publishGoalUpdate(db, 'T', d.value.id, {}, PERSON)).toEqual({
      ok: false,
      reason: 'not_draft',
    })
  })

  it("a person's own update is published at once", () => {
    const g = goal('T', 'G')
    const r = createPublishedUpdate(
      db,
      'T',
      g,
      { body: 'Done with phase 1', health: 'at_risk' },
      PERSON,
    )
    if (!r.ok) throw new Error(r.reason)
    expect(r.value.update.state).toBe('published')
    expect(r.value.goal.health).toBe('at_risk')
  })
})

describe('KPIs', () => {
  it('an agent reports only an active agent-source KPI of its own team, as its reporter', () => {
    const agentKpi = createTeamKpi(
      db,
      'T',
      { name: 'Signups', source: 'agent', reporterAgentId: 'bea' },
      PERSON,
    )
    const personKpi = createTeamKpi(db, 'T', { name: 'NPS', source: 'person' }, PERSON)
    if (!agentKpi.ok || !personKpi.ok) throw new Error('setup')
    const report = (kpiId: string, agent: HomeActor, teamId = 'T') =>
      reportAgentKpiValue(db, {
        kpiId,
        teamId,
        agent,
        value: 3,
        executionId: 'ex-9',
        taskId: 't-9',
      })
    expect(report(personKpi.value.id, BEA)).toEqual({ ok: false, reason: 'wrong_source' })
    expect(report(agentKpi.value.id, CY)).toEqual({ ok: false, reason: 'not_reporter' })
    expect(report(agentKpi.value.id, BEA, 'U')).toEqual({ ok: false, reason: 'kpi_not_found' })
    const ok = report(agentKpi.value.id, BEA)
    if (!ok.ok) throw new Error(ok.reason)
    expect(ok.value).toMatchObject({ executionId: 'ex-9', taskId: 't-9', reportedBy: BEA })
    const kinds = db
      .select({ kind: orchestrationEvents.kind })
      .from(orchestrationEvents)
      .all()
      .map((e) => e.kind)
    expect(kinds).toContain('kpi_reported')
  })

  it('a suggestion waits for a person, who accepts it with edits or dismisses it', () => {
    const s = suggestTeamKpi(db, {
      teamId: 'T',
      name: 'Churn',
      unit: '%',
      direction: 'down',
      target: 99,
      why: 'We lose users',
      agent: BEA,
    })
    if (!s.ok) throw new Error(s.reason)
    expect(s.value).toMatchObject({
      status: 'suggested',
      suggestedBy: BEA,
      suggestionNote: 'We lose users',
    })
    expect(listTeamKpis(db, 'T', { statuses: ['active'] })).toHaveLength(0)
    const accepted = acceptKpiSuggestion(db, 'T', s.value.id, { target: 5 }, PERSON)
    if (!accepted.ok) throw new Error(accepted.reason)
    expect(accepted.value).toMatchObject({ status: 'active', target: 5, createdBy: PERSON })
    const other = suggestTeamKpi(db, { teamId: 'T', name: 'Other', why: 'x', agent: BEA })
    if (!other.ok) throw new Error(other.reason)
    expect(dismissKpiSuggestion(db, 'T', other.value.id).ok).toBe(true)
    expect(acceptKpiSuggestion(db, 'T', other.value.id, {}, PERSON)).toEqual({
      ok: false,
      reason: 'not_suggested',
    })
  })

  it('a computed KPI needs a metric; a person types only a person-source value', () => {
    expect(createTeamKpi(db, 'T', { name: 'Done', source: 'computed' }, PERSON)).toEqual({
      ok: false,
      reason: 'invalid',
    })
    const computed = createTeamKpi(
      db,
      'T',
      { name: 'Done', source: 'computed', metric: 'tasks_done' },
      PERSON,
    )
    if (!computed.ok) throw new Error(computed.reason)
    expect(addPersonKpiValue(db, 'T', computed.value.id, { value: 1 }, PERSON)).toEqual({
      ok: false,
      reason: 'wrong_source',
    })
  })

  it('marks an old value stale and a missing one missing', () => {
    const k = createTeamKpi(
      db,
      'T',
      { name: 'MRR', unit: '$', source: 'person', staleAfterHours: 24 },
      PERSON,
    )
    if (!k.ok) throw new Error(k.reason)
    const snap = () => teamSnapshot(db, 'T')
    expect(kpiTiles(db, [k.value], snap())[0]?.reading.freshness).toBe('missing')
    addPersonKpiValue(db, 'T', k.value.id, { value: 100, asOf: Date.now() - 2 * DAY_MS }, PERSON)
    expect(kpiTiles(db, [k.value], snap())[0]?.reading).toMatchObject({
      value: 100,
      freshness: 'stale',
    })
    addPersonKpiValue(db, 'T', k.value.id, { value: 120 }, PERSON)
    expect(kpiTiles(db, [k.value], snap())[0]?.reading).toMatchObject({
      value: 120,
      freshness: 'ok',
    })
  })

  it('caps the values one KPI takes in a day', () => {
    const k = createTeamKpi(db, 'T', { name: 'Calls', source: 'person' }, PERSON)
    if (!k.ok) throw new Error(k.reason)
    const now = Date.now()
    db.insert(teamKpiValues)
      .values(
        Array.from({ length: MAX_KPI_VALUES_PER_DAY }, (_, i) => ({
          id: `v${i}`,
          kpiId: k.value.id,
          value: i,
          asOf: now,
          createdAt: now,
        })),
      )
      .run()
    expect(addPersonKpiValue(db, 'T', k.value.id, { value: 1 }, PERSON)).toEqual({
      ok: false,
      reason: 'too_many',
    })
  })

  it('computes board metrics over the period', () => {
    const done = createTask(db, { title: 'Done now', teamId: 'T' })
    finish(done.id)
    const old = createTask(db, { title: 'Done long ago', teamId: 'T' })
    finish(old.id, 'done', Date.now() - 10 * DAY_MS)
    const checked = createTask(db, { title: 'Checked', teamId: 'T' })
    finish(checked.id)
    db.update(tasks)
      .set({ verification: JSON.stringify({ status: 'pass', attempts: [] }) })
      .where(eq(tasks.id, checked.id))
      .run()
    const snap = teamSnapshot(db, 'T')
    expect(computeMetric(db, snap, 'tasks_done', 'week')).toBe(2)
    expect(computeMetric(db, snap, 'tasks_done', 'month')).toBe(3)
    expect(computeMetric(db, snap, 'tasks_checked_done', 'week')).toBe(1)
    db.insert(budgets)
      .values({
        id: 'b',
        scope: 'team',
        scopeId: 'T',
        limitUsdCents: 6000,
        spentUsdCents: 1500,
        spentMicroCents: 15_000_000,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
      .run()
    expect(computeMetric(db, snap, 'budget_used_pct', 'week')).toBeCloseTo(25)
    db.insert(costRecords)
      .values({
        agentId: 'bea',
        model: 'm',
        inputTokens: 1,
        outputTokens: 1,
        costUsd: 2.5,
        createdAt: Date.now(),
      })
      .run()
    db.insert(costRecords)
      .values({
        agentId: 'dee',
        model: 'm',
        inputTokens: 1,
        outputTokens: 1,
        costUsd: 9,
        createdAt: Date.now(),
      })
      .run()
    expect(computeMetric(db, snap, 'spend_usd', 'week')).toBeCloseTo(2.5)
  })
})

describe('pages', () => {
  it('keeps every revision; the same words make none; a revert copies an old one', () => {
    const p = createTeamPage(db, 'T', { title: 'Plan', body: 'v1' }, { actor: PERSON })
    if (!p.ok) throw new Error(p.reason)
    expect(p.value.revision).toBe(1)
    const same = updateTeamPage(db, 'T', p.value.id, { body: 'v1' }, { actor: PERSON })
    expect(same.ok && same.value.revision).toBe(1)
    const byAgent = agentWritePage(db, {
      teamId: 'T',
      pageId: p.value.id,
      body: 'v2 by agent',
      agent: BEA,
      executionId: 'ex-3',
    })
    if (!byAgent.ok) throw new Error(byAgent.reason)
    expect(byAgent.value).toMatchObject({ revision: 2, body: 'v2 by agent', updatedBy: BEA })
    const reverted = revertTeamPage(db, 'T', p.value.id, 1, { actor: PERSON })
    if (!reverted.ok) throw new Error(reverted.reason)
    expect(reverted.value).toMatchObject({ revision: 3, body: 'v1' })
    const revs = listPageRevisions(db, p.value.id)
    expect(revs.map((r) => [r.revision, r.body, r.revertedFrom])).toEqual([
      [3, 'v1', 1],
      [2, 'v2 by agent', null],
      [1, 'v1', null],
    ])
    expect(revs[1]?.executionId).toBe('ex-3')
  })

  it('refuses another team, and an archived page takes no revision', () => {
    const p = createTeamPage(db, 'T', { title: 'Plan', pinned: true }, { actor: PERSON })
    if (!p.ok) throw new Error(p.reason)
    expect(updateTeamPage(db, 'U', p.value.id, { body: 'x' }, { actor: PERSON })).toEqual({
      ok: false,
      reason: 'page_not_found',
    })
    archiveTeamPage(db, 'T', p.value.id)
    expect(updateTeamPage(db, 'T', p.value.id, { body: 'x' }, { actor: PERSON })).toEqual({
      ok: false,
      reason: 'archived',
    })
    expect(listTeamPages(db, 'T', { pinnedOnly: true })).toHaveLength(0)
  })
})

describe("the lead's status line", () => {
  it('only when turned on, by the lead, when the board moved, inside the limits', () => {
    const write = (body: string, now: number, isLead = true) =>
      writeHomeSummary(db, { teamId: 'T', agent: BEA, isLead, body }, now)
    const t0 = Date.now()
    expect(write('Hello', t0)).toEqual({ ok: false, reason: 'not_enabled' })
    setTeamHomeSettings(db, 'T', { leadWritesStatus: true })
    expect(write('Hello', t0, false)).toEqual({ ok: false, reason: 'not_lead' })
    const first = write('Two requests in flight.', t0)
    expect(first.ok).toBe(true)
    // Nothing moved on the board since.
    expect(write('Again', t0 + LEAD_STATUS_MIN_GAP_MS + 1)).toEqual({
      ok: false,
      reason: 'unchanged',
    })
    const task = createTask(db, { title: 'New work', teamId: 'T' })
    db.update(tasks)
      .set({ updatedAt: t0 + 1000 })
      .where(eq(tasks.id, task.id))
      .run()
    expect(write('Too soon', t0 + 60_000)).toEqual({ ok: false, reason: 'too_soon' })
    expect(write('Later', t0 + LEAD_STATUS_MIN_GAP_MS + 1).ok).toBe(true)
    expect(getHomeSummary(db, 'T')?.body).toBe('Later')
  })

  it('asks at most once per window, and only when on', () => {
    expect(takeLeadStatusAsk(db, 'T')).toBe(false)
    setTeamHomeSettings(db, 'T', { leadWritesStatus: true })
    const now = Date.now()
    expect(takeLeadStatusAsk(db, 'T', now)).toBe(true)
    expect(takeLeadStatusAsk(db, 'T', now + 1000)).toBe(false)
    expect(takeLeadStatusAsk(db, 'T', now + LEAD_STATUS_MIN_GAP_MS + 1)).toBe(true)
  })
})

describe('overview', () => {
  it("counts a goal's progress without requests' own cards, cancelled or removed tasks, and rolls children up", () => {
    const top = goal('T', 'Top')
    const child = goal('T', 'Child', { parentGoalId: top })
    const main = createTask(db, { title: 'Request', teamId: 'T', goalId: top })
    db.update(tasks).set({ isMainTask: 1 }).where(eq(tasks.id, main.id)).run()
    const a = createSubtask(db, main.id, { title: 'A' })
    finish(a.id)
    db.update(tasks)
      .set({ verification: JSON.stringify({ status: 'pass', attempts: [] }) })
      .where(eq(tasks.id, a.id))
      .run()
    createSubtask(db, main.id, { title: 'B' })
    const c = createSubtask(db, main.id, { title: 'Cancelled' })
    finish(c.id, 'cancelled')
    const dropped = createSubtask(db, main.id, { title: 'Dropped' })
    db.update(tasks).set({ dropped: 1 }).where(eq(tasks.id, dropped.id)).run()
    createTask(db, { title: 'Child work', teamId: 'T', goalId: child })
    db.insert(executionProcesses)
      .values({
        id: 'ex-a',
        taskId: a.id,
        executorType: 'x',
        status: 'succeeded',
        costUsd: 1.25,
        costSource: 'estimate',
        createdAt: Date.now(),
      } as never)
      .run()
    const detail = goalDetail(db, 'T', top)
    if (!detail) throw new Error('no detail')
    expect(detail.summary.progress).toMatchObject({
      total: 3,
      done: 1,
      doneChecked: 1,
      addedLast7Days: 3,
    })
    expect(detail.summary.cost).toEqual({ usd: 1.25, includesEstimates: true })
    expect(detail.children.map((s) => s.goal.id)).toEqual([child])
    expect(detail.tasks.find((t) => t.taskId === a.id)?.linkedVia).toBe('own')
    expect(goalDetail(db, 'U', top)).toBeNull()
  })

  it('marks a goal with no update inside its cadence', () => {
    const g = goal('T', 'Quiet')
    updateTeamGoal(db, 'T', g, { updateCadenceDays: 1 })
    const later = Date.now() + 2 * DAY_MS
    const home = teamHome(db, 'T', later)
    expect(home?.goals.find((s) => s.goal.id === g)?.updateMissing).toBe(true)
    createPublishedUpdate(db, 'T', g, { body: 'Fine' }, PERSON)
    expect(teamHome(db, 'T')?.goals.find((s) => s.goal.id === g)?.updateMissing).toBe(false)
  })

  it("puts drafts and suggestions in Needs you, and the lead's fresh line in the status", () => {
    const g = goal('T', 'G')
    draftGoalUpdate(db, { goalId: g, teamId: 'T', body: 'Draft', agent: BEA })
    suggestTeamKpi(db, { teamId: 'T', name: 'Leads', why: 'x', agent: BEA })
    const home = teamHome(db, 'T')
    if (!home) throw new Error('no home')
    expect(home.needsYou.draftUpdates).toMatchObject([{ goalId: g, goalTitle: 'G' }])
    expect(home.needsYou.suggestedKpis).toHaveLength(1)
    expect(home.needsYou.total).toBeGreaterThanOrEqual(2)
    expect(home.status.source).toBe('computed')
    setTeamHomeSettings(db, 'T', { leadWritesStatus: true })
    writeHomeSummary(db, { teamId: 'T', agent: BEA, isLead: true, body: 'All calm.' })
    expect(teamHome(db, 'T')?.status).toMatchObject({
      source: 'lead',
      text: 'All calm.',
      author: BEA,
    })
    expect(teamHome(db, 'nope')).toBeNull()
  })

  it('All teams: one row per team, totals, and a guest cut to their teams', () => {
    const g = goal('T', 'G')
    setTeamGoalHealth(db, 'T', g, 'at_risk', PERSON)
    const all = allTeamsHome(db)
    expect(all.teams.map((r) => r.team.id)).toEqual(['T', 'U'])
    expect(all.totals).toMatchObject({ goalsActive: 1, goalsAtRisk: 1 })
    expect(allTeamsHome(db, { teamIds: ['U'] }).teams.map((r) => r.team.id)).toEqual(['U'])
  })

  it('says the computed status line in words', () => {
    expect(
      statusSentence({
        requestsInFlight: 2,
        needsYou: 1,
        doneLast7Days: 3,
        spentLast7DaysUsd: 4,
        budgetLimitUsd: 60,
        budgetSpentUsd: 12,
      }),
    ).toBe('2 requests in flight, 1 needs you, 3 done this week, $12 of $60 spent.')
    expect(
      statusSentence({
        requestsInFlight: 0,
        needsYou: 0,
        doneLast7Days: 0,
        spentLast7DaysUsd: 0,
        budgetLimitUsd: null,
        budgetSpentUsd: null,
      }),
    ).toBe('Nothing in flight.')
  })
})
