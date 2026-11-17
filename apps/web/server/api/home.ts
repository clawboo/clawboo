// Home: one read for a team's Home or for All teams (GET /api/home), and the
// writes behind it under /api/home/teams/:teamId. The typed client is
// @clawboo/control-client's home.ts; the shapes here are its shapes.
//
// Every write is a person's (`refuseUnlessPerson`): agents reach Home only
// through the Tasks MCP tools, and only to report a KPI value, suggest a KPI,
// write a page or draft a goal update. A goal, KPI, page or update of another
// team answers 404, the same as one that does not exist.

import {
  acceptKpiSuggestion,
  addPersonKpiValue,
  allTeamsHome,
  appendAudit,
  archiveTeamGoal,
  archiveTeamKpi,
  archiveTeamPage,
  buildGoalIndex,
  createPublishedUpdate,
  createTeamGoal,
  createTeamKpi,
  createTeamPage,
  discardGoalUpdate,
  dismissKpiSuggestion,
  getTeamGoal,
  getTeamHomeSettings,
  getTeamKpi,
  getPageRevision,
  getTeamPage,
  goalDetail,
  goalSummaries,
  homeCreateGoalBody,
  homeCreateKpiBody,
  homeCreatePageBody,
  homeCreateUpdateBody,
  homeHealthBody,
  homePinBody,
  homePublishBody,
  homeReorderBody,
  homeRevertBody,
  homeSettingsBody,
  homeUpdateGoalBody,
  homeUpdateKpiBody,
  homeUpdatePageBody,
  homeValueBody,
  kpiTiles,
  listGoalUpdates,
  listKpiValues,
  listPageRevisions,
  listTeamGoals,
  listTeamKpis,
  listTeamPages,
  PAGE_REVISIONS_LIST_MAX,
  publishGoalUpdate,
  reorderTeamGoals,
  revertTeamPage,
  setTeamGoalHealth,
  setTeamHomeSettings,
  setTeamPagePinned,
  teamExistsForHome,
  teamPageExists,
  teamHome,
  teamSnapshot,
  updateTeamGoal,
  updateTeamKpi,
  updateTeamPage,
  type ClawbooDb,
  type HomeActor,
  type HomeRefusal,
  type HomeResult,
  type TeamKpiRecord,
} from '@clawboo/db'
import { InvalidRoutineTargetError } from '@clawboo/scheduler'
import type { Request, Response } from 'express'

import { actingPerson, actorField, refuseUnlessPerson } from '../lib/auth'
import { getDb } from '../lib/db'
import { homeSettingsFor, leadCanWriteStatus } from '../lib/home/leadStatus'
import { recentTeamFiles } from '../lib/home/recentFiles'
import { turnOnWeeklyUpdates } from '../lib/home/weeklyUpdates'
import { inRoleScope, roleScopeOf } from '../lib/roles/guard'

// ─── Shared ──────────────────────────────────────────────────────────────────

const NOT_FOUND: ReadonlySet<HomeRefusal> = new Set([
  'team_not_found',
  'goal_not_found',
  'update_not_found',
  'kpi_not_found',
  'page_not_found',
  'revision_not_found',
])
const CONFLICT: ReadonlySet<HomeRefusal> = new Set([
  'goal_archived',
  'not_draft',
  'not_suggested',
  'not_active',
  'archived',
  'too_many',
])

/** The status a refusal answers with: 404 not found, 409 a state conflict, else 400. */
export function refusalStatus(reason: HomeRefusal): number {
  if (NOT_FOUND.has(reason)) return 404
  if (CONFLICT.has(reason)) return 409
  if (reason === 'not_reporter') return 403
  return 400
}

function sendRefusal(res: Response, reason: HomeRefusal): void {
  res.status(refusalStatus(reason)).json({ ok: false, error: reason })
}

/** Answer a write's result: `ok` through `onOk`, a refusal as its status. */
function answer<T>(res: Response, result: HomeResult<T>, onOk: (value: T) => unknown): void {
  if (!result.ok) {
    sendRefusal(res, result.reason)
    return
  }
  res.json(onOk(result.value))
}

function param(req: Request, name: string): string {
  const v = req.params[name]
  return typeof v === 'string' ? v : ''
}

function personActor(req: Request): HomeActor {
  const p = actingPerson(req)
  return { kind: 'person', id: p.id, name: p.name ?? null }
}

