import { lazy, Suspense } from 'react'
import { Group, Panel } from 'react-resizable-panels'
import { useFleetStore } from '@/stores/fleet'
import { useConnectionStore } from '@/stores/connection'
import { useSettingsModalStore } from '@/stores/settingsModal'
import { AgentBooAvatar } from '@/components/AgentBooAvatar'
import { ChatPanel } from '@/features/chat/ChatPanel'
import { ResizeHandle } from '@/features/shared/ResizeHandle'
import { GitHubStarButton } from '@/features/promo/GitHubStarButton'
import { useNativeRuntimeState } from '@/features/runtimes/useNativeRuntimeState'
import { Spinner } from '@/features/shared/Spinner'

// This view is on the eager path (ContentArea imports it statically), so both of
// its heavy panes are lazy-loaded — otherwise they'd anchor their libraries to
// the entry chunk regardless of how the vendor chunks are split.
//
// MiniGraph pulls in React Flow (+ ELK via the shared graph modules); InlineEditor
// owns one of the two CodeMirror entry points (AgentFileEditorOverlay is the other).
const MiniGraph = lazy(() => import('./MiniGraph').then((m) => ({ default: m.MiniGraph })))
const InlineEditor = lazy(() => import('./InlineEditor').then((m) => ({ default: m.InlineEditor })))

// Shared fallback for the two lazy panes — centered spinner, sized to the pane.
function PaneFallback() {
  return (
    <div className="flex h-full items-center justify-center">
      <Spinner size={20} />
    </div>
  )
}

// ─── AgentDetailView ─────────────────────────────────────────────────────────
//
// Top header (44 px) spans all three panels — holds agent identity on the
// left + GitHub Star pill on the right. Replaces both the global `AppTopBar`
// and the ChatPanel's internal header in this view, so chrome is shared
// rather than stacked (saves ~44 px of vertical space).
//
// Below the header, the 3-panel resizable layout:
// ┌─────────────────────┬──────────────────────────┐
// │                     │      MiniGraph (55%)      │
// │   ChatPanel (45%)   ├──────────────────────────┤
// │  (no own header)    │    InlineEditor (45%)     │
// └─────────────────────┴──────────────────────────┘

export function AgentDetailView({ agentId }: { agentId: string }) {
  const agent = useFleetStore((s) => s.agents.find((a) => a.id === agentId) ?? null)
  const connectionStatus = useConnectionStore((s) => s.status)
  // A NATIVE agent's badge must reflect the native runtime's credential state —
  // the app-shell connection store is 'connected' in native mode even with zero
  // provider keys, which showed a green "Connected" over an agent that could not
  // possibly respond. Fail-safe: null (unknown/probe failed) keeps the shell badge.
  const nativeState = useNativeRuntimeState(agent?.runtime === 'clawboo-native')
  const nativeKeyless = nativeState === 'needs-auth'

  if (!agent) {
    return (
      <div className="flex flex-1 items-center justify-center font-body text-[13px] text-foreground/40">
        Agent not found
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      {/* Shared top header — spans full width. Agent identity left,
          GitHub Star right. 44 px tall + 12 px horizontal padding so the
          Star pill lands at exactly the same screen coordinates
          (top:6 right:12 within the row) as every other view. */}
      <div className="flex h-11 shrink-0 items-center justify-between border-b border-border bg-surface px-3">
        <div className="flex min-w-0 items-center gap-2.5">
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
          {nativeKeyless ? (
            <span className="ml-0.5 flex items-center gap-2">
              <span className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.14em] text-amber/90">
                <span className="inline-block h-1.5 w-1.5 rounded-full bg-amber/80" />
                Disconnected
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
              className="ml-0.5 flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.14em] text-foreground/45"
              aria-label={`Connection: ${connectionStatus}`}
            >
              <span
                className={[
                  'inline-block h-1.5 w-1.5 rounded-full',
                  connectionStatus === 'connected'
                    ? 'bg-mint shadow-[0_0_6px_rgb(var(--mint-rgb)/0.6)]'
                    : 'bg-amber/70',
                ].join(' ')}
              />
              {connectionStatus === 'connected' ? 'Connected' : connectionStatus}
            </span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <GitHubStarButton />
        </div>
      </div>

      {/* 3-panel resizable layout below */}
      <div className="min-h-0 flex-1">
        <Group orientation="horizontal" id="agent-detail-h">
          {/* Left: Chat (header suppressed — owned by the shared row above) */}
          <Panel defaultSize={45} minSize={25}>
            <ChatPanel agentId={agentId} hideHeader />
          </Panel>

          <ResizeHandle direction="horizontal" />

          {/* Right: MiniGraph + InlineEditor */}
          <Panel defaultSize={55} minSize={25}>
            <Group orientation="vertical" id="agent-detail-v">
              <Panel defaultSize={55} minSize={15}>
                <Suspense fallback={<PaneFallback />}>
                  <MiniGraph agentId={agentId} />
                </Suspense>
              </Panel>

              <ResizeHandle direction="vertical" />

              <Panel defaultSize={45} minSize={15}>
                <Suspense fallback={<PaneFallback />}>
                  <InlineEditor agentId={agentId} agentName={agent.name} />
                </Suspense>
              </Panel>
            </Group>
          </Panel>
        </Group>
      </div>
    </div>
  )
}
