import { useRef, useEffect, useState } from 'react'
import { ReactFlowProvider } from '@xyflow/react'
import { Ghost, Terminal } from 'lucide-react'
import { GhostGraph } from './GhostGraph'
import { useGraphStore } from './store'
import { useTeamStore } from '@/stores/team'
import { GitHubStarButton } from '@/features/promo/GitHubStarButton'
import { EmptyState } from '@/features/shared/EmptyState'
import { countOf } from './capabilityVocabulary'
import { countGraphSkills, type GhostGraphScope, type GraphRoomScope } from './types'
import { CollapsedSidebarToggle } from '@/features/layout/SidebarToggle'
import { PaneToggle } from '@/features/shared/FloatingCard'

export type { GhostGraphScope }

export function GhostGraphPanel({
  embedded = false,
  scope = 'team',
  room = null,
}: {
  embedded?: boolean
  scope?: GhostGraphScope
  /** Draw only this room's members (team scope). */
  room?: GraphRoomScope | null
} = {}) {
  const { isLoadingFiles, filesError, nodes } = useGraphStore()
  const selectedTeamId = useTeamStore((s) => s.selectedTeamId)
  // The activity dock, toggled from this panel's top bar. An embedded graph has
  // no top bar here; its view gives Activity a card of its own.
  const [activityOpen, setActivityOpen] = useState(false)

  const roomId = room?.id ?? null
  const prevTeamIdRef = useRef(selectedTeamId)
  const prevScopeRef = useRef(scope)
  const prevRoomIdRef = useRef(roomId)
  useEffect(() => {
    if (
      prevTeamIdRef.current === selectedTeamId &&
      prevScopeRef.current === scope &&
      prevRoomIdRef.current === roomId
    )
      return
    prevTeamIdRef.current = selectedTeamId
    prevScopeRef.current = scope
    prevRoomIdRef.current = roomId
    const store = useGraphStore.getState()
    store.resetLayout()
    store.setNodes([])
    store.setEdges([])
    useGraphStore.setState({ agentFiles: new Map() })
  }, [selectedTeamId, scope, roomId])
  const selectedTeam = useTeamStore((s) =>
    s.selectedTeamId ? (s.teams.find((t) => t.id === s.selectedTeamId) ?? null) : null,
  )

  const booCount = nodes.filter((n) => n.type === 'boo').length
  const skillCount = countGraphSkills(nodes)

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-canvas">
      {!embedded && (
        <div className="flex h-11 shrink-0 items-center justify-between border-b border-border px-3">
          <div className="flex items-center gap-2">
            <CollapsedSidebarToggle />
            <span className="font-mono text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
              {scope === 'atlas'
                ? 'Org chart — All Teams'
                : selectedTeam
                  ? `${selectedTeam.name} — Ghost Graph`
                  : 'Ghost Graph'}
            </span>
            {booCount > 0 && (
              <span className="font-data rounded-full bg-foreground/[0.06] px-2 py-0.5 text-[11px] font-semibold text-muted-foreground">
                {booCount} Boo{booCount !== 1 ? 's' : ''}
                {skillCount > 0 && ` · ${countOf(skillCount, 'skill')}`}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <PaneToggle
              icon={Terminal}
              label="activity"
              open={activityOpen}
              onClick={() => setActivityOpen((v) => !v)}
              testId="pane-toggle-graph-activity"
            />
            {/* GitHub Star CTA — integrated into the toolbar so this view
                doesn't need the global AppTopBar (which is hidden for
                nav:'graph'). Saves 44 px by reusing the existing toolbar. */}
            <GitHubStarButton />
          </div>
        </div>
      )}

      <div className="relative flex-1 overflow-hidden">
        {/* Loading state */}
        {isLoadingFiles && nodes.length === 0 && (
          <div className="pointer-events-none absolute inset-0 z-10 flex flex-col items-center justify-center gap-3">
            <div
              className="h-6 w-6 rounded-full border-2 border-primary/30"
              style={{ borderTopColor: 'var(--primary)', animation: 'spin 0.8s linear infinite' }}
            />
            <span className="text-[12px] text-foreground/35">Loading agent configs…</span>
          </div>
        )}

        {/* Error state */}
        {filesError && (
          <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center">
            <div className="rounded-[10px] border border-destructive/20 bg-destructive/[0.08] px-5 py-3 text-[13px] text-destructive">
              {filesError}
            </div>
          </div>
        )}

        {/* Empty state */}
        {nodes.length === 0 && !isLoadingFiles && (
          <div className="pointer-events-none absolute inset-0 z-[5] flex items-center justify-center">
            <EmptyState
              icon={Ghost}
              title="No agents yet"
              helper="Connect to a Gateway to see your fleet."
              paddingTop={0}
            />
          </div>
        )}

        <ReactFlowProvider key={`${scope}:${selectedTeamId ?? 'none'}`}>
          {embedded ? (
            <GhostGraph scope={scope} room={room} showBrowser={false} />
          ) : (
            <GhostGraph
              scope={scope}
              room={room}
              activityOpen={activityOpen}
              onActivityOpenChange={setActivityOpen}
            />
          )}
        </ReactFlowProvider>
      </div>

      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
      `}</style>
    </div>
  )
}