/** The team in the path, when it exists; answers 404 itself when not. */
function teamOf(req: Request, res: Response, db: ClawbooDb): string | null {
  const teamId = param(req, 'teamId')
  if (!teamId || !teamExistsForHome(db, teamId)) {
    sendRefusal(res, 'team_not_found')
    return null
  }
  return teamId
}

function badBody(res: Response, error: { flatten(): unknown }): void {
  res.status(400).json({ ok: false, error: 'invalid', details: error.flatten() })
}

function handle(fn: (req: Request, res: Response) => void | Promise<void>) {
  return async (req: Request, res: Response): Promise<void> => {
    try {
      await fn(req, res)
    } catch (err) {
      if (!res.headersSent) res.status(500).json({ ok: false, error: String(err) })
    }
  }
}

const flag = (v: unknown): boolean => v === 'true' || v === '1'

/**
 * A whole-number query or path value within [min, max]: `undefined` when absent,
 * `null` when present and not one (the caller answers 400). Never a fraction, which
 * SQLite would refuse as a LIMIT.
 */
function wholeNumber(
  raw: unknown,
  min: number,
  max = Number.MAX_SAFE_INTEGER,
): number | null | undefined {
  if (raw === undefined) return undefined
  if (typeof raw !== 'string' || !/^\d{1,15}$/.test(raw)) return null
  const n = Number(raw)
  return n >= min && n <= max ? n : null
}

// ─── GET /api/home?teamId= ───────────────────────────────────────────────────

export const homeGET = handle(async (req, res) => {
  const db = getDb()
  const teamId = typeof req.query['teamId'] === 'string' ? req.query['teamId'] : ''
  if (teamId && teamId !== 'all') {
    if (!inRoleScope(req, teamId)) {
      sendRefusal(res, 'team_not_found')
      return
    }
    const home = teamHome(db, teamId)
    if (!home) {
      sendRefusal(res, 'team_not_found')
      return
    }
    const recentFiles = await recentTeamFiles(db, teamId).catch(() => [])
    res.json({
      scope: 'team',
      home: { ...home, settings: homeSettingsFor(db, teamId), recentFiles },
    })
    return
  }
  const scope = roleScopeOf(req)
  res.json({
    scope: 'all',
    home: allTeamsHome(db, scope ? { teamIds: [...scope.teams] } : {}),
  })
})

// ─── Goals ───────────────────────────────────────────────────────────────────

export const homeGoalsGET = handle((req, res) => {
  const db = getDb()
  const teamId = teamOf(req, res, db)
  if (!teamId) return
  const goals = listTeamGoals(db, teamId, { includeArchived: flag(req.query['includeArchived']) })
  res.json({ goals: goalSummaries(db, goals, buildGoalIndex(db, goals, [teamId])) })
})

export const homeGoalGET = handle((req, res) => {
  const db = getDb()
  const teamId = teamOf(req, res, db)
  if (!teamId) return
  const goal = goalDetail(db, teamId, param(req, 'goalId'))
  if (!goal) {
    sendRefusal(res, 'goal_not_found')
    return
  }
  res.json({ goal })
})

export const homeGoalsPOST = handle((req, res) => {
  if (refuseUnlessPerson(req, res)) return
  const db = getDb()
  const teamId = teamOf(req, res, db)
  if (!teamId) return
  const body = homeCreateGoalBody.safeParse(req.body)
  if (!body.success) return badBody(res, body.error)
  answer(res, createTeamGoal(db, teamId, body.data, personActor(req)), (goal) => ({ goal }))
})

export const homeGoalPATCH = handle((req, res) => {
  if (refuseUnlessPerson(req, res)) return
  const db = getDb()
  const teamId = teamOf(req, res, db)
  if (!teamId) return
  const body = homeUpdateGoalBody.safeParse(req.body)
  if (!body.success) return badBody(res, body.error)
  answer(res, updateTeamGoal(db, teamId, param(req, 'goalId'), body.data), (goal) => ({ goal }))
})

export const homeGoalDELETE = handle((req, res) => {
  if (refuseUnlessPerson(req, res)) return
  const db = getDb()
  const teamId = teamOf(req, res, db)
  if (!teamId) return
  answer(res, archiveTeamGoal(db, teamId, param(req, 'goalId')), (goal) => ({ goal }))
})

