import { useRef, useEffect } from 'react'
import { ReactFlowProvider } from '@xyflow/react'
import { GhostGraph } from './GhostGraph'
import { useGraphStore } from './store'
import { useTeamStore } from '@/stores/team'
import type { GhostGraphScope } from './types'

export type { GhostGraphScope }

export function GhostGraphPanel({
  embedded = false,
  scope = 'team',
}: {
  embedded?: boolean
  scope?: GhostGraphScope
} = {}) {
  const { isLoadingFiles, filesError, nodes } = useGraphStore()
  const selectedTeamId = useTeamStore((s) => s.selectedTeamId)

  const prevTeamIdRef = useRef(selectedTeamId)
  const prevScopeRef = useRef(scope)
  useEffect(() => {
    if (prevTeamIdRef.current === selectedTeamId && prevScopeRef.current === scope) return
    prevTeamIdRef.current = selectedTeamId
    prevScopeRef.current = scope
    const store = useGraphStore.getState()
    store.resetLayout()
    store.setNodes([])
    store.setEdges([])
    useGraphStore.setState({ agentFiles: new Map() })
  }, [selectedTeamId, scope])
  const selectedTeam = useTeamStore((s) =>
    s.selectedTeamId ? (s.teams.find((t) => t.id === s.selectedTeamId) ?? null) : null,
  )

  const booCount = nodes.filter((n) => n.type === 'boo').length
  const skillCount = nodes.filter((n) => n.type === 'skill').length

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-canvas">
      {!embedded && (
        <div className="flex h-9 shrink-0 items-center justify-between border-b border-border px-3">
          <div className="flex items-center gap-2">
            <span className="text-[12px] font-semibold text-foreground/50">
              {scope === 'atlas'
                ? 'Atlas — All Teams'
                : selectedTeam
                  ? `${selectedTeam.name} — Ghost Graph`
                  : 'Ghost Graph'}
            </span>
            {booCount > 0 && (
              <span className="rounded-full bg-primary/12 px-2 py-0.5 text-[11px] font-medium text-primary">
                {booCount} Boo{booCount !== 1 ? 's' : ''}
                {skillCount > 0 && ` · ${skillCount} skills`}
              </span>
            )}
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
          <div className="pointer-events-none absolute inset-0 z-[5] flex flex-col items-center justify-center gap-2.5">
            <span className="text-[48px] leading-none">👻</span>
            <p className="m-0 text-[14px] font-medium text-foreground/45">No agents yet</p>
            <p className="m-0 text-[12px] text-foreground/25">
              Connect to a Gateway to see your fleet
            </p>
          </div>
        )}

        <ReactFlowProvider key={`${scope}:${selectedTeamId ?? 'none'}`}>
          <GhostGraph scope={scope} />
        </ReactFlowProvider>
      </div>

      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
      `}</style>
    </div>
  )
}
