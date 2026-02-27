'use client'

import { ReactFlowProvider } from '@xyflow/react'
import { GhostGraph } from './GhostGraph'
import { useGraphStore } from './store'

// ─── GhostGraphPanel ──────────────────────────────────────────────────────────
//
// Wrapper that owns the ReactFlowProvider context, toolbar, loading/error states,
// and the empty-state illustration.

export function GhostGraphPanel() {
  const { isLoadingFiles, filesError, nodes, resetLayout, hasRunLayout } = useGraphStore()

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
      {/* Toolbar */}
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
            Ghost Graph
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

        {hasRunLayout && (
          <button
            onClick={resetLayout}
            style={{
              background: 'none',
              border: '1px solid rgba(255,255,255,0.1)',
              borderRadius: 6,
              color: 'rgba(232,232,232,0.45)',
              cursor: 'pointer',
              fontSize: 11,
              padding: '2px 8px',
            }}
            onMouseOver={(e) =>
              ((e.currentTarget as HTMLButtonElement).style.color = 'rgba(232,232,232,0.8)')
            }
            onMouseOut={(e) =>
              ((e.currentTarget as HTMLButtonElement).style.color = 'rgba(232,232,232,0.45)')
            }
          >
            Re-layout
          </button>
        )}
      </div>

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

        {/* React Flow canvas — always rendered so hooks can initialise */}
        <ReactFlowProvider>
          <GhostGraph />
        </ReactFlowProvider>
      </div>

      {/* Global keyframes for spinner + edge marching-ants animation */}
      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
        @keyframes marchingAnts { to { stroke-dashoffset: -14; } }
      `}</style>
    </div>
  )
}
