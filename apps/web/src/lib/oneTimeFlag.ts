/**
 * Safe one-time UI flags in localStorage — for "show this hint / tour exactly
 * once" affordances. Degrades to a no-op in storage-disabled contexts (Safari
 * private mode, embedded webviews) rather than throwing (mirrors the safe
 * wrappers in onboardingProgress.ts, kept standalone so non-onboarding UI can
 * use them without importing the wizard module).
 */

export const FIRST_TASK_FLAG = 'clawboo.firstTask.shown'
export const CAPABILITY_TOUR_FLAG = 'clawboo.tour.shown'

export function hasSeenFlag(key: string): boolean {
  if (typeof window === 'undefined') return false
  try {
    return localStorage.getItem(key) === '1'
  } catch {
    return false
  }
}

export function markSeenFlag(key: string): void {
  if (typeof window === 'undefined') return
  try {
    localStorage.setItem(key, '1')
  } catch {
    /* storage unavailable — degrade to non-persistent */
  }
}
