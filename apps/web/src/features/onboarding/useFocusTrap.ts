/**
 * apps/web/src/features/onboarding/useFocusTrap.ts
 *
 * Minimal focus management for the onboarding modal (no extra dependency):
 *   - move focus into the dialog on mount and whenever `focusKey` changes
 *     (step entry), but never steal focus from a control that's already inside,
 *   - trap Tab / Shift+Tab within the dialog,
 *   - restore focus to whatever was focused before the trap mounted, on unmount.
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

export function useFocusTrap(ref: React.RefObject<HTMLElement | null>, focusKey: unknown): void {
  // Capture the element that had focus before the dialog opened, restore on close.
  const restoreToRef = useRef<HTMLElement | null>(null)
  useEffect(() => {
    restoreToRef.current = (document.activeElement as HTMLElement | null) ?? null
    return () => {
      restoreToRef.current?.focus?.()
    }
  }, [])

  // Move focus into the dialog on mount + on every step entry, deferred past the
  // step-swap animation. Skip if focus is already inside (a step may self-focus
  // an input).
  useEffect(() => {
    const root = ref.current
    if (!root) return
    const id = window.requestAnimationFrame(() => {
      const active = document.activeElement as HTMLElement | null
      if (active && root.contains(active)) return
      const focusables = focusableWithin(root)
      ;(focusables[0] ?? root).focus?.()
    })
    return () => window.cancelAnimationFrame(id)
  }, [ref, focusKey])

  // Trap Tab within the dialog. Bound to the window so it works even if focus
  // briefly lands on <body> between step swaps.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent): void {
      if (e.key !== 'Tab') return
      const root = ref.current
      if (!root) return
      const focusables = focusableWithin(root)
      if (focusables.length === 0) {
        e.preventDefault()
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
}
