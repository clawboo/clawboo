// Canonical motion tokens for Framer Motion (the JS mirror of the CSS
// --motion-* tokens in globals.css). One home for the spring + stagger so the
// same physics is reused everywhere instead of copy-pasted per component.
//
// Framer Motion respects `prefers-reduced-motion` at the framework level, so
// these are safe to apply unconditionally — reduced-motion users get an
// instant fade instead of the spring/stagger.

import type { Transition } from 'framer-motion'

/** Standard state-change / list-mount enter spring (design-system §5). */
export const ENTER_SPRING: Transition = { type: 'spring', stiffness: 260, damping: 20 }

/** Per-item delay for staggered list mounts (seconds). */
export const LIST_STAGGER = 0.04

/**
 * Stagger delay for the item at `index`, capped so long lists don't accumulate
 * a multi-second cascade. Use as `transition={{ ...ENTER_SPRING, delay: listDelay(i) }}`.
 */
export function listDelay(index: number, cap = 0.3): number {
  return Math.min(index * LIST_STAGGER, cap)
}

/** Canonical fade-up enter for list rows / cards. */
export const FADE_UP = {
  initial: { opacity: 0, y: 4 },
  animate: { opacity: 1, y: 0 },
} as const
