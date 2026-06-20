// ActivityTerminal — the live embedded "what are the agents doing" console.
//
// One reusable surface, mounted at three scopes (per-task, per-agent, global).
// Reads the durable obs event log via `useObsStream` (backfill + SSE live-tail),
// so it shows tool calls / results / errors / cost / lifecycle for EVERY runtime
// uniformly — including the OpenClaw in-browser path (mirrored via /api/obs/ingest).
//
// Premium per the design system: theme-aware console surface, `.font-data` mono
// rows, tabular-nums timestamps, StatusPill kind badges, expandable tool I/O, a
// distinct red rule on errors, a live pulse, autoscroll-with-pin, and the shared
// EmptyState / Skeleton primitives. No raw hex — all tokens.

import { useEffect, useMemo, useRef } from 'react'
import { motion } from 'framer-motion'
import { Terminal, ChevronRight } from 'lucide-react'

import { useFleetStore } from '@/stores/fleet'
import { EmptyState } from '@/features/shared/EmptyState'
import { Skeleton } from '@/features/shared/Skeleton'
import { StatusPill, type StatusTone } from '@/features/shared/StatusPill'

import { useObsStream, type ObsLogEvent, type ObsScope } from './useObsStream'

const muted = (o: number) => `rgb(var(--foreground-rgb) / ${o})`

// ─── Pure event → row presentation (exported for tests) ──────────────────────

export interface ActivityRow {
  tone: StatusTone
  badge: string
  label?: string
  body: string
  /** Render the body in monospace (tool I/O) vs. prose (narration). */
  mono?: boolean
}

function asStr(v: unknown): string {
  if (typeof v === 'string') return v
  if (v == null) return ''
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}

/** Map a log event to its terminal row, or null when it is trace bookkeeping. */
export function presentEvent(e: ObsLogEvent): ActivityRow | null {
  const d = e.data
  switch (e.kind) {
    case 'span_start':
    case 'span_end':
    case 'dep_linked':
      return null // pure trace internals — kept out of the activity view
    case 'tool_call':
      return {
        tone: 'idle',
        badge: 'tool',
        label: asStr(d['name']),
        body: asStr(d['input']),
        mono: true,
      }
    case 'tool_result': {
      const isErr = d['isError'] === true
      return {
        tone: isErr ? 'error' : 'success',
        badge: 'result',
        label: asStr(d['name']),
        body: asStr(d['output']),
        mono: true,
      }
    }
    case 'error':
      return { tone: 'error', badge: 'error', body: asStr(d['message']) || '(no message)' }
    case 'execution_started':
      return { tone: 'working', badge: 'run', body: 'started' }
    case 'execution_completed': {
      const s = asStr(d['status'])
      const tone: StatusTone = s === 'succeeded' ? 'done' : s === 'failed' ? 'error' : 'warning'
      return { tone, badge: 'run', label: s, body: asStr(d['error']) }
    }
    case 'status_changed': {
      const to = asStr(d['to'] ?? d['status'])
      const tone: StatusTone =
        to === 'done'
          ? 'done'
          : to === 'blocked'
            ? 'error'
            : to === 'in_progress'
              ? 'working'
              : 'idle'
      return { tone, badge: 'status', body: to }
    }
    case 'task_created':
      return { tone: 'idle', badge: 'task', body: asStr(d['title']) }
    case 'task_claimed':
      return { tone: 'working', badge: 'claim', body: asStr(d['assigneeAgentId']) }
    case 'comment_added':
      return { tone: 'idle', badge: 'note', body: asStr(d['body'] ?? d['summary']) }
    case 'cost': {
      const usd =
        typeof d['costUsd'] === 'number' ? `$${(d['costUsd'] as number).toFixed(4)}` : null
      const haveTok = d['inputTokens'] != null || d['outputTokens'] != null
      const tok = haveTok ? `${d['inputTokens'] ?? 0}↓ ${d['outputTokens'] ?? 0}↑ tok` : ''
      return { tone: 'warning', badge: 'cost', body: [usd, tok].filter(Boolean).join('  ·  ') }
    }
    case 'approval_requested':
      return { tone: 'warning', badge: 'approval', body: asStr(d['summary'] ?? 'requested') }
    case 'approval_resolved':
      return {
        tone: 'idle',
        badge: 'approval',
        body: asStr(d['decision'] ?? d['resolution'] ?? 'resolved'),
      }
    default:
      return {
        tone: 'idle',
        badge: e.kind.replace(/_/g, ' '),
        body: asStr(d['message'] ?? d['detail'] ?? ''),
      }
  }
}

