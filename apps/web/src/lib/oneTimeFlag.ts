/**
 * Safe one-time UI flags in browser storage, for "show this hint / tour exactly
 * once" affordances. Kept standalone so non-onboarding UI can use them without
 * importing the wizard module. Stored through `clientStorage`, which scopes each
 * flag to this instance's base path and degrades to a no-op in storage-disabled
 * contexts (Safari private mode, embedded webviews) rather than throwing.
 */

import { scopedLocalStorage } from './clientStorage'

export const CAPABILITY_TOUR_FLAG = 'clawboo.tour.shown'

export function hasSeenFlag(key: string): boolean {
  return scopedLocalStorage.getItem(key) === '1'
}

export function markSeenFlag(key: string): void {
  scopedLocalStorage.setItem(key, '1')
}
