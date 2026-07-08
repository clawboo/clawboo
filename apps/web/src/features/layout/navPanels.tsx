import { type ReactNode } from 'react'
import { GhostGraphPanel } from '@/features/graph/GhostGraphPanel'
import { SchedulerPanel } from '@/features/scheduler/SchedulerPanel'
import { CostDashboard } from '@/app/cost/CostDashboard'
import { MarketplacePanel } from '@/features/marketplace/MarketplacePanel'
import { MaintenancePanel } from '@/features/maintenance'
import { ObsPanel } from '@/features/obs'
import { BoardPanel } from '@/features/board/BoardPanel'
import { RuntimesPanel } from '@/features/runtimes/RuntimesPanel'
import { FleetHealth } from '@/features/fleet/FleetHealth'
import { MemoryPanel } from '@/features/memory/MemoryPanel'
import { CapabilitiesPanel } from '@/features/capabilities/CapabilitiesPanel'
import { GovernancePanel } from '@/features/governance/GovernancePanel'
import { SystemHealthPanel } from '@/features/health'
import type { NavView } from '@/stores/view'

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
  memory: () => <MemoryPanel />,
  governance: () => <GovernancePanel />,
  capabilities: () => <CapabilitiesPanel />,
  health: () => <SystemHealthPanel />,
}
