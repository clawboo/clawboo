import { Fragment, useMemo, useState, type ReactNode } from 'react'
import { Group, Panel, useDefaultLayout } from 'react-resizable-panels'
import { Folder, Globe, ListChecks, Network, Terminal } from 'lucide-react'
import { useFleetStore } from '@/stores/fleet'
import { useConnectionStore } from '@/stores/connection'
import { useSettingsModalStore } from '@/stores/settingsModal'
import { AgentBooAvatar } from '@/components/AgentBooAvatar'
import { ChatPanel } from '@/features/chat/ChatPanel'
import { ResizeHandle } from '@/features/shared/ResizeHandle'
import { GitHubStarButton } from '@/features/promo/GitHubStarButton'
import { connectionStatusLabel } from '@/features/connection/connectionStatusDisplay'
import { useNativeRuntimeState } from '@/features/runtimes/useNativeRuntimeState'
import { LazyBoundary } from '@/features/shared/LazyBoundary'
import { Spinner } from '@/features/shared/Spinner'
import { createRetryableLazy } from '@/lib/lazyRetry'
import {
  CARD_PANEL_STYLE,
  CardWindowButtons,
  FloatingCard,
  PaneToggle,
} from '@/features/shared/FloatingCard'
import {
  safeLayoutStorage,
  usePaneOpen,
  usePanelLayoutStore,
  type PaneKey,
} from '@/stores/panelLayout'
import { ActivityTerminal } from '@/features/obs/ActivityTerminal'
import { CollapsedSidebarToggle } from '@/features/layout/SidebarToggle'

// This view is on the eager path (ContentArea imports it statically), so both of
// its heavy panes are lazy-loaded — otherwise they'd anchor their libraries to
// the entry chunk regardless of how the vendor chunks are split.
//
// MiniGraph pulls in React Flow (+ ELK via the shared graph modules); InlineEditor
// owns one of the two CodeMirror entry points (AgentFileEditorOverlay is the other).
//
// Both go through `createRetryableLazy` + `LazyBoundary` so a failed chunk (or a
// crash inside React Flow / CodeMirror) degrades to a card in THAT pane. Before
// this, either failure threw past both Suspense boundaries and took down the
// whole agent view — including the chat, which is the part still worth using.
const miniGraphSource = createRetryableLazy(() =>
  import('./MiniGraph').then((m) => ({ default: m.MiniGraph })),
)
const inlineEditorSource = createRetryableLazy(() =>
  import('./InlineEditor').then((m) => ({ default: m.InlineEditor })),
)
// The tasks card pulls in the board's task detail (markdown) and the routine
// dialog; the browser card its screenshot viewer.
const agentTasksSource = createRetryableLazy(() =>
  import('./AgentTasksRoutines').then((m) => ({ default: m.AgentTasksRoutines })),
)
const browserPanelSource = createRetryableLazy(() =>
  import('@/features/workspace/BrowserPanel').then((m) => ({ default: m.BrowserPanel })),
)

// Shared fallback for the two lazy panes — centered spinner, sized to the pane.
function PaneFallback() {
  return (
    <div role="status" className="flex h-full items-center justify-center">
      <Spinner size={20} />
      <span className="sr-only">Loading…</span>
    </div>
  )
}

// ─── AgentDetailView ─────────────────────────────────────────────────────────
//
// The chat sits flat on the left with its own 44 px header (agent identity,
// card toggles, GitHub Star). The graph, its tasks and routines, its browser, the
// live activity feed and the details (workspace, settings, files) are floating
// cards on the right, each closable from its own header or from the toggles:
// ┌──────────────────────────┬─╭──────────────────────╮─┐
// │ identity    [▣][▤] Star  │ │ Graph                │ │
// ├──────────────────────────┤ │                      │ │
// │                          │ ╰──────────────────────╯ │
// │         ChatPanel        │ ╭──────────────────────╮ │
// │                          │ │ Files                │ │
// └──────────────────────────┴─╰──────────────────────╯─┘
// With every card off, the chat (and its header, toggles included) takes the
// whole width. Sizes are remembered per combination of open cards.

