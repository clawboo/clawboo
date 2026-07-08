import { createContext, useContext } from 'react'

// True when a component tree is rendered INSIDE the Settings modal's right
// pane. Panels reuse their normal chrome there, but `GitHubStarButton` reads
// this to hide itself — one Star pill (in the view's top bar) is enough;
// repeating it in every settings pane reads as clutter.
export const InSettingsModalContext = createContext(false)

export function useInSettingsModal(): boolean {
  return useContext(InSettingsModalContext)
}
