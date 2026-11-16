// Whether the app showing the dashboard asked for the slim top bar. An app that
// shows the dashboard in its own window, with the system title bar hidden, sets
// `data-clawboo-embed-titlebar` on <html>, along with `--clawboo-titlebar-inset`
// (the bar's height) and `--clawboo-titlebar-left` (the width its window
// buttons take). Without the attribute nothing about the top of the page
// changes, so a browser tab keeps exactly the layout it always had.

import { useSyncExternalStore } from 'react'

export const EMBED_TITLEBAR_ATTRIBUTE = 'data-clawboo-embed-titlebar'

export function embedTitlebarOn(): boolean {
  if (typeof document === 'undefined') return false
  return document.documentElement.hasAttribute(EMBED_TITLEBAR_ATTRIBUTE)
}

function subscribe(onChange: () => void): () => void {
  if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') {
    return () => {}
  }
  // The app may set the attribute once the page has loaded, or take it away.
  const observer = new MutationObserver(onChange)
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: [EMBED_TITLEBAR_ATTRIBUTE],
  })
  return () => observer.disconnect()
}

/** True while <html> carries `data-clawboo-embed-titlebar`. */
export function useEmbedTitlebar(): boolean {
  return useSyncExternalStore(subscribe, embedTitlebarOn, () => false)
}
