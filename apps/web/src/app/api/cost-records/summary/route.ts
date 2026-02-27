import { NextResponse } from 'next/server'
import path from 'node:path'
import os from 'node:os'
import { createDb, costRecords, agents } from '@clawboo/db'
import { eq, gte, desc } from 'drizzle-orm'

function getDbPath(): string {
  return path.join(os.homedir(), '.openclaw', 'clawboo', 'clawboo.db')
}

function dayStart(daysAgo: number): number {
  const d = new Date()
  d.setDate(d.getDate() - daysAgo)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

export interface TimeSeries {
  date: string
  cost: number
}

export interface AgentCostSummary {
  agentId: string
  agentName: string
  totalCost: number
  totalTokens: number
  messageCount: number
}

export interface CostSummaryResponse {
  totalToday: number
  totalWeek: number
  totalMonth: number
  byAgent: AgentCostSummary[]
  timeSeries: TimeSeries[]
}

// ─── GET /api/cost-records/summary ───────────────────────────────────────────

export async function GET(): Promise<NextResponse> {
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

    const agentMap = new Map<string, AgentCostSummary>()
    const dayMap = new Map<string, number>()

    for (const row of rows) {
      const ts = row.createdAt
      totalMonth += row.costUsd
      if (ts >= weekStart) totalWeek += row.costUsd
      if (ts >= todayStart) totalToday += row.costUsd

      // Per-agent accumulation
      const existing = agentMap.get(row.agentId)
      if (existing) {
        existing.totalCost += row.costUsd
        existing.totalTokens += row.inputTokens + row.outputTokens
        existing.messageCount++
      } else {
        agentMap.set(row.agentId, {
          agentId: row.agentId,
          agentName: row.agentName ?? row.agentId,
          totalCost: row.costUsd,
          totalTokens: row.inputTokens + row.outputTokens,
          messageCount: 1,
        })
      }

      // Per-day accumulation (for time series)
      const dateKey = new Date(ts).toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
      })
      dayMap.set(dateKey, (dayMap.get(dateKey) ?? 0) + row.costUsd)
    }

    // Build 30-day time series, filling zeros for empty days
    const timeSeries: TimeSeries[] = []
    for (let i = 29; i >= 0; i--) {
      const d = new Date()
      d.setDate(d.getDate() - i)
      d.setHours(0, 0, 0, 0)
      const label = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
      timeSeries.push({ date: label, cost: dayMap.get(label) ?? 0 })
    }

    const byAgent = Array.from(agentMap.values()).sort((a, b) => b.totalCost - a.totalCost)

    const response: CostSummaryResponse = {
      totalToday,
      totalWeek,
      totalMonth,
      byAgent,
      timeSeries,
    }

    return NextResponse.json(response)
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
