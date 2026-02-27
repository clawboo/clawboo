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
  frugalMode: boolean

  setRecords: (records: CostRecord[]) => void
  setSummary: (summary: CostSummary) => void
  setLoading: (isLoading: boolean) => void
  toggleFrugalMode: () => void
}

export const useCostStore = create<CostStore>((set, get) => ({
  records: [],
  summary: null,
  isLoading: false,
  // Read frugalMode from localStorage on init (safe: guarded for SSR)
  frugalMode:
    typeof window !== 'undefined' ? localStorage.getItem('clawboo:frugal-mode') === 'true' : false,

  setRecords: (records) => set({ records }),
  setSummary: (summary) => set({ summary }),
  setLoading: (isLoading) => set({ isLoading }),

  toggleFrugalMode: () => {
    const next = !get().frugalMode
    if (typeof window !== 'undefined') {
      localStorage.setItem('clawboo:frugal-mode', String(next))
    }
    set({ frugalMode: next })
  },
}))
