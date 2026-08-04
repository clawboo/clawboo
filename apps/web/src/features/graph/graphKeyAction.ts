// Which graph action a keystroke on a focused node maps to.
//
// Pure so the shortcut matrix is unit-testable in the node vitest project — the
// handler itself has to live on a DOM wrapper (React Flow 12.10.1 exposes no
// `onNodeKeyDown` prop, and `Node.domAttributes` is typed to omit every React
// event handler), and no graph component is rendered in any test today.

export type GraphKeyAction = 'activate' | 'context-menu' | null

export interface GraphKeyEvent {
  key: string
  altKey: boolean
  shiftKey: boolean
  ctrlKey: boolean
  metaKey: boolean
}

export function graphKeyAction(e: GraphKeyEvent): GraphKeyAction {
  // Standard context-menu keys (WAI-ARIA APG). macOS keyboards have no Menu key
  // and the OS swallows Shift+F10, which is why the Alt+Enter alias exists — and
  // why it is documented in the node description rather than left to discovery.
  if (e.key === 'ContextMenu') return 'context-menu'
  if (e.key === 'F10' && e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) return 'context-menu'
  if (e.key === 'Enter' && e.altKey && !e.ctrlKey && !e.metaKey) return 'context-menu'
  // Mirrors the pointer path. React Flow's own Enter/Space handler only marks the
  // node `selected` — it never invokes the `onNodeClick` prop — so the peacock
  // expand/collapse has been pointer-only since it shipped.
  if ((e.key === 'Enter' || e.key === ' ') && !e.altKey && !e.ctrlKey && !e.metaKey) {
    return 'activate'
  }
  return null
}
