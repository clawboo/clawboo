import { create } from 'zustand'

// A small client-side ring buffer of runtime health probes — one sample appended
// per 8s Runtimes-panel poll (and on an explicit Re-check), keyed by runtime id.
// There is no server probe-history store (the BootReport is a single snapshot),
// so the diagnostics drawer reconstructs a "last N checks" timeline from the live
// poll the panel already runs. Bounded to MAX so it never grows unbounded.

export interface ProbeSample {
  ts: number
  ok: boolean
  message?: string
}

const MAX = 20

interface ProbeStore {
  history: Record<string, ProbeSample[]>
  record: (id: string, sample: ProbeSample) => void
}

export const useRuntimeProbeStore = create<ProbeStore>((set) => ({
  history: {},
  record: (id, sample) =>
    set((s) => {
      const prev = s.history[id] ?? []
      return { history: { ...s.history, [id]: [...prev, sample].slice(-MAX) } }
    }),
}))
