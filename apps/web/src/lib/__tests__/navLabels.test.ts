// NAV_VIEW_LABELS — the single source of truth for nav-view copy, shared by the
// sidebar, the Settings modal, and error-boundary failure cards.
//
// Mirrors the exhaustiveness guard in topBar.test.ts: a newly added nav view must
// not be able to slip through unlabelled, which would render a blank sidebar row
// and a card reading "Couldn't load ."

import { describe, expect, it } from 'vitest'

import { NAV_VIEWS } from '@/stores/view'

import { NAV_VIEW_LABELS } from '../navLabels'

describe('NAV_VIEW_LABELS', () => {
  it('covers every nav view with a non-empty label (so a new tab can never be left out)', () => {
    expect(Object.keys(NAV_VIEW_LABELS)).toHaveLength(NAV_VIEWS.length)
    for (const view of NAV_VIEWS) {
      expect(NAV_VIEW_LABELS[view].trim()).not.toBe('')
    }
  })

  it('pins the labels that are NOT a title-cased view id', () => {
    // `graph` is user-visibly "Atlas" — the id stayed `graph` for minimal churn
    // across the ViewMode discriminant and the keyboard shortcuts, while the
    // team-scoped Ghost Graph inside Group Chat kept the old name. Deriving any
    // of these from the id would put the wrong word in the sidebar, in the
    // Settings nav, AND in the failure copy.
    expect(NAV_VIEW_LABELS.graph).toBe('Atlas')
    expect(NAV_VIEW_LABELS.cost).toBe('Tokens Used')
    expect(NAV_VIEW_LABELS.obs).toBe('Observability')
    expect(NAV_VIEW_LABELS.health).toBe('System Health')
  })
})
