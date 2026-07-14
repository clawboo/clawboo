import { create } from 'zustand'
import type { NavView } from './view'

// The subset of NavView that lives inside the Settings modal (the management /
// config / insights surfaces). The daily-driver work surfaces (graph, fleet,
// marketplace, board, approvals) stay in the sidebar and are NOT settings
// views — matching how Linear / Claude / Notion keep primary navigation out of
// the settings sheet.
export type SettingsView = Extract<
  NavView,
  | 'runtimes'
  | 'providers'
  | 'memory'
  | 'capabilities'
  | 'scheduler'
  | 'cost'
  | 'obs'
  | 'governance'
  | 'system'
  | 'health'
>

export const DEFAULT_SETTINGS_VIEW: SettingsView = 'runtimes'

// The NavViews that now live inside the Settings modal (rather than the
// sidebar). Callers that used to `navigateTo(view)` route these through
// `openSettings(view)` instead so they don't render an orphaned full-screen
// view with no sidebar entry.
export const SETTINGS_VIEWS: readonly SettingsView[] = [
  'runtimes',
  'providers',
  'memory',
  'capabilities',
  'scheduler',
  'cost',
  'obs',
  'governance',
  'system',
  'health',
]

export function isSettingsView(view: NavView): view is SettingsView {
  return (SETTINGS_VIEWS as readonly string[]).includes(view)
}

/** A one-shot intent handed to the Settings modal's Runtimes panel. `connect-openclaw`
 *  auto-opens the OpenClaw Gateway setup flow — used when a disabled OpenClaw option is
 *  clicked in CreateTeamModal so the user lands directly in the connect flow. */
export type RuntimeConnectIntent = 'connect-openclaw'

interface SettingsModalState {
  open: boolean
  view: SettingsView
  /** One-shot intent for the Runtimes panel (consumed on mount / arrival, then cleared). */
  runtimeIntent: RuntimeConnectIntent | null
  /** Open the modal, optionally jumping to a view and/or handing the Runtimes panel a
   *  one-shot intent (e.g. auto-open the OpenClaw setup flow). */
  openSettings: (view?: SettingsView, opts?: { runtimeIntent?: RuntimeConnectIntent }) => void
  setView: (view: SettingsView) => void
  clearRuntimeIntent: () => void
  close: () => void
}

export const useSettingsModalStore = create<SettingsModalState>((set) => ({
  open: false,
  view: DEFAULT_SETTINGS_VIEW,
  runtimeIntent: null,
  // Every open RESETS the one-shot intent (only set when explicitly passed) so a stale
  // intent from a prior open can never re-fire.
  openSettings: (view, opts) =>
    set((s) => ({ open: true, view: view ?? s.view, runtimeIntent: opts?.runtimeIntent ?? null })),
  setView: (view) => set({ view }),
  clearRuntimeIntent: () => set({ runtimeIntent: null }),
  close: () => set({ open: false, runtimeIntent: null }),
}))