type AgentCard = 'graph' | 'tasks' | 'browser' | 'activity' | 'files'

/** Top-to-bottom, the order the cards stack in (and their toggles sit in). */
const CARD_ORDER: readonly AgentCard[] = ['graph', 'tasks', 'browser', 'activity', 'files']

const PANE_OF: Record<AgentCard, PaneKey> = {
  graph: 'agent:graph',
  tasks: 'agent:tasks',
  browser: 'agent:browser',
  activity: 'agent:activity',
  files: 'agent:files',
}

// Pixels (react-resizable-panels v4 reads numbers as px): wide enough that the
// chat header's identity, toggles and Star never clip.
const CHAT_MIN_PX = 360

export function AgentDetailView({ agentId }: { agentId: string }) {
  const agent = useFleetStore((s) => s.agents.find((a) => a.id === agentId) ?? null)
  const connectionStatus = useConnectionStore((s) => s.status)
  // A NATIVE agent's badge must reflect the native runtime's credential state —
  // the app-shell connection store is 'connected' in native mode even with zero
  // provider keys, which showed a green "Connected" over an agent that could not
  // possibly respond. Fail-safe: null (unknown/probe failed) keeps the shell badge.
  const nativeState = useNativeRuntimeState(agent?.runtime === 'clawboo-native')
  // Two ways a native run cannot succeed: the runtime has NO provider at all
  // ('needs-auth'), or THIS agent's configured provider slot has no key while the
  // runtime reads green on another provider (providerReady === false). Both badge
  // the same way; see ChatPanel for why the per-agent one never gates sending.
  const nativeKeyless = nativeState === 'needs-auth'
  const providerUnready = agent?.runtime === 'clawboo-native' && agent.providerReady === false
  const showDisconnected = nativeKeyless || providerUnready

  const isOpen: Record<AgentCard, boolean> = {
    graph: usePaneOpen('agent:graph'),
    tasks: usePaneOpen('agent:tasks'),
    browser: usePaneOpen('agent:browser'),
    activity: usePaneOpen('agent:activity'),
    files: usePaneOpen('agent:files'),
  }
  const openCards = CARD_ORDER.filter((c) => isOpen[c])
  const anyCard = openCards.length > 0
  const [maximized, setMaximized] = useState<AgentCard | null>(null)
  // A maximized card that gets closed must not leave the view stuck maximized.
  const shownMaximized = maximized && isOpen[maximized] ? maximized : null

  const hPanelIds = useMemo(() => (anyCard ? ['chat', 'cards'] : ['chat']), [anyCard])
  const openKey = openCards.join(',')
  const vPanelIds = useMemo(() => (openKey ? openKey.split(',') : []), [openKey])
  const hLayout = useDefaultLayout({
    id: 'agent-detail-cards-h',
    panelIds: hPanelIds,
    storage: safeLayoutStorage,
  })
  const vLayout = useDefaultLayout({
    id: 'agent-detail-cards-v',
    panelIds: vPanelIds,
    storage: safeLayoutStorage,
  })

  if (!agent) {
    return (
      <div className="flex flex-1 items-center justify-center font-body text-[13px] text-foreground/40">
        Agent not found
      </div>
    )
  }

  const closeCard = (card: AgentCard) =>
    usePanelLayoutStore.getState().setPaneOpen(PANE_OF[card], false)
  const toggleMax = (card: AgentCard) => setMaximized((m) => (m === card ? null : card))

  // Keyed by agentId so a pane that failed for ONE agent can't show its stale
  // card for the next one. The `booZero` view is why this is load-bearing: its
  // viewKey does not change when `booZeroAgentId` is re-identified after a
  // delete, so the subtree is re-rendered with a new agentId rather than
  // remounted, and a boundary keyed only on `attempt` would keep the previous
  // agent's fallback on screen.
  const graphCard = (
    <FloatingCard
      title="Graph"
      icon={Network}
      testId="agent-card-graph"
      maximized={shownMaximized === 'graph'}
      onToggleMaximize={() => toggleMax('graph')}
      onClose={() => closeCard('graph')}
    >
      <LazyBoundary
        key={agentId}
        source={miniGraphSource}
        label="the agent graph"
        suspenseFallback={<PaneFallback />}
        render={(MiniGraph) => <MiniGraph agentId={agentId} />}
        logContext={{ pane: 'mini-graph', agentId }}
      />
    </FloatingCard>
  )
  // The section pills are this card's top row (no "Details" title row), so
  // the window buttons ride at the end of that row.
  const filesCard = (
    <FloatingCard title="Details" headerless testId="agent-card-files">
      <LazyBoundary
        key={agentId}
        source={inlineEditorSource}
        label="the file editor"
        suspenseFallback={<PaneFallback />}
        render={(InlineEditor) => (
          <InlineEditor
            agentId={agentId}
            agentName={agent.name}
            trailing={
              <CardWindowButtons
                title="Details"
                maximized={shownMaximized === 'files'}
                onToggleMaximize={() => toggleMax('files')}
                onClose={() => closeCard('files')}
              />
            }
          />
        )}
        logContext={{ pane: 'inline-editor', agentId }}
      />
    </FloatingCard>
  )

  // The tasks assigned to this agent and the routines that send it work.
  const tasksCard = (
    <FloatingCard
      title="Tasks & Routines"
      icon={ListChecks}
      testId="agent-card-tasks"
      maximized={shownMaximized === 'tasks'}
      onToggleMaximize={() => toggleMax('tasks')}
      onClose={() => closeCard('tasks')}
    >
      <LazyBoundary
        key={agentId}
        source={agentTasksSource}
        label="the agent's tasks"
        suspenseFallback={<PaneFallback />}
        render={(AgentTasksRoutines) => <AgentTasksRoutines agentId={agentId} />}
        logContext={{ pane: 'agent-tasks', agentId }}
      />
    </FloatingCard>
  )
  // The newest page this agent captured in its browser.
  const browserCard = (
    <FloatingCard
      title="Browser"
      icon={Globe}
      testId="agent-card-browser"
      maximized={shownMaximized === 'browser'}
      onToggleMaximize={() => toggleMax('browser')}
      onClose={() => closeCard('browser')}
    >
      <LazyBoundary
        key={agentId}
        source={browserPanelSource}
        label="the agent's browser"
        suspenseFallback={<PaneFallback />}
        render={(BrowserPanel) => <BrowserPanel agentId={agentId} />}
        logContext={{ pane: 'agent-browser', agentId }}
      />
    </FloatingCard>
  )
  // What this agent is doing, live: its tool calls, results and errors.
  const activityCard = (
    <FloatingCard
      title="Activity"
      icon={Terminal}
      testId="agent-card-activity"
      maximized={shownMaximized === 'activity'}
      onToggleMaximize={() => toggleMax('activity')}
      onClose={() => closeCard('activity')}
    >
      <ActivityTerminal scope={{ agentId }} fill hideHeader />
    </FloatingCard>
  )
  const cardOf: Record<AgentCard, ReactNode> = {
    graph: graphCard,
    tasks: tasksCard,
    browser: browserCard,
    activity: activityCard,
    files: filesCard,
  }
  const sizeOf: Record<AgentCard, string> = {
    graph: '55',
    tasks: '40',
    browser: '40',
    activity: '40',
    files: '45',
  }
  const toggles: Record<AgentCard, { icon: typeof Network; label: string; testId: string }> = {
    graph: { icon: Network, label: 'graph', testId: 'pane-toggle-graph' },
    tasks: { icon: ListChecks, label: 'tasks and routines', testId: 'pane-toggle-tasks' },
    browser: { icon: Globe, label: 'browser', testId: 'pane-toggle-browser' },
    activity: { icon: Terminal, label: 'activity', testId: 'pane-toggle-activity' },
    files: { icon: Folder, label: 'details', testId: 'pane-toggle-files' },
  }

  if (shownMaximized) {
    return <div className="h-full bg-background p-2">{cardOf[shownMaximized]}</div>
  }

  return (
    <div className="h-full bg-background">
      <Group
        orientation="horizontal"
        id="agent-detail-cards-h"
        defaultLayout={hLayout.defaultLayout}
        onLayoutChanged={hLayout.onLayoutChanged}
      >
        <Panel id="chat" minSize={CHAT_MIN_PX}>
          <div className="flex h-full flex-col">
            {/* Chat header: agent identity left; card toggles + GitHub Star
                right. It belongs to the chat, so with the cards closed it spans
                the full width and the toggles ride along to the right edge. */}
            <div className="flex h-11 shrink-0 items-center justify-between border-b border-border bg-surface px-3">
              <div className="flex min-w-0 items-center gap-2.5">
                <CollapsedSidebarToggle className="-mr-0.5" />
                <AgentBooAvatar agentId={agent.id} size={28} />
                <h2
                  className="truncate text-[15px] font-semibold text-foreground"
                  style={{ letterSpacing: '-0.01em' }}
                >
                  {agent.name}
                </h2>
                {!agent.sessionKey && (
                  <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-amber/80">
                    No session
                  </span>
                )}
                {showDisconnected ? (
                  <span className="ml-0.5 flex items-center gap-2">
                    <span className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.14em] text-amber/90">
                      <span className="inline-block h-1.5 w-1.5 rounded-full bg-amber/80" />
                      {nativeKeyless ? 'Disconnected' : 'No provider key'}
                    </span>
                    <button
                      type="button"
                      data-testid="native-disconnected-chip"
                      onClick={() => useSettingsModalStore.getState().openSettings('runtimes')}
                      className="cursor-pointer rounded-full border border-amber/25 bg-amber/10 px-2 py-0.5 text-[10px] font-medium text-amber transition-colors hover:bg-amber/20"
                    >
                      Set up in Runtimes →
                    </button>
                  </span>
                ) : (
                  <span
                    className="ml-0.5 flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground"
                    aria-label={`Connection: ${connectionStatus}`}
                  >
                    <span
                      className={[
                        'inline-block h-1.5 w-1.5 rounded-full',
                        connectionStatus === 'connected'
                          ? 'bg-mint shadow-[0_0_6px_rgb(var(--mint-rgb)/0.6)]'
                          : // A retrying socket pulses — it distinguishes "coming back"
                            // from a flat "not connected".
                            connectionStatus === 'reconnecting'
                            ? 'bg-amber/70 animate-pulse'
                            : 'bg-amber/70',
                      ].join(' ')}
                    />
                    {connectionStatusLabel(connectionStatus)}
                  </span>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-1">
                {CARD_ORDER.map((card) => (
                  <PaneToggle
                    key={card}
                    icon={toggles[card].icon}
                    label={toggles[card].label}
                    open={isOpen[card]}
                    onClick={() => usePanelLayoutStore.getState().togglePane(PANE_OF[card])}
                    testId={toggles[card].testId}
                  />
                ))}
                <span aria-hidden className="mx-1.5 h-4 w-px bg-border" />
                <GitHubStarButton />
              </div>
            </div>
            <div className="min-h-0 flex-1">
              <ChatPanel agentId={agentId} hideHeader />
            </div>
          </div>
        </Panel>

        {anyCard && (
          <>
            <ResizeHandle direction="horizontal" variant="gap" />
            <Panel id="cards" defaultSize="55" minSize="22" style={CARD_PANEL_STYLE}>
              <div className="h-full py-2 pr-2">
                <Group
                  orientation="vertical"
                  id="agent-detail-cards-v"
                  style={CARD_PANEL_STYLE}
                  defaultLayout={vLayout.defaultLayout}
                  onLayoutChanged={vLayout.onLayoutChanged}
                >
                  {openCards.map((card, i) => (
                    <Fragment key={card}>
                      {i > 0 && <ResizeHandle direction="vertical" variant="gap" />}
                      <Panel
                        id={card}
                        defaultSize={sizeOf[card]}
                        minSize="15"
                        style={CARD_PANEL_STYLE}
                      >
                        {cardOf[card]}
                      </Panel>
                    </Fragment>
                  ))}
                </Group>
              </div>
            </Panel>
          </>
        )}
      </Group>
    </div>
  )
}
