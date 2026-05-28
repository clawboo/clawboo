import { Providers } from './app/providers'
import { ToastContainer } from '@/features/ui/ToastContainer'
import { GatewayBootstrap } from '@/features/connection/GatewayBootstrap'
import { TeamSidebar } from '@/features/layout/TeamSidebar'
import { AgentListColumn } from '@/features/layout/AgentListColumn'
import { ContentArea } from '@/features/layout/ContentArea'
import { AppTopBar } from '@/features/promo/AppTopBar'
import { useViewStore } from '@/stores/view'

export function App() {
  const viewMode = useViewStore((s) => s.viewMode)
  const isBooZero = viewMode.type === 'booZero'
  const columnCollapsed = useViewStore((s) => s.columnCollapsed)

  // Views with their own integrated top row host the GitHub Star pill
  // inline — no need for the global top bar in those views. Saves 44 px
  // of always-on chrome in the highest-traffic surfaces.
  //
  // Views that integrate inline:
  //   - agent / booZero  → shared identity row (`AgentDetailView`)
  //   - groupChat        → team header (`GroupChatViewHeader`)
  //   - nav: 'graph'     → Atlas toolbar (`GhostGraphPanel`)
  //   - nav: 'marketplace' → Marketplace toolbar (`MarketplacePanel`)
  //   - nav: 'approvals'   → Approvals header (`ApprovalsPanel`)
  //   - nav: 'scheduler'   → Scheduler toolbar (`SchedulerPanel`)
  //   - nav: 'cost'        → Cost dashboard header (`CostDashboard`)
  //   - nav: 'system'      → System title row (`MaintenancePanel`)
  //
  // Only `welcome` still uses the global AppTopBar.
  const navWithIntegratedStar = new Set([
    'graph',
    'marketplace',
    'approvals',
    'scheduler',
    'cost',
    'system',
  ])
  const isNavIntegrated =
    viewMode.type === 'nav' && navWithIntegratedStar.has(viewMode.view as string)
  const showGlobalTopBar =
    viewMode.type !== 'agent' &&
    viewMode.type !== 'booZero' &&
    viewMode.type !== 'groupChat' &&
    !isNavIntegrated

  return (
    <Providers>
      <ToastContainer />
      <GatewayBootstrap />
      <div className="flex h-screen overflow-hidden bg-background text-foreground">
        {/* Col 1 — Team sidebar (60px) */}
        <TeamSidebar />
        {/* Col 2 — Agent list + nav (208px) — hidden in Boo Zero view or when collapsed */}
        {!isBooZero && !columnCollapsed && <AgentListColumn />}
        {/* Col 3+4 — Slim top bar (44px) hosts the GitHub Star pill for
            views without their own integrated chrome. Hidden on agent /
            booZero / groupChat — those views host the Star pill inside
            their own header row to save vertical space. */}
        <main className="flex flex-1 flex-col overflow-hidden">
          {showGlobalTopBar && <AppTopBar />}
          <ContentArea />
        </main>
      </div>
    </Providers>
  )
}
