import { create } from 'zustand'

export type View = 'graph' | 'chat' | 'scheduler' | 'approvals' | 'cost' | 'marketplace'

interface ViewStore {
  view: View
  setView: (view: View) => void
}

export const useViewStore = create<ViewStore>((set) => ({
  view: 'graph',
  setView: (view) => set({ view }),
}))
