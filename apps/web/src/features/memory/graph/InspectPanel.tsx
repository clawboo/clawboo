import { useCallback, useEffect, useState } from 'react'
import { useReactFlow } from '@xyflow/react'
import { History, ThumbsDown, ThumbsUp, X } from 'lucide-react'
import { Button, IconButton } from '@/features/shared/Button'
import { StatusPill } from '@/features/shared/StatusPill'
import { formatRelative } from '@/lib/formatRelative'
import {
  getOutcomes,
  recordFeedback,
  type MemoryGraphEdgeKind,
  type MemoryOutcome,
} from '@/lib/memoryClient'
import { LearningPill, OutcomeTrail, provenanceCaption } from '../learningUi'
import { adjacencyOf, useMemoryGraphStore } from './store'
import { communityColor } from './types'

// ─── InspectPanel — click-to-inspect right dock ─────────────────────────────
//
// Shown while a node is selected: identity pills, full content, tag chips that
// pivot into search, neighbor chips that refocus the camera, and (facts only)
// the learning block — status pill, recent outcome trail, full history on
// demand, and Helpful / Outdated feedback that closes the loop through
// POST /api/memory/feedback and patches the store's learning entry in place.

const muted = (o: number) => `rgb(var(--foreground-rgb) / ${o})`

const KICKER: React.CSSProperties = {
  fontSize: 10,
  fontWeight: 600,
  letterSpacing: '0.12em',
  textTransform: 'uppercase',
  color: muted(0.4),
}

const EDGE_KIND_GLYPH: Record<MemoryGraphEdgeKind, string> = {
  similarity: '≈',
  tag: '#',
  version: 'v',
}