export const homeGoalHealthPOST = handle((req, res) => {
  if (refuseUnlessPerson(req, res)) return
  const db = getDb()
  const teamId = teamOf(req, res, db)
  if (!teamId) return
  const body = homeHealthBody.safeParse(req.body)
  if (!body.success) return badBody(res, body.error)
  answer(
    res,
    setTeamGoalHealth(db, teamId, param(req, 'goalId'), body.data.health, personActor(req)),
    (goal) => ({ goal }),
  )
})

export const homeGoalsReorderPOST = handle((req, res) => {
  if (refuseUnlessPerson(req, res)) return
  const db = getDb()
  const teamId = teamOf(req, res, db)
  if (!teamId) return
  const body = homeReorderBody.safeParse(req.body)
  if (!body.success) return badBody(res, body.error)
  answer(res, reorderTeamGoals(db, teamId, body.data.goalIds), (goals) => ({ goals }))
})

// ─── Goal updates ────────────────────────────────────────────────────────────

export const homeGoalUpdatesGET = handle((req, res) => {
  const db = getDb()
  const teamId = teamOf(req, res, db)
  if (!teamId) return
  const goalId = param(req, 'goalId')
  if (!getTeamGoal(db, teamId, goalId)) {
    sendRefusal(res, 'goal_not_found')
    return
  }
  res.json({ updates: listGoalUpdates(db, goalId) })
})

export const homeGoalUpdatesPOST = handle((req, res) => {
  if (refuseUnlessPerson(req, res)) return
  const db = getDb()
  const teamId = teamOf(req, res, db)
  if (!teamId) return
  const body = homeCreateUpdateBody.safeParse(req.body)
  if (!body.success) return badBody(res, body.error)
  answer(
    res,
    createPublishedUpdate(db, teamId, param(req, 'goalId'), body.data, personActor(req)),
    (v) => v,
  )
})

export const homeUpdatePublishPOST = handle((req, res) => {
  if (refuseUnlessPerson(req, res)) return
  const db = getDb()
  const teamId = teamOf(req, res, db)
  if (!teamId) return
  const body = homePublishBody.safeParse(req.body ?? {})
  if (!body.success) return badBody(res, body.error)
  answer(
    res,
    publishGoalUpdate(db, teamId, param(req, 'updateId'), body.data, personActor(req)),
    (v) => v,
  )
})

export const homeUpdateDiscardPOST = handle((req, res) => {
  if (refuseUnlessPerson(req, res)) return
  const db = getDb()
  const teamId = teamOf(req, res, db)
  if (!teamId) return
  answer(res, discardGoalUpdate(db, teamId, param(req, 'updateId')), (update) => ({ update }))
})

// ─── KPIs ────────────────────────────────────────────────────────────────────

function tileOf(db: ClawbooDb, kpi: TeamKpiRecord) {
  return kpiTiles(db, [kpi], teamSnapshot(db, kpi.teamId))[0]!
}

export const homeKpisGET = handle((req, res) => {
  const db = getDb()
  const teamId = teamOf(req, res, db)
  if (!teamId) return
  const kpis = listTeamKpis(db, teamId, {
    statuses: flag(req.query['includeArchived'])
      ? ['active', 'suggested', 'archived']
      : ['active', 'suggested'],
  })
  res.json({ kpis: kpiTiles(db, kpis, teamSnapshot(db, teamId)) })
})

export const homeKpisPOST = handle((req, res) => {
  if (refuseUnlessPerson(req, res)) return
  const db = getDb()
  const teamId = teamOf(req, res, db)
  if (!teamId) return
  const body = homeCreateKpiBody.safeParse(req.body)
  if (!body.success) return badBody(res, body.error)
  answer(res, createTeamKpi(db, teamId, body.data, personActor(req)), (kpi) => ({
    kpi: tileOf(db, kpi),
  }))
})

export const homeKpiPATCH = handle((req, res) => {
  if (refuseUnlessPerson(req, res)) return
  const db = getDb()
  const teamId = teamOf(req, res, db)
  if (!teamId) return
  const body = homeUpdateKpiBody.safeParse(req.body)
  if (!body.success) return badBody(res, body.error)
  answer(res, updateTeamKpi(db, teamId, param(req, 'kpiId'), body.data), (kpi) => ({
    kpi: tileOf(db, kpi),
  }))
})

export const homeKpiDELETE = handle((req, res) => {
  if (refuseUnlessPerson(req, res)) return
  const db = getDb()
  const teamId = teamOf(req, res, db)
  if (!teamId) return
  answer(res, archiveTeamKpi(db, teamId, param(req, 'kpiId')), (kpi) => ({ kpi }))
})

