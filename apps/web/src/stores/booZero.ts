import { create } from 'zustand'

// ─── Boo Zero ────────────────────────────────────────────────────────────────
// The primary/default OpenClaw agent. Identified on connect via the Gateway's
// `defaultId` field, with fallbacks to first teamless or first overall agent.

interface BooZeroStore {
  booZeroAgentId: string | null
  setBooZeroAgentId: (id: string | null) => void
  /**
   * The OpenClaw Gateway's OWN default agent id (`mainKey`, usually `"main"`) —
   * DISTINCT from `booZeroAgentId`, which is the runtime-neutral `resolveBooZero`
   * (native in a native-first install). Persisted at hydration so the display
   * layer can hide this Gateway system agent when it isn't the identified Boo
   * Zero (see `isHiddenGatewayDefault`). In a pure-OpenClaw install the two are
   * the same id, so `main` stays visible as the crowned leader.
   */
  gatewayMainAgentId: string | null
  setGatewayMainAgentId: (id: string | null) => void
}

export const useBooZeroStore = create<BooZeroStore>((set) => ({
  booZeroAgentId: null,
  setBooZeroAgentId: (id) => set({ booZeroAgentId: id }),
  gatewayMainAgentId: null,
  setGatewayMainAgentId: (id) => set({ gatewayMainAgentId: id }),
}))

// ─── Identification ──────────────────────────────────────────────────────────

/**
 * Identify the Boo Zero agent. Priority:
 * 1. Gateway's `defaultId` (if present in the agent list)
 * 2. First agent with `teamId === null` (unassigned)
 * 3. First agent overall
 */
export function identifyBooZero(
  agents: Array<{ id: string; teamId: string | null }>,
  gatewayDefaultId?: string,
): string | null {
  if (agents.length === 0) return null

  // Priority 1: Gateway's default agent
  if (gatewayDefaultId) {
    const found = agents.find((a) => a.id === gatewayDefaultId)
    if (found) return found.id
  }

  // Priority 2: First teamless agent
  const teamless = agents.find((a) => a.teamId === null)
  if (teamless) return teamless.id

  // Priority 3: First agent overall
  return agents[0]!.id
}
