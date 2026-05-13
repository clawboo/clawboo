import { useRef, useEffect } from 'react'
import { ReactFlowProvider } from '@xyflow/react'
import { GhostGraph } from './GhostGraph'
import { useGraphStore } from './store'
import { useTeamStore } from '@/stores/team'
import type { GhostGraphScope } from './types'

// Re-export so existing consumers (e.g. `ContentArea`) can import the scope
// type alongside the component.
export type { GhostGraphScope }

// ─── GhostGraphPanel ──────────────────────────────────────────────────────────
//
// Wrapper that owns the ReactFlowProvider context, toolbar, loading/error states,
// and the empty-state illustration.
//
// Two orthogonal props:
//   • `scope` (`'atlas' | 'team'`, default `'team'`)
//     Controls WHAT the canvas renders:
//       - `'atlas'`: global all-teams view. Ignores `selectedTeamId`,
//         synthesizes Boo Zero at the top with edges fanning out to every
//         team's internal lead. Halos toggle is visible.
//       - `'team'`: single-team view bound to `selectedTeamId`. Halos
//         toggle hidden + halos forced off regardless of sticky
//         `showTeamHalos` value.
//   • `embedded` (`boolean`, default `false`)
//     Controls the CHROME — when `true`, the panel-level toolbar (title +
//     boo/skill count badge + Re-layout) is suppressed because a parent
//     view (e.g. `GroupChatViewHeader`) owns it. Independent of `scope`.
//
// Sidebar team highlight is INTENTIONALLY untouched when entering Atlas —
// the user expects to return to their team's group chat with the same team
// still highlighted in the sidebar after leaving Atlas.

export function GhostGraphPanel({
  embedded = false,
  scope = 'team',
}: {
  embedded?: boolean
  scope?: GhostGraphScope
} = {}) {
  const { isLoadingFiles, filesError, nodes } = useGraphStore()
  const selectedTeamId = useTeamStore((s) => s.selectedTeamId)

  // Reset graph state when team OR scope changes. This effect runs in the
  // PARENT (which does NOT remount on key change), so it reliably detects
  // both team switches AND scope switches even though GhostGraph /
  // ReactFlowProvider are keyed below and remount fresh.
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
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        width: '100%',
        background: '#0A0E1A',
        overflow: 'hidden',
      }}
    >
      {/* Toolbar — only rendered when NOT embedded.
          In group chat the team header above the panel already shows the
          team identity + Boo/skill counts, and the Re-layout button now
          lives in the canvas's floating top-right toolbar (with Team
          halos + Connect). So the embedded toolbar would be pure
          redundancy and is suppressed entirely.
          In Atlas (non-embedded) the toolbar is still the only chrome
          identifying the view, so we keep it — minus the Re-layout
          button, which also migrated to the canvas for consistency. */}
      {!embedded && (
        <div
          style={{
            height: 36,
            flexShrink: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '0 12px',
            borderBottom: '1px solid rgba(255,255,255,0.06)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 12, fontWeight: 600, color: 'rgba(232,232,232,0.5)' }}>
              {scope === 'atlas'
                ? 'Atlas — All Teams'
                : selectedTeam
                  ? `${selectedTeam.name} — Ghost Graph`
                  : 'Ghost Graph'}
            </span>
            {booCount > 0 && (
              <span
                style={{
                  fontSize: 11,
                  fontWeight: 500,
                  color: '#E94560',
                  background: 'rgba(233,69,96,0.12)',
                  borderRadius: 20,
                  padding: '1px 8px',
                }}
              >
                {booCount} Boo{booCount !== 1 ? 's' : ''}
                {skillCount > 0 && ` · ${skillCount} skills`}
              </span>
            )}
          </div>
        </div>
      )}

      {/* Canvas area */}
      <div style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
        {/* Loading state */}
        {isLoadingFiles && nodes.length === 0 && (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 12,
              zIndex: 10,
              pointerEvents: 'none',
            }}
          >
            <div
              style={{
                width: 24,
                height: 24,
                borderRadius: '50%',
                border: '2px solid rgba(233,69,96,0.3)',
                borderTopColor: '#E94560',
                animation: 'spin 0.8s linear infinite',
              }}
            />
            <span style={{ fontSize: 12, color: 'rgba(232,232,232,0.35)' }}>
              Loading agent configs…
            </span>
          </div>
        )}

        {/* Error state */}
        {filesError && (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              zIndex: 10,
              pointerEvents: 'none',
            }}
          >
            <div
              style={{
                background: 'rgba(239,68,68,0.08)',
                border: '1px solid rgba(239,68,68,0.2)',
                borderRadius: 10,
                padding: '12px 20px',
                fontSize: 13,
                color: '#FCA5A5',
              }}
            >
              {filesError}
            </div>
          </div>
        )}

        {/* Empty state */}
        {nodes.length === 0 && !isLoadingFiles && (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 10,
              zIndex: 5,
              pointerEvents: 'none',
            }}
          >
            <span style={{ fontSize: 48, lineHeight: 1 }}>👻</span>
            <p
              style={{ fontSize: 14, fontWeight: 500, color: 'rgba(232,232,232,0.45)', margin: 0 }}
            >
              No agents yet
            </p>
            <p style={{ fontSize: 12, color: 'rgba(232,232,232,0.25)', margin: 0 }}>
              Connect to a Gateway to see your fleet
            </p>
          </div>
        )}

        {/* React Flow canvas — keyed by `${scope}:${selectedTeamId ?? 'none'}`
            so switching teams OR scope gives a fresh React Flow context
            (internal node init tracking, ResizeObservers). Without the key,
            stale internal state can prevent ELK layout from firing after
            async agent creation on a newly created team, and switching
            between Atlas → group chat would inherit Atlas's positions. */}
        <ReactFlowProvider key={`${scope}:${selectedTeamId ?? 'none'}`}>
          <GhostGraph scope={scope} />
        </ReactFlowProvider>
      </div>

      {/* Global keyframes — spin used by loading spinners. The previous
          `marchingAnts` keyframe was used by SkillEdge / ResourceEdge /
          DependencyEdge for the flowing-dashes effect, but all three now
          render as static or arrow-marked paths so the keyframe is no
          longer referenced. */}
      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
      `}</style>
    </div>
  )
}
