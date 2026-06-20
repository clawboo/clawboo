import { create } from 'zustand'

// A one-shot hand-off so the runtime diagnostics drawer can deep-link into the
// Capabilities panel pre-filtered to a runtime. The drawer sets `pendingRuntime`
// then navigates; CapabilitiesPanel reads + clears it on mount (so a later manual
// visit is unfiltered). The capability client already accepts a `runtime`
// filter — this only carries the intent across the navigation.
interface CapabilityFilterStore {
  pendingRuntime: string | null
  setPendingRuntime: (runtime: string | null) => void
  /** Read + clear in one call (the panel consumes it on mount). */
  consumePendingRuntime: () => string | null
}

export const useCapabilityFilterStore = create<CapabilityFilterStore>((set, get) => ({
  pendingRuntime: null,
  setPendingRuntime: (runtime) => set({ pendingRuntime: runtime }),
  consumePendingRuntime: () => {
    const r = get().pendingRuntime
    if (r !== null) set({ pendingRuntime: null })
    return r
  },
}))
