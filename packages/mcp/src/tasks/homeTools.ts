// Home on the Tasks server: what an agent may read and write about its team's
// goals, KPIs and pages.
//
// Reads: list_goals, get_goal, list_kpis, list_pages, read_page. Writes, only for
// a session bound to its agent and team: report_kpi (an agent-source KPI, by its
// named reporter when it has one), suggest_kpi (a person accepts or dismisses it),
// write_page (a new revision, which a person can revert), draft_goal_update (a
// draft; never published here), and, for the team's lead, write_home_summary.
// An agent never defines a KPI, changes a target, sets a goal's health or
// publishes an update: there is no tool for any of those.

import {
  agentActorOf,
  agentWritePage,
  draftGoalUpdate,
  getTeamPage,
  goalDetail,
  GOAL_HEALTHS,
  KPI_DIRECTIONS,
  kpiTiles,
  listTeamGoals,
  listTeamKpis,
  listTeamPages,
  buildGoalIndex,
  goalSummaries,
  reportAgentKpiValue,
  suggestTeamKpi,
  teamSnapshot,
  writeHomeSummary,
  type ClawbooDb,
  type HomeActor,
  type HomeRefusal,
} from '@clawboo/db'
import { z } from 'zod'

import { jsonResult, textResult, type McpToolResult, type ToolDef } from '../shared'

export const HOME_READ_TOOL_NAMES = new Set([
  'list_goals',
  'get_goal',
  'list_kpis',
  'list_pages',
  'read_page',
])
export const HOME_WRITE_TOOL_NAMES = new Set([
  'report_kpi',
  'suggest_kpi',
  'write_page',
  'draft_goal_update',
  'write_home_summary',
])

export interface HomeToolContext {
  db: ClawbooDb
  /** The run's team, when bound. Unbound reads may name one. */
  teamId?: string
  /** The calling agent, when a signed or in-process binding names it. */
  agentId?: string
  executionId?: string
  taskId?: string
  /** Is this agent a lead of the team (Boo Zero leads every team)? */
  isLead: (teamId: string | null, agentId: string) => boolean
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const optStr = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined)
const optNum = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined

/** What a refusal means, in words an agent can act on. */
const REFUSAL_WORDS: Partial<Record<HomeRefusal, string>> = {
  goal_not_found: 'There is no such goal on your team. Call list_goals for the ids.',
  kpi_not_found: 'There is no such KPI on your team. Call list_kpis for the ids.',
  page_not_found: 'There is no such page on your team. Call list_pages for the ids.',
  team_not_found: 'Your team was not found.',
  goal_archived: 'That goal is archived and takes no updates.',
  goal_other_team: 'That goal is not on your team.',
  not_active: 'That KPI is not active, so it takes no values.',
  wrong_source:
    'A person or the board fills that KPI, not an agent. Only KPIs whose source is "agent" take report_kpi.',
  not_reporter: 'Another agent is named to report that KPI.',
  too_many: 'The limit for this is reached. Leave it for a person.',
  too_long: 'That is too long. Shorten it and try once more.',
  empty: 'That is empty.',
  invalid: 'One of the values is not valid.',
  archived: 'That page is archived and takes no edits.',
}

function refused(reason: HomeRefusal): McpToolResult {
  return textResult(REFUSAL_WORDS[reason] ?? `refused: ${reason}`, true)
}

