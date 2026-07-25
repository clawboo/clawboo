import { lazy, type ReactNode } from 'react'
import type { NavView } from '@/stores/view'

// Each panel is lazy-loaded so it stays off the initial entry chunk and only
// downloads/parses when its nav view is first opened. Panels are named exports,
// so we map each to `default` for React.lazy. The heavy features (Ghost Graph +
// ELK, CodeMirror, recharts) now load on demand rather than up front; extracting
// the marketplace agent catalog itself is separate follow-up work. Rendered
// behind a <Suspense> boundary in ContentArea AND in SettingsModal, which
// renders this same map outside ContentArea's boundary.
const GhostGraphPanel = lazy(() =>
  import('@/features/graph/GhostGraphPanel').then((m) => ({ default: m.GhostGraphPanel })),
)
const SchedulerPanel = lazy(() =>
  import('@/features/scheduler/SchedulerPanel').then((m) => ({ default: m.SchedulerPanel })),
)
const CostDashboard = lazy(() =>
  import('@/app/cost/CostDashboard').then((m) => ({ default: m.CostDashboard })),
)
const MarketplacePanel = lazy(() =>
  import('@/features/marketplace/MarketplacePanel').then((m) => ({ default: m.MarketplacePanel })),
)
const MaintenancePanel = lazy(() =>
  import('@/features/maintenance').then((m) => ({ default: m.MaintenancePanel })),
)
const ObsPanel = lazy(() => import('@/features/obs').then((m) => ({ default: m.ObsPanel })))
const BoardPanel = lazy(() =>
  import('@/features/board/BoardPanel').then((m) => ({ default: m.BoardPanel })),
)
const RuntimesPanel = lazy(() =>
  import('@/features/runtimes/RuntimesPanel').then((m) => ({ default: m.RuntimesPanel })),
)
const ProvidersPanel = lazy(() =>
  import('@/features/providers/ProvidersPanel').then((m) => ({ default: m.ProvidersPanel })),
)
const FleetHealth = lazy(() =>
  import('@/features/fleet/FleetHealth').then((m) => ({ default: m.FleetHealth })),
)
const MemoryPanel = lazy(() =>
  import('@/features/memory/MemoryPanel').then((m) => ({ default: m.MemoryPanel })),
)
const CapabilitiesPanel = lazy(() =>
  import('@/features/capabilities/CapabilitiesPanel').then((m) => ({
    default: m.CapabilitiesPanel,
  })),
)
const GovernancePanel = lazy(() =>
  import('@/features/governance/GovernancePanel').then((m) => ({ default: m.GovernancePanel })),
)
const SystemHealthPanel = lazy(() =>
  import('@/features/health').then((m) => ({ default: m.SystemHealthPanel })),
)

// The single source of truth mapping each NavView → its panel renderer.
// Shared by ContentArea (full-screen work surfaces) AND the SettingsModal
// (the management / config / insights subset, rendered inside the modal)
// so a panel is never duplicated across the two surfaces. Atlas renders the
// global scope; the team-scoped Ghost Graph still lives inside GroupChatView
// (rendered with the default `scope === 'team'`).
export const NAV_PANELS: Record<NavView, () => ReactNode> = {
  graph: () => <GhostGraphPanel scope="atlas" />,
  fleet: () => <FleetHealth />,
  scheduler: () => <SchedulerPanel />,
  cost: () => <CostDashboard />,
  marketplace: () => <MarketplacePanel />,
  system: () => <MaintenancePanel />,
  obs: () => <ObsPanel />,
  board: () => <BoardPanel />,
  runtimes: () => <RuntimesPanel />,
  providers: () => <ProvidersPanel />,
  memory: () => <MemoryPanel />,
  governance: () => <GovernancePanel />,
  capabilities: () => <CapabilitiesPanel />,
  health: () => <SystemHealthPanel />,
}
