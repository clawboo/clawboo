import { useEffect, useRef } from 'react'
import { useMemoryGraphStore } from './store'
import { countLabel } from './types'

// ─── LegendPanel: cluster filter + link key (bottom-left dock) ──────────────
//
// Reads as one quiet reference card: a micro-label, a scannable list with
// tabular counts, then the link key. No cluster swatches: clusters are named
// on the canvas and achromatic by design, so a colour chip here would be the
// one place hue implied identity.

const muted = (o: number) => `rgb(var(--foreground-rgb) / ${o})`

const microLabel: React.CSSProperties = {
  fontSize: 9.5,
  fontWeight: 600,
  letterSpacing: '0.1em',
  textTransform: 'uppercase',
  color: 'var(--muted-foreground)',
}

function EdgeSwatch({ dash }: { dash?: string }) {
  return (
    <svg width={20} height={6} aria-hidden style={{ flexShrink: 0 }}>
      <line
        x1={1}
        y1={3}
        x2={19}
        y2={3}
        stroke={muted(0.42)}
        strokeWidth={1.25}
        strokeLinecap="round"
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
        gap: 8,
        padding: '11px 12px 10px',
        borderRadius: 12,
        maxHeight: '52%',
        width: 212,
      }}
    >
      <label
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          cursor: 'pointer',
          ...microLabel,
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
        <span style={{ flex: 1 }}>Clusters</span>
        <span
          className="font-data"
          style={{ fontSize: 10, letterSpacing: 0, color: 'var(--muted-foreground)' }}
        >
          {communities.length}
        </span>
      </label>

      <div style={{ overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 1 }}>
        {communities.map((c) => (
          <label
            key={c.id}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              fontSize: 11.5,
              color: hiddenCommunities.has(c.id) ? 'var(--muted-foreground)' : 'var(--foreground)',
              cursor: 'pointer',
              padding: '2.5px 0',
              transition: 'color 150ms ease',
            }}
          >
            <input
              data-testid={`legend-community-${c.id}`}
              type="checkbox"
              checked={!hiddenCommunities.has(c.id)}
              onChange={() => toggleCommunity(c.id)}
              style={{ accentColor: 'var(--primary)' }}
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
            <span
              className="font-data"
              style={{
                fontSize: 10,
                color: 'var(--muted-foreground)',
                fontVariantNumeric: 'tabular-nums',
              }}
            >
              {c.size}
            </span>
          </label>
        ))}
      </div>

      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 4,
          paddingTop: 8,
          borderTop: `1px solid ${muted(0.08)}`,
        }}
      >
        <span style={microLabel}>Links</span>
        {(
          [
            [undefined, 'similar'],
            ['3 4', 'shared tag'],
            ['1.5 3', 'version'],
          ] as const
        ).map(([dash, label]) => (
          <span
            key={label}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 7,
              fontSize: 11,
              color: 'var(--muted-foreground)',
            }}
          >
            <EdgeSwatch dash={dash} /> {label}
          </span>
        ))}
      </div>

      <div
        className="font-data"
        style={{
          paddingTop: 8,
          borderTop: `1px solid ${muted(0.08)}`,
          fontSize: 10,
          color: 'var(--muted-foreground)',
        }}
      >
        {countLabel(factCount, 'fact')} · {countLabel(procCount, 'procedure')}
      </div>
    </div>
  )
}
