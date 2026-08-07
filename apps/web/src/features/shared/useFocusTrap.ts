/**
 * apps/web/src/features/shared/useFocusTrap.ts
 *
 * Minimal focus management for a modal dialog (no extra dependency):
 *   - move focus into the dialog on mount and whenever `focusKey` changes
 *     (step entry), but never steal focus from a control that's already inside,
 *   - trap Tab / Shift+Tab within the dialog,
 *   - restore focus to whatever was focused before the trap mounted, on unmount —
 *     re-finding the trigger by `data-focus-restore-id` when it was re-created
 *     while the dialog was open (see the restore effect).
 *
 * The dialog is the element referenced by `ref`. This is the interaction-level
 * a11y that jest-axe cannot catch.
 */

import { useEffect, useRef } from 'react'

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'textarea:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

function focusableWithin(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (el) => !el.hasAttribute('aria-hidden'),
  )
}

// ─── Trap stack ──────────────────────────────────────────────────────────────
//
// Every trap binds its Tab handler to `window` (so it still works when focus is
// on <body> between step swaps). With two traps mounted — CreateTeamModal and
// the TeamTemplateDetail sheet it opens on top — BOTH handlers run for the same
// Tab and fight over where focus lands. `stopPropagation` can't arbitrate:
// they're same-node, same-phase listeners, and the DOM runs every one of those.
// So traps register here in mount order and only the LAST registered acts; the
// rest idle until it unmounts. `Modal`'s Escape handler reads the same stack,
// which is what makes nested dialogs close innermost-first.
//
// Ordering is effect order, i.e. mount order. The one case it gets wrong is two
// traps mounting in the SAME commit (React runs child effects before parent
// effects) — a dialog rendered already-open inside another already-open dialog.
// Every nested pair in this app is user-opened, so the inner one registers later.
const trapStack: symbol[] = []

/** True when `token` owns the keyboard (or isn't participating at all). */
export function isTopmostTrap(token: symbol | null): boolean {
  if (token === null) return true
  return trapStack.length === 0 || trapStack[trapStack.length - 1] === token
}

/**
 * True when ANY dialog is open.
 *
 * The app-shell keyboard handler (`features/layout/ContentArea.tsx`) needs this
 * because it listens on `document` in the BUBBLE phase, which fires BEFORE a
 * `Modal`'s `window`-bubble Escape — so a dialog cannot defer to it, and cannot
 * suppress it with `stopPropagation` either. Without this check, Escape inside a
 * dialog opened over an agent / group-chat view ALSO deselects the agent and
 * jumps the app to Welcome behind the dialog.
 */
export function hasOpenTrap(): boolean {
  return trapStack.length > 0
}

/**
 * @param ref               the dialog element to trap focus within.
 * @param focusKey          re-run the focus move when this changes (a wizard step).
 * @param initialFocusRef   focus this on entry instead of the root's first focusable.
 * @returns a ref holding this trap's stack token, for callers that need to know
 *          whether they still own the keyboard (see `isTopmostTrap`).
 */
export function useFocusTrap(
  ref: React.RefObject<HTMLElement | null>,
  focusKey: unknown,
  initialFocusRef?: React.RefObject<HTMLElement | null>,
): React.RefObject<symbol | null> {
  const tokenRef = useRef<symbol | null>(null)
  if (tokenRef.current === null) tokenRef.current = Symbol('focus-trap')

  // Register for this mount's lifetime. Splice-by-identity, not pop: an outer
  // trap can outlive an inner one, and cleanups don't always run innermost-first.
  useEffect(() => {
    const token = tokenRef.current
    if (!token) return
    trapStack.push(token)
    return () => {
      const i = trapStack.indexOf(token)
      if (i !== -1) trapStack.splice(i, 1)
    }
  }, [])

  // Capture the element that had focus before the dialog opened, restore on close.
  //
  // The trigger is not always the same DOM node by the time the dialog closes. A board
  // card that opened the task drawer is destroyed and re-created the moment its task
  // changes column — a status commit made inside the drawer, or the 5s poll landing
  // under it — because React cannot reuse a node across two different parents. The
  // captured reference is then detached, and `.focus()` on a detached node is a SILENT
  // no-op: focus stays on <body> and the next Tab restarts at the top of the document,
  // which for a keyboard or screen-reader user means losing their place entirely.
  //
  // So capture the trigger's logical identity alongside the node. A trigger that may be
  // re-created tags itself `data-focus-restore-id`; on close we re-find it by that when
  // the original is gone. Triggers without the tag keep the plain node behavior.
  const restoreToRef = useRef<HTMLElement | null>(null)
  const restoreIdRef = useRef<string | null>(null)
  useEffect(() => {
    const active = (document.activeElement as HTMLElement | null) ?? null
    restoreToRef.current = active
    restoreIdRef.current = active?.dataset['focusRestoreId'] ?? null
    return () => {
      const el = restoreToRef.current
      if (el?.isConnected) {
        el.focus?.()
        return
      }
      const id = restoreIdRef.current
      if (!id) return
      // Matched by attribute VALUE rather than a selector: jsdom ships no `CSS.escape`,
      // and these ids are opaque server strings that must never be spliced into a query.
      const replacement = Array.from(
        document.querySelectorAll<HTMLElement>('[data-focus-restore-id]'),
      ).find((n) => n.dataset['focusRestoreId'] === id)
      replacement?.focus?.()
    }
  }, [])

  // Move focus into the dialog on mount + on every step entry, deferred past the
  // step-swap animation. Skip if focus is already inside (a step may self-focus
  // an input) or if a nested trap now owns the keyboard.
  useEffect(() => {
    const root = ref.current
    if (!root) return
    const id = window.requestAnimationFrame(() => {
      if (!isTopmostTrap(tokenRef.current)) return
      const active = document.activeElement as HTMLElement | null
      if (active && root.contains(active)) return
      const explicit = initialFocusRef?.current
      if (explicit) {
        explicit.focus?.()
        return
      }
      const focusables = focusableWithin(root)
      ;(focusables[0] ?? root).focus?.()
    })
    return () => window.cancelAnimationFrame(id)
  }, [ref, focusKey, initialFocusRef])

  // Trap Tab within the dialog. Bound to the window so it works even if focus
  // briefly lands on <body> between step swaps.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent): void {
      if (e.key !== 'Tab') return
      if (!isTopmostTrap(tokenRef.current)) return
      const root = ref.current
      if (!root) return
      const focusables = focusableWithin(root)
      if (focusables.length === 0) {
        // Nothing tabbable inside, so Tab must not escape — but swallowing the
        // key while focus sits on <body> would leave the user focused outside an
        // aria-modal dialog with no way back in. Park focus on the root, which
        // Modal (and the wizard) make focusable with tabIndex={-1} for exactly
        // this fallback.
        e.preventDefault()
        root.focus?.()
        return
      }
      const first = focusables[0]
      const last = focusables[focusables.length - 1]
      const active = document.activeElement as HTMLElement | null
      const inside = active != null && root.contains(active)
      if (!inside) {
        e.preventDefault()
        first.focus()
        return
      }
      if (e.shiftKey && active === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && active === last) {
        e.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [ref])

  return tokenRef
}