const EXPAND_AT = 140 // bodies longer than this collapse behind a disclosure

function fmtTime(ts: number): string {
  const dt = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(dt.getHours())}:${p(dt.getMinutes())}:${p(dt.getSeconds())}`
}

// ─── Component ────────────────────────────────────────────────────────────────

export interface ActivityTerminalProps {
  scope: ObsScope
  /** Max scroll height of the log body (ignored when `fill`). */
  maxHeight?: number
  /** Grow to fill the parent's height instead of capping at `maxHeight`. */
  fill?: boolean
  /** Hide the header bar (the host already labels it). */
  hideHeader?: boolean
  /** Don't subscribe until true (e.g. drawer not open). */
  enabled?: boolean
}

export function ActivityTerminal({
  scope,
  maxHeight = 300,
  fill = false,
  hideHeader = false,
  enabled = true,
}: ActivityTerminalProps) {
  const { events, live, loading } = useObsStream(scope, { enabled })

  // Resolve agentId → display name (shown only when the scope spans agents).
  const fleet = useFleetStore((s) => s.agents)
  const nameOf = useMemo(() => {
    const m = new Map<string, string>()
    for (const a of fleet) m.set(a.id, a.name)
    return (id: string | null) => (id ? (m.get(id) ?? `${id.slice(0, 8)}…`) : '')
  }, [fleet])
  const showAgent = !scope.agentId

  const rows = useMemo(
    () => events.map((e) => ({ e, view: presentEvent(e) })).filter((r) => r.view != null),
    [events],
  )

  // Autoscroll-with-pin: follow the tail only while the user is near the bottom.
  const scrollRef = useRef<HTMLDivElement>(null)
  const pinnedRef = useRef(true)
  const onScroll = () => {
    const el = scrollRef.current
    if (!el) return
    pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48
  }
  useEffect(() => {
    if (pinnedRef.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [rows.length])

  return (
    <div
      style={{
        background: 'var(--code-block-bg, rgb(var(--foreground-rgb) / 0.05))',
        border: `1px solid ${muted(0.08)}`,
        borderRadius: 10,
        overflow: 'hidden',
        position: 'relative',
        display: 'flex',
        flexDirection: 'column',
        height: fill ? '100%' : undefined,
        minHeight: fill ? 0 : undefined,
      }}
    >
      {!hideHeader && (
        <div
          style={{
            height: 30,
            flexShrink: 0,
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '0 10px',
            borderBottom: `1px solid ${muted(0.06)}`,
          }}
        >
          <Terminal size={12} style={{ color: muted(0.4) }} />
          <span
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 10.5,
              fontWeight: 600,
              textTransform: 'uppercase',
              letterSpacing: '0.08em',
              color: muted(0.5),
            }}
          >
            Activity
          </span>
          <span style={{ flex: 1 }} />
          <LiveDot live={live} loading={loading} />
        </div>
      )}

      {/* When the host owns the title (hideHeader), still surface liveness — a
          small pill pinned to the console's top-right corner. */}
      {hideHeader && !loading && (
        <div
          style={{
            position: 'absolute',
            top: 6,
            right: 8,
            zIndex: 2,
            padding: '2px 7px',
            borderRadius: 999,
            background: 'var(--code-block-bg, rgb(var(--foreground-rgb) / 0.05))',
            border: `1px solid ${muted(0.07)}`,
            pointerEvents: 'none',
          }}
        >
          <LiveDot live={live} loading={loading} />
        </div>
      )}

      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="font-data"
        style={{
          ...(fill ? { flex: 1, minHeight: 0 } : { maxHeight }),
          overflowY: 'auto',
          padding: '4px 0',
        }}
      >
        {loading ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '8px 12px' }}>
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} height={12} width={`${85 - i * 12}%`} />
            ))}
          </div>
        ) : rows.length === 0 ? (
          <div style={{ padding: '14px 12px' }}>
            <EmptyState
              icon={Terminal}
              title="No activity yet"
              helper="Tool calls, results, errors, and lifecycle will stream here live as agents work."
            />
          </div>
        ) : (
          rows.map(({ e, view }) => (
            <ActivityRowItem
              key={e.seq}
              event={e}
              view={view!}
              agentName={showAgent ? nameOf(e.agentId) : ''}
            />
          ))
        )}
      </div>
    </div>
  )
}

function LiveDot({ live, loading }: { live: boolean; loading: boolean }) {
  if (loading) return null
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
      <span
        aria-hidden
        style={{
          width: 6,
          height: 6,
          borderRadius: '999px',
          background: live ? 'var(--mint)' : muted(0.35),
          animation: live ? 'clawboo-status-pulse 1.6s ease-in-out infinite' : undefined,
        }}
      />
      <span
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 9.5,
          textTransform: 'uppercase',
          letterSpacing: '0.08em',
          color: live ? 'var(--mint)' : muted(0.4),
        }}
      >
        {live ? 'Live' : 'Reconnecting'}
      </span>
    </span>
  )
}

function ActivityRowItem({
  event,
  view,
  agentName,
}: {
  event: ObsLogEvent
  view: ActivityRow
  agentName: string
}) {
  const isError = view.tone === 'error'
  const body = view.body.trim()
  const expandable = body.length > EXPAND_AT

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.18 }}
      style={{
        display: 'flex',
        gap: 8,
        alignItems: 'baseline',
        padding: '3px 10px 3px',
        borderLeft: isError ? '2px solid var(--primary)' : '2px solid transparent',
        background: isError ? 'rgb(var(--primary-rgb) / 0.05)' : undefined,
      }}
    >
      <span
        style={{
          fontSize: 10,
          color: muted(0.42),
          fontVariantNumeric: 'tabular-nums',
          flexShrink: 0,
          paddingTop: 1,
        }}
      >
        {fmtTime(event.ts)}
      </span>
      <span style={{ flexShrink: 0, paddingTop: 0.5 }}>
        <StatusPill tone={view.tone} label={view.badge} />
      </span>
      <div style={{ minWidth: 0, flex: 1, fontSize: 11.5, lineHeight: 1.45 }}>
        {(agentName || view.label) && (
          <span style={{ color: muted(0.6), marginRight: 6 }}>
            {agentName && <span style={{ color: muted(0.82), fontWeight: 600 }}>{agentName}</span>}
            {agentName && view.label ? ' ' : ''}
            {view.label && <span style={{ color: muted(0.6) }}>{view.label}</span>}
          </span>
        )}
        {expandable ? (
          <details>
            <summary
              style={{
                listStyle: 'none',
                cursor: 'pointer',
                color: muted(0.82),
                display: 'flex',
                alignItems: 'baseline',
                gap: 4,
              }}
            >
              <ChevronRight
                size={10}
                style={{ flexShrink: 0, color: muted(0.4), alignSelf: 'center' }}
              />
              <span
                style={{
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
              >
                {body.slice(0, EXPAND_AT)}…
              </span>
            </summary>
            <pre
              style={{
                margin: '4px 0 2px',
                padding: '6px 8px',
                background: muted(0.05),
                borderRadius: 6,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                fontSize: 10.5,
                color: isError ? 'var(--primary)' : muted(0.82),
                maxHeight: 220,
                overflowY: 'auto',
              }}
            >
              {body}
            </pre>
          </details>
        ) : (
          <span
            style={{ color: isError ? 'var(--primary)' : muted(0.82), wordBreak: 'break-word' }}
          >
            {body || (view.mono ? '∅' : '')}
          </span>
        )}
      </div>
    </motion.div>
  )
}