export function InspectPanel() {
  const payload = useMemoryGraphStore((s) => s.payload)
  const selectedNodeId = useMemoryGraphStore((s) => s.selectedNodeId)
  const { getNode, setCenter } = useReactFlow()

  const [outcomes, setOutcomes] = useState<MemoryOutcome[] | null>(null)
  const [sending, setSending] = useState(false)

  // Full-history state is per-selection.
  useEffect(() => {
    setOutcomes(null)
  }, [selectedNodeId])

  const node = payload?.nodes.find((n) => n.id === selectedNodeId) ?? null

  const focusNeighbor = useCallback(
    (neighborId: string) => {
      useMemoryGraphStore.getState().select(neighborId)
      const rfNode = getNode(neighborId)
      if (rfNode) {
        const w = rfNode.measured?.width ?? rfNode.width ?? 44
        const h = rfNode.measured?.height ?? rfNode.height ?? 44
        void setCenter(rfNode.position.x + w / 2, rfNode.position.y + h / 2, {
          zoom: 1.1,
          duration: 500,
        })
      }
    },
    [getNode, setCenter],
  )

  const sendFeedback = useCallback(
    async (outcome: 'useful' | 'dead_end') => {
      if (!node) return
      setSending(true)
      const entry = await recordFeedback(node.id, outcome)
      setSending(false)
      if (entry) useMemoryGraphStore.getState().setNodeLearning(node.id, entry)
    },
    [node],
  )

  if (!node) return null

  const adjacency = payload
    ? (adjacencyOf(payload).get(node.id) ?? new Set<string>())
    : new Set<string>()
  const nodeById = new Map((payload?.nodes ?? []).map((n) => [n.id, n]))
  // Best incident edge per neighbor (weight desc) for the chip annotation.
  const neighborEdges = new Map<string, { kind: MemoryGraphEdgeKind; weight: number }>()
  for (const e of payload?.edges ?? []) {
    const other = e.source === node.id ? e.target : e.target === node.id ? e.source : null
    if (!other) continue
    const prev = neighborEdges.get(other)
    if (!prev || e.weight > prev.weight)
      neighborEdges.set(other, { kind: e.kind, weight: e.weight })
  }
  const neighbors = [...adjacency]
    .map((id) => ({ id, node: nodeById.get(id), edge: neighborEdges.get(id) }))
    .filter((n) => n.node != null)
    .sort((a, b) => (b.edge?.weight ?? 0) - (a.edge?.weight ?? 0))

  const caption = provenanceCaption(node)

  return (
    <div
      data-testid="memory-inspect-panel"
      className="surface-floating-tier"
      style={{
        position: 'absolute',
        top: 12,
        right: 12,
        bottom: 12,
        width: 320,
        zIndex: 25,
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        padding: 14,
        borderRadius: 14,
        overflow: 'hidden',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <StatusPill tone="idle" label={node.kind} />
        <StatusPill tone="idle" label={node.scope} />
        <LearningPill learning={node.learning} />
        <span style={{ flex: 1 }} />
        <IconButton
          label="Close inspector"
          variant="ghost"
          size="sm"
          onClick={() => useMemoryGraphStore.getState().select(null)}
        >
          <X size={14} />
        </IconButton>
      </div>

      <div style={{ overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div>
          <div
            data-testid="memory-inspect-title"
            style={{ fontSize: 14, fontWeight: 600, color: 'var(--foreground)', lineHeight: 1.3 }}
          >
            {node.title}
          </div>
          <div className="font-data" style={{ fontSize: 10, color: muted(0.45), marginTop: 3 }}>
            {formatRelative(node.updatedAt)}
            {caption ? ` · ${caption}` : ''}
          </div>
        </div>

        {node.tags.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
            {node.tags.map((t) => (
              <button
                key={t}
                type="button"
                className="font-data"
                onClick={() => useMemoryGraphStore.getState().setSearchText(t)}
                style={{
                  fontSize: 10.5,
                  padding: '2px 8px',
                  borderRadius: 6,
                  border: 'none',
                  cursor: 'pointer',
                  background: muted(0.06),
                  color: muted(0.6),
                }}
              >
                {t}
              </button>
            ))}
          </div>
        )}

        <div
          style={{
            whiteSpace: 'pre-wrap',
            fontSize: 12,
            lineHeight: 1.55,
            color: muted(0.75),
            borderRadius: 10,
            background: muted(0.03),
            padding: '8px 10px',
          }}
        >
          {node.content}
          {node.contentTruncated && (
            <div style={{ marginTop: 6, fontSize: 10.5, color: muted(0.4) }}>
              Content truncated — open List mode for the full text.
            </div>
          )}
        </div>

        {node.kind === 'procedure' && (node.versions?.length ?? 0) > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <div style={KICKER}>Versions</div>
            {node.versions!.map((v) => (
              <div
                key={v.id}
                className="font-data"
                style={{ fontSize: 11, color: muted(0.55), display: 'flex', gap: 8 }}
              >
                <span>v{v.version}</span>
                <span style={{ color: muted(0.4) }}>{formatRelative(v.createdAt)}</span>
              </div>
            ))}
          </div>
        )}

        {/* Learning block — facts only (outcomes are fact-scoped in v1). */}
        {node.kind === 'fact' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div style={KICKER}>Feedback</div>
            <OutcomeTrail items={node.learning?.recentTrail ?? []} />
            {outcomes && outcomes.length > 0 && (
              <div
                data-testid="memory-inspect-history"
                style={{ display: 'flex', flexDirection: 'column', gap: 4 }}
              >
                <div style={KICKER}>Full history</div>
                <OutcomeTrail
                  items={outcomes.map((o) => ({
                    kind: o.outcome,
                    createdAt: o.createdAt,
                    agentId: o.agentId,
                    taskId: o.taskId,
                    runtime: o.runtime,
                    note: o.note,
                  }))}
                />
              </div>
            )}
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <Button
                data-testid="memory-feedback-useful"
                variant="ghost"
                size="sm"
                disabled={sending}
                onClick={() => void sendFeedback('useful')}
              >
                <ThumbsUp size={13} strokeWidth={2} style={{ color: 'var(--mint)' }} /> Helpful
              </Button>
              <Button
                data-testid="memory-feedback-deadend"
                variant="ghost"
                size="sm"
                disabled={sending}
                onClick={() => void sendFeedback('dead_end')}
              >
                <ThumbsDown size={13} strokeWidth={2} style={{ color: 'var(--amber)' }} /> Outdated
              </Button>
              {(node.learning?.uses ?? 0) > 0 && outcomes === null && (
                <Button
                  data-testid="memory-inspect-full-history"
                  variant="ghost"
                  size="sm"
                  onClick={() => void getOutcomes(node.id).then(setOutcomes)}
                >
                  <History size={13} strokeWidth={2} /> Full history
                </Button>
              )}
            </div>
          </div>
        )}

        {neighbors.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <div style={KICKER}>Neighbors</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
              {neighbors.map(({ id, node: n, edge }) => (
                <button
                  key={id}
                  type="button"
                  data-testid={`mem-neighbor-${id}`}
                  onClick={() => focusNeighbor(id)}
                  title={n!.title}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 5,
                    fontSize: 11,
                    padding: '3px 8px',
                    borderRadius: 8,
                    cursor: 'pointer',
                    border: `1px solid color-mix(in srgb, ${communityColor(n!.community)} 45%, transparent)`,
                    background: `color-mix(in srgb, ${communityColor(n!.community)} 10%, transparent)`,
                    color: 'var(--foreground)',
                    maxWidth: '100%',
                  }}
                >
                  <span
                    className="font-data"
                    aria-hidden
                    style={{ color: communityColor(n!.community), fontSize: 10 }}
                  >
                    {EDGE_KIND_GLYPH[edge?.kind ?? 'tag']}
                  </span>
                  <span
                    style={{
                      minWidth: 0,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      maxWidth: 180,
                    }}
                  >
                    {n!.title}
                  </span>
                  {edge && (
                    <span className="font-data" style={{ fontSize: 9.5, color: muted(0.45) }}>
                      {edge.weight.toFixed(2)}
                    </span>
                  )}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
