import { create } from 'zustand'
import { scopedLocalStorage } from '@/lib/clientStorage'

// Which side cards are open beside a chat. Keyed per view: `agent:graph`,
// `agent:tasks`, `agent:browser`, `agent:activity`, `agent:files`, `team:graph`,
// `team:tasks`, `team:browser`, `team:activity`. A fresh install shows the graph, the agent's
// details and the team's tasks; the rest are opened on demand.

export type PaneKey =
  | 'agent:graph'
  | 'agent:tasks'
  | 'agent:browser'
  | 'agent:activity'
  | 'agent:files'
  | 'team:graph'
  | 'team:tasks'
  | 'team:browser'
  | 'team:activity'

/** The panes that start open, until the person toggles them. */
const OPEN_BY_DEFAULT: ReadonlySet<PaneKey> = new Set([
  'agent:graph',
  'agent:files',
  'team:graph',
  'team:tasks',
])

function openByDefault(key: PaneKey): boolean {
  return OPEN_BY_DEFAULT.has(key)
}

const STORAGE_KEY = 'clawboo.panes'

function readStored(): Partial<Record<PaneKey, boolean>> {
  try {
    const raw = scopedLocalStorage.getItem(STORAGE_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : null
    return parsed && typeof parsed === 'object' ? (parsed as Partial<Record<PaneKey, boolean>>) : {}
  } catch {
    return {}
  }
}

function writeStored(panes: Partial<Record<PaneKey, boolean>>): void {
  try {
    scopedLocalStorage.setItem(STORAGE_KEY, JSON.stringify(panes))
  } catch {
    // Private mode / blocked storage: the toggles still work, just not across reloads.
  }
}

interface PanelLayoutStore {
  panes: Partial<Record<PaneKey, boolean>>
  setPaneOpen: (key: PaneKey, open: boolean) => void
  togglePane: (key: PaneKey) => void
}

export const usePanelLayoutStore = create<PanelLayoutStore>((set, get) => ({
  panes: readStored(),
  setPaneOpen: (key, open) => {
    const panes = { ...get().panes, [key]: open }
    writeStored(panes)
    set({ panes })
  },
  togglePane: (key) => get().setPaneOpen(key, !(get().panes[key] ?? openByDefault(key))),
}))

/** Whether a side card is open (see OPEN_BY_DEFAULT for a fresh install). */
export function usePaneOpen(key: PaneKey): boolean {
  return usePanelLayoutStore((s) => s.panes[key] ?? openByDefault(key))
}

/** A react-resizable-panels `LayoutStorage`. The library's default reads the
 *  origin-wide `localStorage` bare, which throws when storage is blocked and
 *  shares every size with the other instances on the origin; this one does
 *  neither, and sizes it cannot store just aren't remembered. */
export const safeLayoutStorage = scopedLocalStorage
