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

// ─── Edge keys ───────────────────────────────────────────────────────────────

export type EdgeKeyAction = 'remove' | null

/**
 * Whether this keystroke should remove the selected edge.
 *
 * SEPARATE FROM REACT FLOW'S OWN `deleteKeyCode`, which stays `null` and must:
 * its Backspace path runs through `applyNodeChanges` and splices an AGENT out
 * of the local store with no confirmation and no server call, so the agent is
 * untouched and silently reappears on reload. This is the edge-only path, and
 * it can never reach a node.
 *
 * Refuses while the user is typing. A canvas-level key listener that deletes on
 * Backspace would otherwise eat the last character of every search box and
 * rename field on the surface.
 */
export function edgeKeyAction(e: GraphKeyEvent & { typing: boolean }): EdgeKeyAction {
  if (e.typing) return null
  if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return null
  return e.key === 'Backspace' || e.key === 'Delete' ? 'remove' : null
}

/** Is the event coming from somewhere that takes text? */
export function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el || !el.tagName) return false
  const tag = el.tagName.toLowerCase()
  return tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable === true
}

/**
 * Copy the fields these matrices read off a native keyboard event.
 *
 * NOT A SPREAD, and that is the whole point. `key`, `altKey` and the rest are
 * getters on `KeyboardEvent.prototype`, not own enumerable properties, so
 * `{ ...event }` yields an object carrying none of them and every matrix above
 * reads `undefined` and returns null. The failure is silent at runtime and
 * invisible to a unit test built from object literals, which is exactly the
 * combination that ships.
 */
export function readKeyEvent(e: GraphKeyEvent): GraphKeyEvent {
  return {
    key: e.key,
    altKey: e.altKey,
    shiftKey: e.shiftKey,
    ctrlKey: e.ctrlKey,
    metaKey: e.metaKey,
  }
}
