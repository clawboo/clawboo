import { GhostGraphPanel } from '@/features/graph/GhostGraphPanel'
import { ChatPanel } from '@/features/chat/ChatPanel'
import { SchedulerPanel } from '@/features/scheduler/SchedulerPanel'
import { ApprovalsPanel } from '@/features/approvals/ApprovalsPanel'
import { CostDashboard } from '@/app/cost/CostDashboard'
import { MarketplacePanel } from '@/features/marketplace/MarketplacePanel'
import { AgentFileEditorOverlay } from '@/features/editor/AgentFileEditorOverlay'
import { WelcomeState } from './WelcomeState'
import { useViewStore } from '@/stores/view'

export function ContentArea() {
  const viewMode = useViewStore((s) => s.viewMode)

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
      {viewMode.type === 'agent' && <ChatPanel />}
      {viewMode.type === 'nav' && viewMode.view === 'graph' && <GhostGraphPanel />}
      {viewMode.type === 'nav' && viewMode.view === 'scheduler' && <SchedulerPanel />}
      {viewMode.type === 'nav' && viewMode.view === 'approvals' && <ApprovalsPanel />}
      {viewMode.type === 'nav' && viewMode.view === 'cost' && <CostDashboard />}
      {viewMode.type === 'nav' && viewMode.view === 'marketplace' && <MarketplacePanel />}
    </div>
  )
}
