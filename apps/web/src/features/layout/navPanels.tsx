import type { ComponentType } from 'react'
import { LazyBoundary } from '@/features/shared/LazyBoundary'
import { Spinner } from '@/features/shared/Spinner'
import { createRetryableLazy, type RetryableLazy } from '@/lib/lazyRetry'
import { NAV_VIEW_LABELS } from '@/lib/navLabels'
import type { NavView } from '@/stores/view'

// Each panel is lazy-loaded so it stays off the initial entry chunk and only
// downloads/parses when its nav view is first opened. Panels are named exports,
// so we map each to `default`. The heavy features (Ghost Graph + ELK, CodeMirror,
// recharts) load on demand rather than up front, as does the ~4.4 MB marketplace
// catalog — that one needed a SECOND boundary at `features/teams/CreateTeamModalLazy`,
// because the eagerly-imported create-team modal kept the catalog on the boot path
// even with MarketplacePanel lazy here (issue #83). It now has its own
// `marketplace-catalog` chunk.
//
// Every entry goes through `createRetryableLazy` rather than bare `React.lazy`: a
// lazy() that has REJECTED (a dropped connection mid-chunk-load, a stale tab
// pointing at a hashed chunk a redeploy removed) re-throws that same rejection on
// every later render. The wrapper lets the panel's error boundary mint a fresh
// lazy() so "Try again" actually re-runs import(). See lib/lazyRetry.ts for what
// that can and cannot recover.
//
// The single source of truth mapping each NavView → its panel. Shared by
// ContentArea (full-screen work surfaces) AND the SettingsModal (the management /
// config / insights subset, rendered inside the modal) so a panel is never
// duplicated across the two surfaces. Atlas renders the global scope; the
// team-scoped Ghost Graph still lives inside GroupChatView (rendered with the
// default `scope === 'team'`).
const PANEL_SOURCES: Record<NavView, RetryableLazy<ComponentType>> = {
  // ⚠ The one panel that takes a prop. `scope="atlas"` is bound INSIDE the loader
  // so the whole record stays a single no-prop type. Dropping it would silently
  // fall back to `scope="team"`, which renders a different header and a different
  // canvas — a regression no type check would catch.
  graph: createRetryableLazy(() =>
    import('@/features/graph/GhostGraphPanel').then((m) => ({
      default: function AtlasGraphPanel() {
        return <m.GhostGraphPanel scope="atlas" />
      },
    })),
  ),
  fleet: createRetryableLazy(() =>
    import('@/features/fleet/FleetHealth').then((m) => ({ default: m.FleetHealth })),
  ),
  scheduler: createRetryableLazy(() =>
    import('@/features/scheduler/SchedulerPanel').then((m) => ({ default: m.SchedulerPanel })),
  ),
  cost: createRetryableLazy(() =>
    import('@/app/cost/CostDashboard').then((m) => ({ default: m.CostDashboard })),
  ),
  marketplace: createRetryableLazy(() =>
    import('@/features/marketplace/MarketplacePanel').then((m) => ({
      default: m.MarketplacePanel,
    })),
  ),
  system: createRetryableLazy(() =>
    import('@/features/maintenance').then((m) => ({ default: m.MaintenancePanel })),
  ),
  obs: createRetryableLazy(() => import('@/features/obs').then((m) => ({ default: m.ObsPanel }))),
  board: createRetryableLazy(() =>
    import('@/features/board/BoardPanel').then((m) => ({ default: m.BoardPanel })),
  ),
  runtimes: createRetryableLazy(() =>
    import('@/features/runtimes/RuntimesPanel').then((m) => ({ default: m.RuntimesPanel })),
  ),
  providers: createRetryableLazy(() =>
    import('@/features/providers/ProvidersPanel').then((m) => ({ default: m.ProvidersPanel })),
  ),
  memory: createRetryableLazy(() =>
    import('@/features/memory/MemoryPanel').then((m) => ({ default: m.MemoryPanel })),
  ),
  governance: createRetryableLazy(() =>
    import('@/features/governance/GovernancePanel').then((m) => ({ default: m.GovernancePanel })),
  ),
  capabilities: createRetryableLazy(() =>
    import('@/features/capabilities/CapabilitiesPanel').then((m) => ({
      default: m.CapabilitiesPanel,
    })),
  ),
  health: createRetryableLazy(() =>
    import('@/features/health').then((m) => ({ default: m.SystemHealthPanel })),
  ),
}

// Inline styles rather than utility classes so the flex chain is explicit and
// independent of the utility layer — the fallback this replaces did the same, for
// the same reason.
function PanelSuspenseFallback() {
  return (
    <div
      role="status"
      style={{ display: 'flex', flex: 1, alignItems: 'center', justifyContent: 'center' }}
    >
      <Spinner size={20} />
      <span className="sr-only">Loading…</span>
    </div>
  )
}

/**
 * The nav-panel seam. Renders a NavView's panel behind its own error boundary +
 * Suspense, so one panel blowing up — a render throw on an unexpected API shape,
 * or a chunk that fails to download — leaves the sidebars, the top bar and every
 * other surface intact, with a "Try again" that genuinely re-runs the import.
 *
 * Emits no wrapper DOM in the success path, so the panel root stays a direct
 * child of its container (they are all `h-full`).
 */
export function NavPanel({ view }: { view: NavView }) {
  return (
    <LazyBoundary
      // Scopes the boundary's error + attempt state per view, so a panel that
      // failed can never carry its card over to the next one the user opens.
      key={view}
      source={PANEL_SOURCES[view]}
      label={NAV_VIEW_LABELS[view]}
      suspenseFallback={<PanelSuspenseFallback />}
      render={(Panel) => <Panel />}
      logContext={{ navView: view }}
    />
  )
}

/** Test seam — asserts the per-attempt lazy identity without reaching into the map. */
export function getNavPanelSource(view: NavView): RetryableLazy<ComponentType> {
  return PANEL_SOURCES[view]
}
