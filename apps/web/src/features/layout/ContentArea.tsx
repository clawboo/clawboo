import { useEffect, type ReactNode } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { NavPanel } from './navPanels'
import { AgentFileEditorOverlay } from '@/features/editor/AgentFileEditorOverlay'
import { AgentDetailView } from '@/features/agent-detail'
import { GroupChatView } from '@/features/group-chat/GroupChatView'
import { ErrorBoundary } from '@/features/shared/ErrorBoundary'
import { NAV_VIEW_LABELS } from '@/lib/navLabels'
import { WelcomeState } from './WelcomeState'
import { useViewStore } from '@/stores/view'
import { useEditorStore } from '@/stores/editor'
import { useBooZeroStore, identifyBooZero } from '@/stores/booZero'
import { useTeamStore } from '@/stores/team'
import { useFleetStore } from '@/stores/fleet'
import { useSettingsModalStore } from '@/stores/settingsModal'
import type { NavView } from '@/stores/view'

// ─── View transition config ─────────────────────────────────────────────────

const VIEW_TRANSITION = { duration: 0.15, ease: 'easeOut' as const }
const VIEW_STYLE = {
  display: 'flex' as const,
  flex: 1,
  flexDirection: 'column' as const,
  overflow: 'hidden' as const,
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

  // Edge case: team deleted while viewing its group chat → navigate to welcome
  useEffect(() => {
    if (viewMode.type === 'groupChat') {
      if (!teams.some((t) => t.id === viewMode.teamId)) {
        useViewStore.getState().setViewMode({ type: 'welcome' })
      }
    }
  }, [viewMode, teams])

  // ── Global keyboard shortcuts ──────────────────────────────────────────────
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Skip if user is typing in an input/textarea/contenteditable
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return
      if ((e.target as HTMLElement)?.isContentEditable) return
      // Skip if inside a CodeMirror editor
      if ((e.target as HTMLElement)?.closest?.('.cm-editor')) return

      // Escape — close the Settings modal first if it's open, else deselect
      // agent / go to welcome (only if no other overlay is open)
      if (e.key === 'Escape') {
        if (useSettingsModalStore.getState().open) {
          e.preventDefault()
          useSettingsModalStore.getState().close()
          return
        }
        if (useEditorStore.getState().isOpen) return
        if (
          viewMode.type === 'agent' ||
          viewMode.type === 'booZero' ||
          viewMode.type === 'groupChat'
        ) {
          e.preventDefault()
          useFleetStore.getState().selectAgent(null)
          useViewStore.getState().setViewMode({ type: 'welcome' })
        }
        return
      }

      // Cmd/Ctrl+, — open the Settings modal (the universal settings shortcut)
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key === ',') {
        e.preventDefault()
        useSettingsModalStore.getState().openSettings()
        return
      }

      // Cmd/Ctrl+1-4 — quick nav to the sidebar work surfaces (Approvals folded
      // into the Board, so it's no longer a standalone shortcut).
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey) {
        const num = parseInt(e.key, 10)
        if (num >= 1 && num <= 4) {
          e.preventDefault()
          const views: NavView[] = ['graph', 'fleet', 'marketplace', 'board']
          useViewStore.getState().navigateTo(views[num - 1]!)
        }
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [viewMode])

  // ── Compute view key + content ─────────────────────────────────────────────
  // `viewLabel` is computed alongside `viewKey` so the per-view error boundary
  // below names the surface that failed ("Couldn't load the team space.") without
  // needing a second switch.
  let viewKey: string
  let viewLabel: string
  let viewContent: ReactNode

  switch (viewMode.type) {
    case 'welcome':
      viewKey = 'welcome'
      viewLabel = 'the welcome screen'
      viewContent = <WelcomeState />
      break
    case 'agent':
      viewKey = `agent-${viewMode.agentId}`
      viewLabel = 'this agent'
      viewContent = <AgentDetailView agentId={viewMode.agentId} />
      break
    case 'booZero':
      viewKey = 'booZero'
      viewLabel = 'this agent'
      viewContent = booZeroAgentId ? <AgentDetailView agentId={booZeroAgentId} /> : <WelcomeState />
      break
    case 'groupChat':
      viewKey = `group-chat-${viewMode.teamId}`
      viewLabel = 'the team space'
      viewContent = <GroupChatView teamId={viewMode.teamId} />
      break
    case 'nav':
      viewKey = `nav-${viewMode.view}`
      viewLabel = NAV_VIEW_LABELS[viewMode.view]
      // NavPanel owns the per-panel boundary + Suspense + retry-that-re-imports.
      viewContent = <NavPanel view={viewMode.view} />
      break
    default:
      viewKey = 'welcome'
      viewLabel = 'the welcome screen'
      viewContent = <WelcomeState />
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
          {/* One boundary per VIEW, INSIDE the motion.div. Inside, so (a) the
              sidebars and top bar stay mounted and interactive when a view
              crashes, and (b) `key={viewKey}` remounts it on navigation — a
              broken view heals itself the moment the user goes elsewhere and
              back. It must NOT wrap the motion.div: that would make the boundary
              AnimatePresence's direct child, hiding the `key` and killing every
              exit animation. For `nav` this is the outer net; NavPanel's own
              boundary catches first and is the one with the re-import retry. */}
          <ErrorBoundary
            variant="panel"
            label={viewLabel}
            resetKeys={[viewKey]}
            logContext={{ viewKey }}
          >
            {viewContent}
          </ErrorBoundary>
        </motion.div>
      </AnimatePresence>
    </div>
  )
}
