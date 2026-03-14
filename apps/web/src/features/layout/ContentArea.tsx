import { useEffect } from 'react'
import { GhostGraphPanel } from '@/features/graph/GhostGraphPanel'
import { SchedulerPanel } from '@/features/scheduler/SchedulerPanel'
import { ApprovalsPanel } from '@/features/approvals/ApprovalsPanel'
import { CostDashboard } from '@/app/cost/CostDashboard'
import { MarketplacePanel } from '@/features/marketplace/MarketplacePanel'
import { AgentFileEditorOverlay } from '@/features/editor/AgentFileEditorOverlay'
import { AgentDetailView } from '@/features/agent-detail'
import { WelcomeState } from './WelcomeState'
import { useViewStore } from '@/stores/view'
import { useBooZeroStore, identifyBooZero } from '@/stores/booZero'
import { useTeamStore } from '@/stores/team'
import { useFleetStore } from '@/stores/fleet'

export function ContentArea() {
  const viewMode = useViewStore((s) => s.viewMode)
  const booZeroAgentId = useBooZeroStore((s) => s.booZeroAgentId)
  const teams = useTeamStore((s) => s.teams)
  const selectedTeamId = useTeamStore((s) => s.selectedTeamId)
  const agents = useFleetStore((s) => s.agents)

  // Edge case 7a: selected team was deleted → navigate to welcome
  useEffect(() => {
    if (selectedTeamId !== null && !teams.some((t) => t.id === selectedTeamId)) {
      useTeamStore.getState().selectTeam(null)
      useViewStore.getState().setViewMode({ type: 'welcome' })
    }
  }, [selectedTeamId, teams])

  // Edge case 7c: agent deleted while viewing its detail → navigate to welcome
  useEffect(() => {
    if (viewMode.type === 'agent') {
      const exists = agents.some((a) => a.id === viewMode.agentId)
      if (!exists) {
        useViewStore.getState().setViewMode({ type: 'welcome' })
      }
    }
  }, [viewMode, agents])

  // Edge case 7d: Boo Zero agent deleted while in booZero view → re-identify or welcome
  useEffect(() => {
    if (viewMode.type === 'booZero' && booZeroAgentId) {
      const exists = agents.some((a) => a.id === booZeroAgentId)
      if (!exists) {
        const newBooZero = identifyBooZero(agents)
        useBooZeroStore.getState().setBooZeroAgentId(newBooZero)
        if (!newBooZero) {
          useViewStore.getState().setViewMode({ type: 'welcome' })
        }
      }
    }
  }, [viewMode, booZeroAgentId, agents])

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