export const homeKpiAcceptPOST = handle((req, res) => {
  if (refuseUnlessPerson(req, res)) return
  const db = getDb()
  const teamId = teamOf(req, res, db)
  if (!teamId) return
  const body = homeUpdateKpiBody.safeParse(req.body ?? {})
  if (!body.success) return badBody(res, body.error)
  answer(
    res,
    acceptKpiSuggestion(db, teamId, param(req, 'kpiId'), body.data, personActor(req)),
    (kpi) => ({ kpi: tileOf(db, kpi) }),
  )
})

export const homeKpiDismissPOST = handle((req, res) => {
  if (refuseUnlessPerson(req, res)) return
  const db = getDb()
  const teamId = teamOf(req, res, db)
  if (!teamId) return
  answer(res, dismissKpiSuggestion(db, teamId, param(req, 'kpiId')), (kpi) => ({ kpi }))
})

export const homeKpiValuesPOST = handle((req, res) => {
  if (refuseUnlessPerson(req, res)) return
  const db = getDb()
  const teamId = teamOf(req, res, db)
  if (!teamId) return
  const body = homeValueBody.safeParse(req.body)
  if (!body.success) return badBody(res, body.error)
  const kpiId = param(req, 'kpiId')
  answer(res, addPersonKpiValue(db, teamId, kpiId, body.data, personActor(req)), (value) => ({
    value,
    kpi: tileOf(db, getTeamKpi(db, teamId, kpiId)!),
  }))
})

export const homeKpiValuesGET = handle((req, res) => {
  const db = getDb()
  const teamId = teamOf(req, res, db)
  if (!teamId) return
  const kpiId = param(req, 'kpiId')
  if (!getTeamKpi(db, teamId, kpiId)) {
    sendRefusal(res, 'kpi_not_found')
    return
  }
  const limit = wholeNumber(req.query['limit'], 1, 1000)
  if (limit === null) {
    sendRefusal(res, 'invalid')
    return
  }
  res.json({ values: listKpiValues(db, kpiId, limit ?? 100) })
})

// ─── Pages ───────────────────────────────────────────────────────────────────

export const homePagesGET = handle((req, res) => {
  const db = getDb()
  const teamId = teamOf(req, res, db)
  if (!teamId) return
  const goalId = typeof req.query['goalId'] === 'string' ? req.query['goalId'] : undefined
  res.json({
    pages: listTeamPages(db, teamId, {
      includeArchived: flag(req.query['includeArchived']),
      ...(goalId ? { goalId } : {}),
    }),
  })
})

export const homePageGET = handle((req, res) => {
  const db = getDb()
  const teamId = teamOf(req, res, db)
  if (!teamId) return
  const page = getTeamPage(db, teamId, param(req, 'pageId'))
  if (!page) {
    sendRefusal(res, 'page_not_found')
    return
  }
  res.json({ page })
})

export const homePagesPOST = handle((req, res) => {
  if (refuseUnlessPerson(req, res)) return
  const db = getDb()
  const teamId = teamOf(req, res, db)
  if (!teamId) return
  const body = homeCreatePageBody.safeParse(req.body)
  if (!body.success) return badBody(res, body.error)
  answer(res, createTeamPage(db, teamId, body.data, { actor: personActor(req) }), (page) => ({
    page,
  }))
})

export const homePagePATCH = handle((req, res) => {
  if (refuseUnlessPerson(req, res)) return
  const db = getDb()
  const teamId = teamOf(req, res, db)
  if (!teamId) return
  const body = homeUpdatePageBody.safeParse(req.body)
  if (!body.success) return badBody(res, body.error)
  answer(
    res,
    updateTeamPage(db, teamId, param(req, 'pageId'), body.data, { actor: personActor(req) }),
    (page) => ({ page }),
  )
})

export const homePageDELETE = handle((req, res) => {
  if (refuseUnlessPerson(req, res)) return
  const db = getDb()
  const teamId = teamOf(req, res, db)
  if (!teamId) return
  answer(res, archiveTeamPage(db, teamId, param(req, 'pageId')), (page) => ({ page }))
})

