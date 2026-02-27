import { create } from 'zustand'
import type { DbApprovalHistory } from '@clawboo/db'

export type ApprovalDecision = 'allow-once' | 'allow-always' | 'deny'

export interface ApprovalRequest {
  id: string
  agentId: string | null
  sessionKey: string | null
  command: string
  cwd: string | null
  host: string | null
  security: string | null
  ask: string | null
  resolvedPath: string | null
  createdAtMs: number
  expiresAtMs: number
  resolving: boolean
  error: string | null
}

interface ApprovalsStore {
  pendingApprovals: Map<string, ApprovalRequest>
  approvalHistory: DbApprovalHistory[]
  addPending: (request: ApprovalRequest) => void
  removePending: (id: string) => void
  setResolving: (id: string, resolving: boolean, error: string | null) => void
  prependHistory: (record: DbApprovalHistory) => void
  hydrateHistory: (records: DbApprovalHistory[]) => void
}

export const useApprovalsStore = create<ApprovalsStore>((set) => ({
  pendingApprovals: new Map(),
  approvalHistory: [],

  addPending: (request) =>
    set((state) => {
      const next = new Map(state.pendingApprovals)
      next.set(request.id, request)
      return { pendingApprovals: next }
    }),

  removePending: (id) =>
    set((state) => {
      if (!state.pendingApprovals.has(id)) return state
      const next = new Map(state.pendingApprovals)
      next.delete(id)
      return { pendingApprovals: next }
    }),

  setResolving: (id, resolving, error) =>
    set((state) => {
      const existing = state.pendingApprovals.get(id)
      if (!existing) return state
      const next = new Map(state.pendingApprovals)
      next.set(id, { ...existing, resolving, error })
      return { pendingApprovals: next }
    }),

  prependHistory: (record) =>
    set((state) => ({
      approvalHistory: [record, ...state.approvalHistory].slice(0, 200),
    })),

  hydrateHistory: (records) => set({ approvalHistory: records }),
}))
