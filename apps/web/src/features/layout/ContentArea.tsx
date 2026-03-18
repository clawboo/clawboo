import { useEffect, type ReactNode } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { GhostGraphPanel } from '@/features/graph/GhostGraphPanel'
import { SchedulerPanel } from '@/features/scheduler/SchedulerPanel'
import { ApprovalsPanel } from '@/features/approvals/ApprovalsPanel'
import { CostDashboard } from '@/app/cost/CostDashboard'
import { MarketplacePanel } from '@/features/marketplace/MarketplacePanel'
import { MaintenancePanel } from '@/features/maintenance'
import { AgentFileEditorOverlay } from '@/features/editor/AgentFileEditorOverlay'
import { AgentDetailView } from '@/features/agent-detail'
import { WelcomeState } from './WelcomeState'
import { useViewStore } from '@/stores/view'
import { useEditorStore } from '@/stores/editor'
import { useBooZeroStore, identifyBooZero } from '@/stores/booZero'
import { useTeamStore } from '@/stores/team'
import { useFleetStore } from '@/stores/fleet'
import type { NavView } from '@/stores/view'

// ─── View transition config ─────────────────────────────────────────────────

const VIEW_TRANSITION = { duration: 0.15, ease: 'easeOut' as const }
const VIEW_STYLE = {
  display: 'flex' as const,
  flex: 1,
  flexDirection: 'column' as const,
  overflow: 'hidden' as const,
}

// Nav view → component mapping
const NAV_PANELS: Record<NavView, () => ReactNode> = {
  graph: () => <GhostGraphPanel />,
  scheduler: () => <SchedulerPanel />,
  approvals: () => <ApprovalsPanel />,
  cost: () => <CostDashboard />,
  marketplace: () => <MarketplacePanel />,
  system: () => <MaintenancePanel />,
}

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

  // ── Global keyboard shortcuts ──────────────────────────────────────────────
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Skip if user is typing in an input/textarea/contenteditable
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return
      if ((e.target as HTMLElement)?.isContentEditable) return
      // Skip if inside a CodeMirror editor
      if ((e.target as HTMLElement)?.closest?.('.cm-editor')) return

      // Escape — deselect agent, go to welcome (only if no overlay is open)
      if (e.key === 'Escape') {
        if (useEditorStore.getState().isOpen) return
        if (viewMode.type === 'agent' || viewMode.type === 'booZero') {
          e.preventDefault()
          useFleetStore.getState().selectAgent(null)
          useViewStore.getState().setViewMode({ type: 'welcome' })
        }
        return
      }

      // Cmd/Ctrl+1-6 — quick nav to views
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey) {
        const num = parseInt(e.key, 10)
        if (num >= 1 && num <= 6) {
          e.preventDefault()
          const views: NavView[] = [
            'graph',
            'marketplace',
            'approvals',
            'scheduler',
            'cost',
            'system',
          ]
          useViewStore.getState().navigateTo(views[num - 1]!)
        }
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [viewMode])

  // ── Compute view key + content ─────────────────────────────────────────────
  let viewKey: string
  let viewContent: ReactNode

  switch (viewMode.type) {
    case 'welcome':
      viewKey = 'welcome'
      viewContent = <WelcomeState />
      break
    case 'agent':
      viewKey = `agent-${viewMode.agentId}`
      viewContent = <AgentDetailView agentId={viewMode.agentId} />
      break
    case 'booZero':
      viewKey = 'booZero'
      viewContent = booZeroAgentId ? <AgentDetailView agentId={booZeroAgentId} /> : <WelcomeState />
      break
    case 'nav':
      viewKey = `nav-${viewMode.view}`
      viewContent = NAV_PANELS[viewMode.view]()
      break
  }

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

      <AnimatePresence mode="wait">
        <motion.div
          key={viewKey}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={VIEW_TRANSITION}
          style={VIEW_STYLE}
        >
          {viewContent}
        </motion.div>
      </AnimatePresence>
    </div>
  )
}
