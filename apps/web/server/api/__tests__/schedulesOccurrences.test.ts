// GET /api/schedules/occurrences: clawboo routines projected onto the windows a
// caller names, against the REAL routine source and a sandboxed ledger. Only
// routines the ticker will fire are projected, only after now, and the team
// filter keeps a team's calendar to its own routines.

import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { agents, scheduledRuns, teams } from '@clawboo/db'
import { nextOccurrence } from '@clawboo/scheduler'
import { eq } from 'drizzle-orm'
import type { Request, Response } from 'express'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { getDb, resetDb } from '../../lib/db'
import { resetScheduleMultiplexer } from '../../lib/scheduleSource/registry'
import {
  resetOccurrenceCache,
  schedulesCreatePOST,
  schedulesOccurrencesGET,
  schedulesUpdatePATCH,
} from '../schedules'

function mockRes(): { res: Response; status: () => number; body: () => unknown } {
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
  return { res, status: () => code, body: () => payload }
}
const req = (over: Partial<Request> = {}): Request =>
  ({ params: {}, query: {}, body: {}, ...over }) as unknown as Request

interface OccurrencesBody {
  now: number
  routines: Array<{
    schedule: { id: string; label?: string; teamId?: string | null; teamName?: string }
    windows: Array<{ count: number; more: boolean; times: number[] }>
  }>
}

const DAY = 24 * 60 * 60 * 1000

/** Local midnights from today, the edges a calendar week sends. */
function weekBounds(): number[] {
  const start = new Date()
  start.setHours(0, 0, 0, 0)
  const out: number[] = []
  for (let i = 0; i <= 7; i++) {
    const d = new Date(start)
    d.setDate(start.getDate() + i)
    out.push(d.getTime())
  }
  return out
}

async function create(body: Record<string, unknown>): Promise<string> {
  const r = mockRes()
  await schedulesCreatePOST(
    req({ body: { source: 'clawboo-routine', domain: 'team-task', ...body } }),
    r.res,
  )
  expect(r.status()).toBe(201)
  return (r.body() as { schedule: { id: string } }).schedule.id
}

async function occurrences(query: Record<string, string>): Promise<{
  status: number
  body: OccurrencesBody
}> {
  const r = mockRes()
  await schedulesOccurrencesGET(req({ query }), r.res)
  return { status: r.status(), body: r.body() as OccurrencesBody }
}

