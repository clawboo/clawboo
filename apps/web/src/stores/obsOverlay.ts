// The event-sourced live-overlay store. GhostGraph pushes the
// projected per-agent status/cost here; BooNode reads its own agent's entry by id
// to render a small live status pip — WITHOUT going through setNodes (so the ELK
// layout + physics pipeline is never disturbed). Observability is always on; this
// map is simply empty for any agent with no projected board activity, so an idle
// Ghost Graph renders no pips.

import { create } from 'zustand'

import type { ObsAgentStatus } from '@/features/obs/useObsGraphOverlay'

interface ObsOverlayStore {
  statusByAgent: Map<string, ObsAgentStatus>
  costByAgent: Map<string, number>
  setOverlay: (status: Map<string, ObsAgentStatus>, cost: Map<string, number>) => void
}

export const useObsOverlayStore = create<ObsOverlayStore>((set) => ({
  statusByAgent: new Map(),
  costByAgent: new Map(),
  setOverlay: (statusByAgent, costByAgent) => set({ statusByAgent, costByAgent }),
}))
