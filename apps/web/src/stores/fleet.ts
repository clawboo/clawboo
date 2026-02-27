import { create } from 'zustand'
import type { AgentStatus } from '@clawboo/gateway-client'
import type { AgentStatusPatch } from '@clawboo/events'

// ─── AgentState ───────────────────────────────────────────────────────────────
// Extends the gateway Agent type with UI-only fields.

export interface AgentState {
  id: string
  name: string
  status: AgentStatus
  sessionKey: string | null
  model: string | null
  createdAt: number | null
  /** Live streaming text (not yet committed to transcript) */
  streamingText: string | null
  /** Current run ID (null when agent is idle) */
  runId: string | null
}

// ─── Store ────────────────────────────────────────────────────────────────────

interface FleetStore {
  agents: AgentState[]
  selectedAgentId: string | null

  /** Replace the full agent list (called on initial load / summary refresh). */
  hydrateAgents: (agents: AgentState[]) => void

  /** Select an agent by id (pass null to deselect). */
  selectAgent: (id: string | null) => void

  /** Patch a single agent's status field. */
  updateAgentStatus: (id: string, status: AgentStatus) => void

  /** Update the live streaming text for an agent. Pass null to clear. */
  updateStreamingText: (id: string, text: string | null) => void

  /** Apply an AgentStatusPatch (from the events pipeline) to a single agent. */
  patchAgent: (id: string, patch: AgentStatusPatch) => void
}

export const useFleetStore = create<FleetStore>((set) => ({
  agents: [],
  selectedAgentId: null,

  hydrateAgents: (agents) => set({ agents }),

  selectAgent: (id) => set({ selectedAgentId: id }),

  updateAgentStatus: (id, status) =>
    set((state) => ({
      agents: state.agents.map((a) => (a.id === id ? { ...a, status } : a)),
    })),

  updateStreamingText: (id, text) =>
    set((state) => ({
      agents: state.agents.map((a) => (a.id === id ? { ...a, streamingText: text } : a)),
    })),

  patchAgent: (id, patch) =>
    set((state) => ({
      agents: state.agents.map((a) => {
        if (a.id !== id) return a
        return {
          ...a,
          ...(patch.status !== undefined ? { status: patch.status } : {}),
          ...(patch.runId !== undefined ? { runId: patch.runId } : {}),
          ...(patch.streamText !== undefined ? { streamingText: patch.streamText } : {}),
        }
      }),
    })),
}))