export function homeTools(ctx: HomeToolContext): ToolDef[] {
  const { db } = ctx
  const teamFor = (args: Record<string, unknown>): string | undefined =>
    ctx.teamId ?? optStr(args['teamId'])
  const noTeam = (): McpToolResult =>
    textResult('Name a teamId: this session is not bound to a team.', true)
  const teamField: z.ZodRawShape = ctx.teamId ? {} : { teamId: z.string().optional() }
  /** A write needs to know who and which team. */
  const writer = (): { teamId: string; agent: HomeActor } | McpToolResult => {
    if (!ctx.agentId || !ctx.teamId)
      return textResult(
        'This session is not bound to an agent on a team, so it cannot write to Home.',
        true,
      )
    return { teamId: ctx.teamId, agent: agentActorOf(db, ctx.agentId) }
  }
  const isWriter = (w: ReturnType<typeof writer>): w is { teamId: string; agent: HomeActor } =>
    'agent' in w

  const tools: ToolDef[] = [
    {
      name: 'list_goals',
      description:
        "Your team's goals with their progress (done tasks over linked ones), health, target date and whether an update is due. Read-only.",
      inputSchema: z.object({ ...teamField }),
      handler: (args) => {
        const teamId = teamFor(args)
        if (!teamId) return noTeam()
        const goals = listTeamGoals(db, teamId)
        const summaries = goalSummaries(db, goals, buildGoalIndex(db, goals, [teamId]))
        return jsonResult(
          summaries.map((s) => ({
            id: s.goal.id,
            title: s.goal.title,
            parentGoalId: s.goal.parentGoalId,
            status: s.goal.status,
            health: s.goal.health,
            targetDate: s.goal.targetDate,
            progress: s.progress,
            updateMissing: s.updateMissing,
          })),
        )
      },
    },
    {
      name: 'get_goal',
      description:
        'One goal of your team: its description, linked tasks, KPIs, recent updates and pages. Read it before draft_goal_update. Read-only.',
      inputSchema: z.object({ goalId: z.string(), ...teamField }),
      handler: (args) => {
        const teamId = teamFor(args)
        if (!teamId) return noTeam()
        const detail = goalDetail(db, teamId, str(args['goalId']))
        if (!detail) return refused('goal_not_found')
        return jsonResult({
          goal: detail.summary.goal,
          progress: detail.summary.progress,
          cost: detail.summary.cost,
          updateMissing: detail.summary.updateMissing,
          parent: detail.parent,
          children: detail.children.map((c) => ({ id: c.goal.id, title: c.goal.title })),
          tasks: detail.tasks.slice(0, 50).map((t) => ({
            id: t.taskId,
            identifier: t.identifier,
            title: t.title,
            status: t.status,
            checked: t.checked,
          })),
          kpis: detail.kpis.map((k) => ({ id: k.kpi.id, name: k.kpi.name, reading: k.reading })),
          updates: detail.updates
            .filter((u) => u.state === 'published')
            .slice(0, 5)
            .map((u) => ({ body: u.body, health: u.health, publishedAt: u.publishedAt })),
          pages: detail.pages.map((p) => ({ id: p.id, title: p.title })),
        })
      },
    },
    {
      name: 'list_kpis',
      description:
        'Your team\'s active KPIs with their current value, target and where the value comes from. Only KPIs whose source is "agent" take report_kpi. Read-only.',
      inputSchema: z.object({ ...teamField }),
      handler: (args) => {
        const teamId = teamFor(args)
        if (!teamId) return noTeam()
        const tiles = kpiTiles(
          db,
          listTeamKpis(db, teamId, { statuses: ['active'] }),
          teamSnapshot(db, teamId),
        )
        return jsonResult(
          tiles.map((t) => ({
            id: t.kpi.id,
            name: t.kpi.name,
            unit: t.kpi.unit,
            direction: t.kpi.direction,
            target: t.kpi.target,
            period: t.kpi.period,
            source: t.kpi.source,
            goalId: t.kpi.goalId,
            value: t.reading.value,
            asOf: t.reading.asOf,
            freshness: t.reading.freshness,
            youMayReport:
              t.kpi.source === 'agent' &&
              ctx.agentId !== undefined &&
              (t.kpi.reporterAgentId === null || t.kpi.reporterAgentId === ctx.agentId),
          })),
        )
      },
    },
    {
      name: 'list_pages',
      description: "Your team's pages (titles and ids), optionally only one goal's. Read-only.",
      inputSchema: z.object({ goalId: z.string().optional(), ...teamField }),
      handler: (args) => {
        const teamId = teamFor(args)
        if (!teamId) return noTeam()
        const goalId = optStr(args['goalId'])
        return jsonResult(
          listTeamPages(db, teamId, goalId ? { goalId } : {}).map((p) => ({
            id: p.id,
            title: p.title,
            goalId: p.goalId,
            revision: p.revision,
            updatedAt: p.updatedAt,
          })),
        )
      },
    },
    {
      name: 'read_page',
      description: "One of your team's pages, with its newest words. Read-only.",
      inputSchema: z.object({ pageId: z.string(), ...teamField }),
      handler: (args) => {
        const teamId = teamFor(args)
        if (!teamId) return noTeam()
        const page = getTeamPage(db, teamId, str(args['pageId']))
        return page ? jsonResult(page) : refused('page_not_found')
      },
    },
    {
      name: 'report_kpi',
      description:
        'Report a value for one of your team\'s KPIs whose source is "agent". Give the number, and where it came from (sourceUrl) when you can. Your run and task are recorded with it. You cannot change a KPI or its target.',
      inputSchema: z.object({
        kpiId: z.string(),
        value: z.number(),
        sourceUrl: z.string().optional(),
        note: z.string().optional(),
        asOf: z.number().int().optional(),
      }),
      handler: (args) => {
        const w = writer()
        if (!isWriter(w)) return w
        const value = optNum(args['value'])
        if (value === undefined) return refused('invalid')
        const asOf = optNum(args['asOf'])
        const result = reportAgentKpiValue(db, {
          kpiId: str(args['kpiId']),
          teamId: w.teamId,
          agent: w.agent,
          value,
          ...(asOf !== undefined ? { asOf } : {}),
          note: optStr(args['note']) ?? null,
          sourceUrl: optStr(args['sourceUrl']) ?? null,
          executionId: ctx.executionId ?? null,
          taskId: ctx.taskId ?? null,
        })
        return result.ok ? jsonResult({ reported: result.value }) : refused(result.reason)
      },
    },
    {
      name: 'suggest_kpi',
      description:
        'Suggest a KPI for your team: what to measure and why. A person accepts or dismisses it on Home; until then it measures nothing.',
      inputSchema: z.object({
        name: z.string(),
        unit: z.string().optional(),
        direction: z.enum(KPI_DIRECTIONS).optional(),
        target: z.number().optional(),
        goalId: z.string().optional(),
        why: z.string(),
      }),
      handler: (args) => {
        const w = writer()
        if (!isWriter(w)) return w
        const direction = optStr(args['direction'])
        const target = optNum(args['target'])
        const goalId = optStr(args['goalId'])
        const result = suggestTeamKpi(db, {
          teamId: w.teamId,
          name: str(args['name']),
          ...(optStr(args['unit']) !== undefined ? { unit: str(args['unit']) } : {}),
          ...(direction === 'up' || direction === 'down' ? { direction } : {}),
          ...(target !== undefined ? { target } : {}),
          ...(goalId ? { goalId } : {}),
          why: str(args['why']),
          agent: w.agent,
        })
        return result.ok
          ? jsonResult({ suggested: { id: result.value.id, name: result.value.name } })
          : refused(result.reason)
      },
    },
    {
      name: 'write_page',
      description:
        "Write one of your team's pages in markdown: give pageId to replace its words with a new revision, or a title to start a new page. Every revision is kept, and a person can revert yours.",
      inputSchema: z.object({
        pageId: z.string().optional(),
        title: z.string().optional(),
        body: z.string(),
        goalId: z.string().optional(),
      }),
      handler: (args) => {
        const w = writer()
        if (!isWriter(w)) return w
        const goalId = optStr(args['goalId'])
        const result = agentWritePage(db, {
          teamId: w.teamId,
          pageId: optStr(args['pageId']) ?? null,
          title: optStr(args['title']) ?? null,
          body: str(args['body']),
          ...(goalId ? { goalId } : {}),
          agent: w.agent,
          executionId: ctx.executionId ?? null,
        })
        if (!result.ok) {
          if (result.reason === 'empty' && !optStr(args['pageId']))
            return textResult('Give a title for a new page, or a pageId to edit one.', true)
          return refused(result.reason)
        }
        return jsonResult({
          page: { id: result.value.id, title: result.value.title, revision: result.value.revision },
        })
      },
    },
    {
      name: 'draft_goal_update',
      description:
        "Draft a status update on one of your team's goals: what got done, what is in the way, what comes next. A person reviews and publishes it; you cannot publish it or set the goal's health. A health you give is only your suggestion.",
      inputSchema: z.object({
        goalId: z.string(),
        body: z.string(),
        health: z.enum(GOAL_HEALTHS).optional(),
      }),
      handler: (args) => {
        const w = writer()
        if (!isWriter(w)) return w
        const health = optStr(args['health'])
        const result = draftGoalUpdate(db, {
          goalId: str(args['goalId']),
          teamId: w.teamId,
          body: str(args['body']),
          ...(health && (GOAL_HEALTHS as readonly string[]).includes(health)
            ? { health: health as (typeof GOAL_HEALTHS)[number] }
            : {}),
          agent: w.agent,
          executionId: ctx.executionId ?? null,
        })
        return result.ok
          ? jsonResult({ draft: { id: result.value.id, state: result.value.state } })
          : refused(result.reason)
      },
    },
  ]

  // The lead's own tool, for the team's Home status line. Only offered to a lead.
  if (ctx.agentId && ctx.teamId && ctx.isLead(ctx.teamId, ctx.agentId))
    tools.push({
      name: 'write_home_summary',
      description:
        "Write your team's Home status line: one or two short sentences on where the work stands. Only when your team turned it on; at most once every 6 hours and only after the board changed.",
      inputSchema: z.object({ text: z.string() }),
      handler: (args) => {
        const w = writer()
        if (!isWriter(w)) return w
        const result = writeHomeSummary(db, {
          teamId: w.teamId,
          agent: w.agent,
          isLead: ctx.isLead(w.teamId, w.agent.id),
          body: str(args['text']),
          executionId: ctx.executionId ?? null,
        })
        if (result.ok) return jsonResult({ written: true })
        const words: Record<typeof result.reason, string> = {
          not_enabled: 'Your team has not turned on a written status line. Do nothing more.',
          not_lead: 'Only the team lead writes the status line.',
          unchanged: 'Nothing changed on the board since the last line. Do nothing more.',
          too_soon: 'A line was written in the last 6 hours. Do nothing more.',
          too_many: 'Four lines were written today already. Do nothing more.',
          empty: 'The line is empty.',
          too_long: 'Keep it to one or two short sentences.',
        }
        return textResult(words[result.reason], true)
      },
    })

  return tools
}
