import { useEffect, useRef } from 'react'
import { useMemoryGraphStore } from './store'
import { communityColor } from './types'

// ─── LegendPanel — community legend + edge-kind key (bottom-left dock) ───────
//
// Per-community checkbox rows drive `hiddenCommunities`; the tri-state
// select-all covers the all / none / mixed states. The counts footer + edge key
// make the canvas legible without hovering anything.

const muted = (o: number) => `rgb(var(--foreground-rgb) / ${o})`

function EdgeSwatch({ dash }: { dash?: string }) {
  return (
    <svg width={22} height={6} aria-hidden style={{ flexShrink: 0 }}>
      <line
        x1={1}
        y1={3}
        x2={21}
        y2={3}
        stroke="rgb(var(--foreground-rgb) / 0.55)"
        strokeWidth={1.5}
        strokeDasharray={dash}
      />
    </svg>
  )
}

export function LegendPanel() {
  const payload = useMemoryGraphStore((s) => s.payload)
  const hiddenCommunities = useMemoryGraphStore((s) => s.hiddenCommunities)
  const toggleCommunity = useMemoryGraphStore((s) => s.toggleCommunity)
  const setHiddenCommunities = useMemoryGraphStore((s) => s.setHiddenCommunities)

  const communities = payload?.communities ?? []
  const allHidden = communities.length > 0 && communities.every((c) => hiddenCommunities.has(c.id))
  const noneHidden = hiddenCommunities.size === 0
  const indeterminate = !allHidden && !noneHidden

  const selectAllRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (selectAllRef.current) selectAllRef.current.indeterminate = indeterminate
  }, [indeterminate])

  if (!payload || communities.length === 0) return null

  const factCount = payload.nodes.filter((n) => n.kind === 'fact').length
  const procCount = payload.nodes.filter((n) => n.kind === 'procedure').length

  return (
    <div
      data-testid="memory-graph-legend"
      className="surface-floating-tier"
      style={{
        position: 'absolute',
        bottom: 12,
        left: 12,
        zIndex: 20,
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        padding: '10px 12px',
        borderRadius: 12,
        maxHeight: '46%',
        width: 200,
      }}
    >
      <label
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 7,
          fontSize: 11,
          fontWeight: 600,
          color: muted(0.7),
          cursor: 'pointer',
        }}
      >
        <input
          ref={selectAllRef}
          data-testid="legend-select-all"
          type="checkbox"
          checked={noneHidden}
          onChange={() =>
            // Checked (or indeterminate) → hide all; fully hidden → show all.
            setHiddenCommunities(allHidden ? new Set() : new Set(communities.map((c) => c.id)))
          }
          style={{ accentColor: 'var(--primary)' }}
        />
        Clusters
      </label>

      <div style={{ overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 2 }}>
        {communities.map((c) => (
          <label
            key={c.id}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 7,
              fontSize: 11.5,
              color: muted(0.75),
              cursor: 'pointer',
              padding: '2px 0',
            }}
          >
            <input
              data-testid={`legend-community-${c.id}`}
              type="checkbox"
              checked={!hiddenCommunities.has(c.id)}
              onChange={() => toggleCommunity(c.id)}
              style={{ accentColor: communityColor(c.id) }}
            />
            <span
              aria-hidden
              style={{
                width: 8,
                height: 8,
                borderRadius: '50%',
                background: communityColor(c.id),
                flexShrink: 0,
              }}
            />
            <span
              style={{
                flex: 1,
                minWidth: 0,
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
            >
              {c.label}
            </span>
            <span className="font-data" style={{ fontSize: 10, color: muted(0.45) }}>
              {c.size}
            </span>
          </label>
        ))}
      </div>

      {/* Edge-kind key */}
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 3,
          paddingTop: 6,
          borderTop: `1px solid ${muted(0.08)}`,
          fontSize: 10.5,
          color: muted(0.55),
        }}
      >
        <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <EdgeSwatch /> similar
        </span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <EdgeSwatch dash="4 4" /> shared tag
        </span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <EdgeSwatch dash="2 3" /> version
        </span>
      </div>

      <div
        className="font-data"
        style={{
          paddingTop: 6,
          borderTop: `1px solid ${muted(0.08)}`,
          fontSize: 10,
          color: muted(0.45),
        }}
      >
        {factCount} facts · {procCount} procedures · {communities.length} clusters
      </div>
    </div>
  )
}