describe('GET /api/schedules/occurrences', () => {
  let home: string
  let prevHome: string | undefined

  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), 'clawboo-occurrences-rest-'))
    await mkdir(path.join(home, '.clawboo'), { recursive: true })
    prevHome = process.env['HOME']
    process.env['HOME'] = home
    process.env['CLAWBOO_HOME'] = path.join(home, '.clawboo')
    resetScheduleMultiplexer()
    const db = getDb()
    const now = Date.now()
    for (const t of [
      { id: 't1', name: 'Research' },
      { id: 't2', name: 'Growth' },
    ]) {
      db.insert(teams)
        .values({ ...t, icon: 'T', color: '#123456', createdAt: now, updatedAt: now })
        .run()
    }
    resetOccurrenceCache()
    for (const a of [
      { id: 'ada', name: 'Ada', teamId: 't1' },
      { id: 'gus', name: 'Gus', teamId: 't2' },
      { id: 'solo', name: 'Solo', teamId: null },
    ]) {
      db.insert(agents)
        .values({
          ...a,
          gatewayId: a.id,
          sourceId: 'clawboo-native',
          runtime: 'clawboo-native',
          createdAt: now,
          updatedAt: now,
        })
        .run()
    }
  })

  afterEach(async () => {
    resetDb()
    if (prevHome === undefined) delete process.env['HOME']
    else process.env['HOME'] = prevHome
    delete process.env['CLAWBOO_HOME']
    resetScheduleMultiplexer()
    await rm(home, { recursive: true, force: true }).catch(() => {})
  })

  it('projects a daily routine onto each day after now, with names resolved', async () => {
    const id = await create({
      target: 'team',
      teamId: 't1',
      cronSpec: '0 9 * * *',
      label: 'Standup',
    })
    const bounds = weekBounds()
    const { status, body } = await occurrences({ bounds: bounds.join(',') })
    expect(status).toBe(200)
    expect(body.routines).toHaveLength(1)
    const [routine] = body.routines
    expect(routine!.schedule).toMatchObject({ id, label: 'Standup', teamName: 'Research' })
    expect(routine!.windows).toHaveLength(7)
    const times = routine!.windows.flatMap((w) => w.times)
    // Exactly the instants the ticker would arm, one after another.
    let expected = nextOccurrence('0 9 * * *', body.now)
    for (const t of times) {
      expect(t).toBe(expected)
      expected = nextOccurrence('0 9 * * *', t)
    }
    expect(times.every((t) => t > body.now)).toBe(true)
    expect(times.length).toBeGreaterThanOrEqual(6)
  })

  it('leaves out paused routines and routines parked after a failure', async () => {
    const paused = await create({ agentId: 'ada', teamId: 't1', cronSpec: '0 * * * *', label: 'P' })
    const failed = await create({ agentId: 'ada', teamId: 't1', cronSpec: '0 * * * *', label: 'F' })
    const live = await create({ agentId: 'ada', teamId: 't1', cronSpec: '0 * * * *', label: 'L' })
    const r = mockRes()
    await schedulesUpdatePATCH(req({ params: { id: paused }, body: { action: 'pause' } }), r.res)
    expect(r.status()).toBe(200)
    getDb()
      .update(scheduledRuns)
      .set({ status: 'error', nextRunAt: null })
      .where(eq(scheduledRuns.id, failed.split(':')[1]!))
      .run()

    const { body } = await occurrences({ bounds: weekBounds().join(',') })
    expect(body.routines.map((x) => x.schedule.id)).toEqual([live])
  })

  it('a spent one-shot has nothing to project; a future one lands once', async () => {
    const at = Date.now() + 2 * DAY
    const future = await create({
      agentId: 'solo',
      cronSpec: `once@${new Date(at).toISOString()}`,
      label: 'Once',
    })
    const { body } = await occurrences({ bounds: weekBounds().join(',') })
    expect(body.routines.map((x) => x.schedule.id)).toEqual([future])
    expect(body.routines[0]!.windows.flatMap((w) => w.times)).toEqual([at])

    getDb()
      .update(scheduledRuns)
      .set({ status: 'idle', nextRunAt: null })
      .where(eq(scheduledRuns.id, future.split(':')[1]!))
      .run()
    const spent = await occurrences({ bounds: weekBounds().join(',') })
    expect(spent.body.routines).toEqual([])
  })

  it('keeps a team calendar to that team; a teamless routine only shows unfiltered', async () => {
    const research = await create({ target: 'team', teamId: 't1', cronSpec: '0 9 * * *' })
    const growth = await create({ target: 'team', teamId: 't2', cronSpec: '0 9 * * *' })
    const teamless = await create({ agentId: 'solo', cronSpec: '0 9 * * *' })
    const bounds = weekBounds().join(',')
    const all = await occurrences({ bounds })
    expect(all.body.routines.map((x) => x.schedule.id).sort()).toEqual(
      [research, growth, teamless].sort(),
    )
    const t1 = await occurrences({ bounds, teamId: 't1' })
    expect(t1.body.routines.map((x) => x.schedule.id)).toEqual([research])
  })

  it('reports a frequent routine as capped per day rather than listing every run', async () => {
    await create({ agentId: 'solo', cronSpec: '* * * * *', label: 'Every minute' })
    const bounds = weekBounds()
    const { body } = await occurrences({ bounds: bounds.join(',') })
    const tomorrow = body.routines[0]!.windows[1]!
    expect(tomorrow.more).toBe(true)
    expect(tomorrow.count).toBe(96)
    expect(tomorrow.times).toHaveLength(8)
  })

  it('starts an idle routine from its stored next run, the instant the ticker fires', async () => {
    const id = await create({ agentId: 'solo', cronSpec: '0 9 * * *', label: 'Daily' })
    // A next run the spec would not give from now (a spec edited mid-fire).
    const stored = weekBounds()[2]! + 17 * 60 * 60 * 1000
    getDb()
      .update(scheduledRuns)
      .set({ nextRunAt: stored })
      .where(eq(scheduledRuns.id, id.split(':')[1]!))
      .run()
    const { body } = await occurrences({ bounds: weekBounds().join(',') })
    const times = body.routines[0]!.windows.flatMap((w) => w.times)
    expect(times[0]).toBe(stored)
    expect(times[1]).toBe(nextOccurrence('0 9 * * *', stored))
  })

  it('leaves out routines whose fire could not reach their team or agent', async () => {
    const live = await create({ agentId: 'ada', teamId: 't1', cronSpec: '0 9 * * *' })
    const gusRoutine = await create({ agentId: 'gus', teamId: 't2', cronSpec: '0 9 * * *' })
    await create({ target: 'team', teamId: 't2', cronSpec: '0 9 * * *' })
    const db = getDb()
    const bounds = weekBounds().join(',')
    const ids = async () => (await occurrences({ bounds })).body.routines.map((x) => x.schedule.id)

    // Gus removed: his routine is out, and t2 has nobody left to lead its routine.
    db.update(agents).set({ archivedAt: Date.now() }).where(eq(agents.id, 'gus')).run()
    expect(await ids()).toEqual([live])

    // Gus back but t2 archived: his routine returns, the team routine stays out.
    db.update(agents).set({ archivedAt: null }).where(eq(agents.id, 'gus')).run()
    db.update(teams).set({ isArchived: 1 }).where(eq(teams.id, 't2')).run()
    resetOccurrenceCache()
    expect((await ids()).sort()).toEqual([live, gusRoutine].sort())
  })

  it('says which time zone the runs were worked out in', async () => {
    await create({ agentId: 'solo', cronSpec: '0 9 * * *' })
    const { body } = await occurrences({ bounds: weekBounds().join(',') })
    expect((body as unknown as { timeZone: string }).timeZone).toBe(
      Intl.DateTimeFormat().resolvedOptions().timeZone,
    )
  })

  it('rejects bounds that are missing, unordered, too many, or too wide (400)', async () => {
    const day0 = weekBounds()[0]!
    const bad = [
      {},
      { bounds: '' },
      { bounds: String(day0) },
      { bounds: `${day0 + DAY},${day0}` },
      { bounds: `${day0},${day0}` },
      { bounds: `${day0},abc` },
      { bounds: `${day0},${day0 + 1.5}` },
      { bounds: Array.from({ length: 65 }, (_, i) => day0 + i * 1000).join(',') },
      { bounds: `${day0},${day0 + 63 * DAY}` },
    ]
    for (const query of bad) {
      const { status, body } = await occurrences(query as Record<string, string>)
      expect(status, JSON.stringify(query)).toBe(400)
      expect((body as unknown as { code: string }).code).toBe('invalid_bounds')
    }
  })
})
