import { create } from 'zustand'

interface EditorStore {
  isOpen: boolean
  agentId: string | null
  agentName: string | null
  openEditor: (agentId: string, agentName: string) => void
  closeEditor: () => void
}

export const useEditorStore = create<EditorStore>((set) => ({
  isOpen: false,
  agentId: null,
  agentName: null,
  openEditor: (agentId, agentName) => set({ isOpen: true, agentId, agentName }),
  closeEditor: () => set({ isOpen: false, agentId: null, agentName: null }),
}))
