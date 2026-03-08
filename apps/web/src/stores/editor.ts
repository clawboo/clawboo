import { create } from 'zustand'

interface EditorStore {
  isOpen: boolean
  agentId: string | null
  agentName: string | null
  /** Incremented when personality sliders save — editor watches this to refresh SOUL.md */
  soulRefreshKey: number
  openEditor: (agentId: string, agentName: string) => void
  closeEditor: () => void
  /** Call after personality slider save to trigger SOUL.md refresh in the editor */
  triggerSoulRefresh: () => void
}

export const useEditorStore = create<EditorStore>((set) => ({
  isOpen: false,
  agentId: null,
  agentName: null,
  soulRefreshKey: 0,
  openEditor: (agentId, agentName) => set({ isOpen: true, agentId, agentName }),
  closeEditor: () => set({ isOpen: false, agentId: null, agentName: null }),
  triggerSoulRefresh: () => set((s) => ({ soulRefreshKey: s.soulRefreshKey + 1 })),
}))
