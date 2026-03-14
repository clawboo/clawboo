import { GhostGraphPanel } from '@/features/graph/GhostGraphPanel'
import { SchedulerPanel } from '@/features/scheduler/SchedulerPanel'
import { ApprovalsPanel } from '@/features/approvals/ApprovalsPanel'
import { CostDashboard } from '@/app/cost/CostDashboard'
import { MarketplacePanel } from '@/features/marketplace/MarketplacePanel'
import { AgentFileEditorOverlay } from '@/features/editor/AgentFileEditorOverlay'
import { AgentDetailView } from '@/features/agent-detail'
import { WelcomeState } from './WelcomeState'
import { useViewStore } from '@/stores/view'
import { useBooZeroStore } from '@/stores/booZero'

export function ContentArea() {
  const viewMode = useViewStore((s) => s.viewMode)
  const booZeroAgentId = useBooZeroStore((s) => s.booZeroAgentId)

  return (
    <div
      style={{
        display: 'flex',
        flex: 1,
        flexDirection: 'column',
        overflow: 'hidden',
        position: 'relative',
      }}
    >
      <AgentFileEditorOverlay />

      {viewMode.type === 'welcome' && <WelcomeState />}
      {viewMode.type === 'agent' && <AgentDetailView agentId={viewMode.agentId} />}
      {viewMode.type === 'booZero' && booZeroAgentId && (
        <AgentDetailView agentId={booZeroAgentId} />
      )}
      {viewMode.type === 'booZero' && !booZeroAgentId && <WelcomeState />}
      {viewMode.type === 'nav' && viewMode.view === 'graph' && <GhostGraphPanel />}
      {viewMode.type === 'nav' && viewMode.view === 'scheduler' && <SchedulerPanel />}
      {viewMode.type === 'nav' && viewMode.view === 'approvals' && <ApprovalsPanel />}
      {viewMode.type === 'nav' && viewMode.view === 'cost' && <CostDashboard />}
      {viewMode.type === 'nav' && viewMode.view === 'marketplace' && <MarketplacePanel />}
    </div>
  )
}
