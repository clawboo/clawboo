import type { Request, Response } from 'express'
import { createDb, costRecords, agents } from '@clawboo/db'
import { eq, gte, desc } from 'drizzle-orm'
import { getDbPath } from '../lib/db'

function dayStart(daysAgo: number): number {
  const d = new Date()
  d.setDate(d.getDate() - daysAgo)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

interface TimeSeries {
  date: string
  cost: number
  tokens: number
}

interface AgentTokenSummary {
  agentId: string
  agentName: string
  totalCost: number
  totalTokens: number
  inputTokens: number
  outputTokens: number
  messageCount: number
}

interface TokenSummaryResponse {
  totalToday: number
  totalWeek: number
  totalMonth: number
  tokensToday: number
  tokensWeek: number
  tokensMonth: number
  byAgent: AgentTokenSummary[]
  timeSeries: TimeSeries[]
}

// ─── GET /api/cost-records/summary ───────────────────────────────────────────

export async function costRecordsSummaryGET(_req: Request, res: Response): Promise<void> {
  try {
    const db = createDb(getDbPath())
    const monthStart = dayStart(30)
    const todayStart = dayStart(0)
    const weekStart = dayStart(7)

    // Fetch all records from last 30 days with agent names via left join
    const rows = await db
      .select({
        id: costRecords.id,
        agentId: costRecords.agentId,
        model: costRecords.model,
        inputTokens: costRecords.inputTokens,
        outputTokens: costRecords.outputTokens,
        costUsd: costRecords.costUsd,
        runId: costRecords.runId,
        createdAt: costRecords.createdAt,
        agentName: agents.name,
      })
      .from(costRecords)
      .leftJoin(agents, eq(costRecords.agentId, agents.id))
      .where(gte(costRecords.createdAt, monthStart))
      .orderBy(desc(costRecords.createdAt))

    let totalToday = 0
    let totalWeek = 0
    let totalMonth = 0
    let tokensToday = 0
    let tokensWeek = 0
    let tokensMonth = 0

    const agentMap = new Map<string, AgentTokenSummary>()
    const dayMap = new Map<string, { cost: number; tokens: number }>()

    for (const row of rows) {
      const ts = row.createdAt
      const rowTokens = row.inputTokens + row.outputTokens

      totalMonth += row.costUsd
      tokensMonth += rowTokens
      if (ts >= weekStart) {
        totalWeek += row.costUsd
        tokensWeek += rowTokens
      }
      if (ts >= todayStart) {
        totalToday += row.costUsd
        tokensToday += rowTokens
      }

      // Per-agent accumulation
      const existing = agentMap.get(row.agentId)
      if (existing) {
        existing.totalCost += row.costUsd
        existing.totalTokens += rowTokens
        existing.inputTokens += row.inputTokens
        existing.outputTokens += row.outputTokens
        existing.messageCount++
      } else {
        agentMap.set(row.agentId, {
          agentId: row.agentId,
          agentName: row.agentName ?? row.agentId,
          totalCost: row.costUsd,
          totalTokens: rowTokens,
          inputTokens: row.inputTokens,
          outputTokens: row.outputTokens,
          messageCount: 1,
        })
      }

      // Per-day accumulation (for time series)
      const dateKey = new Date(ts).toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
      })
      const dayEntry = dayMap.get(dateKey) ?? { cost: 0, tokens: 0 }
      dayEntry.cost += row.costUsd
      dayEntry.tokens += rowTokens
      dayMap.set(dateKey, dayEntry)
    }

    // Build 30-day time series, filling zeros for empty days
    const timeSeries: TimeSeries[] = []
    for (let i = 29; i >= 0; i--) {
      const d = new Date()
      d.setDate(d.getDate() - i)
      d.setHours(0, 0, 0, 0)
      const label = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
      const entry = dayMap.get(label)
      timeSeries.push({ date: label, cost: entry?.cost ?? 0, tokens: entry?.tokens ?? 0 })
    }

    const byAgent = Array.from(agentMap.values()).sort((a, b) => b.totalTokens - a.totalTokens)

    const response: TokenSummaryResponse = {
      totalToday,
      totalWeek,
      totalMonth,
      tokensToday,
      tokensWeek,
      tokensMonth,
      byAgent,
      timeSeries,
    }

    res.json(response)
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
}
