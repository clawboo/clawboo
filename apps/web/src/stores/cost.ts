import { create } from 'zustand'
import type { DbCostRecord } from '@clawboo/db'

export type CostRecord = DbCostRecord

export interface AgentCost {
  agentId: string
  agentName: string
  totalCost: number
  totalTokens: number
  messageCount: number
}

export interface CostSummary {
  totalToday: number
  totalWeek: number
  totalMonth: number
  byAgent: AgentCost[]
}

interface CostStore {
  records: CostRecord[]
  summary: CostSummary | null
  isLoading: boolean

  setRecords: (records: CostRecord[]) => void
  setSummary: (summary: CostSummary) => void
  setLoading: (isLoading: boolean) => void
}

export const useCostStore = create<CostStore>((set) => ({
  records: [],
  summary: null,
  isLoading: false,

  setRecords: (records) => set({ records }),
  setSummary: (summary) => set({ summary }),
  setLoading: (isLoading) => set({ isLoading }),
}))