export const homePageRevisionsGET = handle((req, res) => {
  const db = getDb()
  const teamId = teamOf(req, res, db)
  if (!teamId) return
  const pageId = param(req, 'pageId')
  if (!teamPageExists(db, teamId, pageId)) {
    sendRefusal(res, 'page_not_found')
    return
  }
  const before = wholeNumber(req.query['before'], 1)
  const limit = wholeNumber(req.query['limit'], 1, PAGE_REVISIONS_LIST_MAX)
  if (before === null || limit === null) {
    sendRefusal(res, 'invalid')
    return
  }
  res.json(
    listPageRevisions(db, pageId, {
      ...(before !== undefined ? { before } : {}),
      ...(limit !== undefined ? { limit } : {}),
    }),
  )
})

export const homePageRevisionGET = handle((req, res) => {
  const db = getDb()
  const teamId = teamOf(req, res, db)
  if (!teamId) return
  const pageId = param(req, 'pageId')
  if (!teamPageExists(db, teamId, pageId)) {
    sendRefusal(res, 'page_not_found')
    return
  }
  const number = wholeNumber(param(req, 'revision'), 1)
  if (number === null || number === undefined) {
    sendRefusal(res, 'invalid')
    return
  }
  const revision = getPageRevision(db, pageId, number)
  if (!revision) {
    sendRefusal(res, 'revision_not_found')
    return
  }
  res.json({ revision })
})

export const homePageRevertPOST = handle((req, res) => {
  if (refuseUnlessPerson(req, res)) return
  const db = getDb()
  const teamId = teamOf(req, res, db)
  if (!teamId) return
  const body = homeRevertBody.safeParse(req.body)
  if (!body.success) return badBody(res, body.error)
  answer(
    res,
    revertTeamPage(db, teamId, param(req, 'pageId'), body.data.revision, {
      actor: personActor(req),
    }),
    (page) => ({ page }),
  )
})

export const homePagePinPOST = handle((req, res) => {
  if (refuseUnlessPerson(req, res)) return
  const db = getDb()
  const teamId = teamOf(req, res, db)
  if (!teamId) return
  const body = homePinBody.safeParse(req.body)
  if (!body.success) return badBody(res, body.error)
  answer(res, setTeamPagePinned(db, teamId, param(req, 'pageId'), body.data.pinned), (page) => ({
    page,
  }))
})

// ─── Settings and the weekly routine ─────────────────────────────────────────

export const homeSettingsGET = handle((req, res) => {
  const db = getDb()
  const teamId = teamOf(req, res, db)
  if (!teamId) return
  res.json({ settings: homeSettingsFor(db, teamId) })
})

// The lead-written status line costs model calls, so turning it on is a person's
// choice on record.
export const homeSettingsPUT = handle((req, res) => {
  if (refuseUnlessPerson(req, res)) return
  const db = getDb()
  const teamId = teamOf(req, res, db)
  if (!teamId) return
  const body = homeSettingsBody.safeParse(req.body)
  if (!body.success) return badBody(res, body.error)
  const previous = getTeamHomeSettings(db, teamId).leadWritesStatus
  // A lead that cannot hold write_home_summary would be asked for nothing.
  if (body.data.leadWritesStatus && !previous && !leadCanWriteStatus(db, teamId)) {
    res.status(409).json({ ok: false, error: 'lead_cannot_write' })
    return
  }
  setTeamHomeSettings(db, teamId, body.data)
  const settings = homeSettingsFor(db, teamId)
  if (previous !== settings.leadWritesStatus)
    appendAudit(db, {
      eventType: 'board',
      teamId,
      summary: {
        action: 'set_home_lead_status',
        on: settings.leadWritesStatus,
        previous,
        ...actorField(req),
      },
    })
  res.json({ settings })
})

export const homeWeeklyUpdatesPOST = handle(async (req, res) => {
  if (refuseUnlessPerson(req, res)) return
  const db = getDb()
  const teamId = teamOf(req, res, db)
  if (!teamId) return
  try {
    const result = await turnOnWeeklyUpdates(db, teamId)
    if (result.created)
      appendAudit(db, {
        eventType: 'board',
        teamId,
        summary: {
          action: 'home_weekly_updates_on',
          routineId: result.routineId,
          ...actorField(req),
        },
      })
    res.json({ ...result, settings: homeSettingsFor(db, teamId) })
  } catch (err) {
    if (err instanceof InvalidRoutineTargetError) {
      res.status(400).json({ ok: false, error: 'invalid_routine_target', message: err.message })
      return
    }
    throw err
  }
})
