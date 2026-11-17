// The REST bodies Home's writes take (apps/web/server/api/home.ts). Kept here, as
// the board's are in board/schemas.ts, so the server uses one zod.

import { z } from 'zod'

import {
  GOAL_HEALTHS,
  GOAL_STATUSES,
  HOME_COMPUTED_METRICS,
  KPI_DIRECTIONS,
  KPI_PERIODS,
  KPI_SOURCES,
} from './types'

const actorSchema = z.object({
  kind: z.enum(['person', 'agent']),
  id: z.string().min(1).max(200),
  name: z.string().max(200).nullable(),
})
const epoch = z.number().int().nonnegative()

const goalFields = {
  description: z.string().max(20_000).optional(),
  parentGoalId: z.string().min(1).nullable().optional(),
  owner: actorSchema.nullable().optional(),
  targetDate: epoch.nullable().optional(),
  updateCadenceDays: z.number().int().min(1).max(365).optional(),
}
export const homeCreateGoalBody = z.object({ title: z.string(), ...goalFields })
export const homeUpdateGoalBody = z.object({
  title: z.string().optional(),
  status: z.enum(GOAL_STATUSES).optional(),
  ...goalFields,
})
export const homeHealthBody = z.object({ health: z.enum(GOAL_HEALTHS).nullable() })
export const homeReorderBody = z.object({ goalIds: z.array(z.string().min(1)).max(500) })

export const homeCreateUpdateBody = z.object({
  body: z.string(),
  health: z.enum(GOAL_HEALTHS).nullable().optional(),
})
export const homePublishBody = z.object({
  body: z.string().optional(),
  health: z.enum(GOAL_HEALTHS).nullable().optional(),
})

const kpiFields = {
  unit: z.string().max(40).optional(),
  direction: z.enum(KPI_DIRECTIONS).optional(),
  target: z.number().finite().nullable().optional(),
  period: z.enum(KPI_PERIODS).optional(),
  metric: z.enum(HOME_COMPUTED_METRICS).nullable().optional(),
  goalId: z.string().min(1).nullable().optional(),
  reporterAgentId: z.string().min(1).nullable().optional(),
  staleAfterHours: z.number().positive().finite().nullable().optional(),
}
export const homeCreateKpiBody = z.object({
  name: z.string(),
  source: z.enum(KPI_SOURCES),
  ...kpiFields,
})
export const homeUpdateKpiBody = z.object({
  name: z.string().optional(),
  source: z.enum(KPI_SOURCES).optional(),
  ...kpiFields,
})
export const homeValueBody = z.object({
  value: z.number().finite(),
  asOf: epoch.optional(),
  note: z.string().max(2_000).nullable().optional(),
  sourceUrl: z.string().max(2_000).nullable().optional(),
})

export const homeCreatePageBody = z.object({
  title: z.string(),
  body: z.string().max(200_000).optional(),
  goalId: z.string().min(1).nullable().optional(),
  pinned: z.boolean().optional(),
})
export const homeUpdatePageBody = z.object({
  title: z.string().optional(),
  body: z.string().max(200_000).optional(),
  goalId: z.string().min(1).nullable().optional(),
})
export const homeRevertBody = z.object({ revision: z.number().int().positive() })
export const homePinBody = z.object({ pinned: z.boolean() })
export const homeSettingsBody = z.object({ leadWritesStatus: z.boolean() })
