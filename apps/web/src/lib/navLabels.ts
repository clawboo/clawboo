import type { NavView } from '@/stores/view'

// The user-visible name of each nav view — the single source of truth for the
// strings the sidebar (`AgentListColumn`) and the Settings modal render, and for
// failure copy ("Couldn't load Atlas.").
//
// Two of these are traps and must NOT be derived from the view id:
//   • `graph` is "Atlas" — the id is kept as `graph` for minimal churn across the
//     ViewMode discriminant and the keyboard shortcuts; the team-scoped Ghost
//     Graph inside Group Chat is a different surface entirely.
//   • `cost` is "Tokens Used".
//
// Keyed by `NavView` (a total record, not a partial map) so adding a nav view is
// a TYPE ERROR here rather than a silently missing label — the same guarantee
// `lib/topBar.ts` gives, enforced by `__tests__/navLabels.test.ts`.
export const NAV_VIEW_LABELS: Record<NavView, string> = {
  graph: 'Atlas',
  fleet: 'Fleet',
  cost: 'Tokens Used',
  marketplace: 'Marketplace',
  scheduler: 'Scheduler',
  system: 'System',
  obs: 'Observability',
  board: 'Board',
  runtimes: 'Runtimes',
  providers: 'Providers',
  memory: 'Memory',
  governance: 'Governance',
  capabilities: 'Capabilities',
  health: 'System Health',
}
