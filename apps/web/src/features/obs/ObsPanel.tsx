// Observability mission-control. A read-only surface over the
// orchestration event log: fleet-health triage (Gastown taxonomy), the error
// taxonomy breakdown (Cursor classes; Unknown ⇒ harness bug), a navigable
// traces list → a single span-nested trace (the full multi-agent task, leader →
// specialists → tools) with its metrics, and the event-sourced delegation graph.
// The Observability nav view is always present; all data flows from /api/obs/*.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { motion } from 'framer-motion'
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  GitBranch,
  RefreshCw,
  ShieldCheck,
} from 'lucide-react'

import { GitHubStarButton } from '@/features/promo/GitHubStarButton'
import { Button } from '@/features/shared/Button'
import { EmptyState } from '@/features/shared/EmptyState'
import { PanelHeader } from '@/features/shared/PanelHeader'
import { StatusPill, type StatusTone } from '@/features/shared/StatusPill'
import { ENTER_SPRING, listDelay } from '@/lib/motion'

import { EvalScorecard } from './EvalScorecard'

interface ObsEvent {
  seq: number
  ts: number
  kind: string
  taskId: string | null
  agentId: string | null
  runtime: string | null
  traceId: string | null
  spanId: string | null
  parentSpanId: string | null
  data: string
}
interface FleetAgent {
  agentId: string
  status: 'working' | 'idle' | 'stalled' | 'zombie'
  activeTaskId: string | null
  openExecutions: number
  costUsd: number
}
interface ObsError {
  seq: number
  ts: number
  taskId: string | null
  agentId: string | null
  runtime: string | null
  errorClass: string
  harnessBug: boolean
  message: string
}
interface ObsMetrics {
  totalCostUsd: number
  inputTokens: number
  outputTokens: number
  toolErrorRate: number
  toolCalls: number
  toolErrors: number
  activeAgents: number
  tokensPerMinute: number
}
interface TraceResult {
  traceId: string
  events: ObsEvent[]
  metrics: ObsMetrics
}
interface ProjectedGraph {
  tasks: {
    id: string
    title: string | null
    status: string
    assigneeAgentId: string | null
    costUsd: number
  }[]
  taskEdges: { id: string; source: string; target: string; kind: string }[]
  agents: { id: string; costUsd: number }[]
  agentEdges: { id: string; source: string; target: string }[]
}

// Fleet-health status → StatusPill tone.
const STATUS_PILL_TONE: Record<FleetAgent['status'], StatusTone> = {
  working: 'working',
  idle: 'idle',
  stalled: 'warning',
  zombie: 'error',
}

const KICKER =
  'mb-1.5 flex items-center gap-1.5 font-mono text-[11px] font-semibold uppercase tracking-[0.14em]'
const KICKER_COLOR = 'rgb(var(--foreground-rgb) / 0.4)'

async function getJson<T>(url: string): Promise<T | null> {
  try {
    const r = await fetch(url)
    if (!r.ok) return null
    return (await r.json()) as T
  } catch {
    return null
  }
}

/** Depth of each event's span (follows span_start parentSpanId chain).
 *  Cycle-safe: an adversarial/malformed parentSpanId cycle (A→B→A) returns a
 *  bounded depth instead of infinite-recursing — without the visited guard the
 *  recursion overflows the stack and crashes the whole Observability render
 *  (`cache.set` runs AFTER the recursive call, so a span in a cycle is never
 *  cached before it's revisited). */
export function spanDepths(events: ObsEvent[]): Map<number, number> {
  const parent = new Map<string, string | null>()
  for (const e of events) {
    if (e.kind === 'span_start' && e.spanId) parent.set(e.spanId, e.parentSpanId ?? null)
  }
  const cache = new Map<string, number>()
  const depthOf = (id: string | null | undefined, seen: Set<string> = new Set()): number => {
    if (!id) return 0
    const c = cache.get(id)
    if (c !== undefined) return c
    if (seen.has(id)) return 0 // cycle → stop following the chain
    const p = parent.get(id)
    seen.add(id)
    const d = p && parent.has(p) ? 1 + depthOf(p, seen) : 0
    cache.set(id, d)
    return d
  }
  const out = new Map<number, number>()
  for (const e of events) out.set(e.seq, depthOf(e.spanId))
  return out
}

export function ObsPanel() {
  const [health, setHealth] = useState<FleetAgent[]>([])
  const [recent, setRecent] = useState<ObsEvent[]>([])
  const [errors, setErrors] = useState<ObsError[]>([])
  const [harnessBugCount, setHarnessBugCount] = useState(0)
  const [graph, setGraph] = useState<ProjectedGraph | null>(null)
  const [trace, setTrace] = useState<TraceResult | null>(null)
  const [selectedTrace, setSelectedTrace] = useState<string | null>(null)
  const selRef = useRef<string | null>(null)
  selRef.current = selectedTrace

  const refresh = useCallback(async () => {
    const [h, ev, er, g] = await Promise.all([
      getJson<{ agents: FleetAgent[] }>('/api/obs/health'),
      getJson<{ events: ObsEvent[] }>('/api/obs/events?order=desc&limit=300'),
      getJson<{ errors: ObsError[]; harnessBugCount: number }>('/api/obs/errors'),
      getJson<ProjectedGraph>('/api/obs/graph'),
    ])
    if (h) setHealth(h.agents)
    if (ev) setRecent(ev.events)
    if (er) {
      setErrors(er.errors)
      setHarnessBugCount(er.harnessBugCount)
    }
    if (g) setGraph(g)
    const sel = selRef.current
    if (sel) {
      const t = await getJson<TraceResult>(`/api/obs/traces/${sel}`)
      if (t) setTrace(t)
    }
  }, [])

  useEffect(() => {
    void refresh()
    const id = setInterval(() => void refresh(), 5000)
    return () => clearInterval(id)
  }, [refresh])

  // Distinct recent traces (newest first), with an event count + first label.
  const traces = useMemo(() => {
    const seen = new Map<string, { traceId: string; ts: number; count: number }>()
    for (const e of recent) {
      if (!e.traceId) continue
      const cur = seen.get(e.traceId)
      if (cur) cur.count += 1
      else seen.set(e.traceId, { traceId: e.traceId, ts: e.ts, count: 1 })
    }
    return [...seen.values()].slice(0, 40)
  }, [recent])

  // Error taxonomy — grouped by class (Unknown ⇒ harness bug).
  const errorsByClass = useMemo(() => {
    const m = new Map<string, { count: number; harnessBug: boolean; sample: string }>()
    for (const e of errors) {
      const cur = m.get(e.errorClass) ?? { count: 0, harnessBug: e.harnessBug, sample: e.message }
      cur.count += 1
      cur.harnessBug = cur.harnessBug || e.harnessBug
      m.set(e.errorClass, cur)
    }
    return [...m.entries()].sort((a, b) => b[1].count - a[1].count)
  }, [errors])

  const openTrace = useCallback(async (traceId: string) => {
    setSelectedTrace(traceId)
    const t = await getJson<TraceResult>(`/api/obs/traces/${traceId}`)
    setTrace(t)
  }, [])

  const depths = useMemo(
    () => (trace ? spanDepths(trace.events) : new Map<number, number>()),
    [trace],
  )

  return (
    <div
      data-testid="obs-panel"
      className="flex h-full flex-col overflow-hidden bg-background text-foreground"
    >
      <PanelHeader
        title="Observability"
        subtitle="Live trace + fleet-health over the orchestration event log"
        icon={Activity}
        size="md"
        border
        actions={
          <>
            <span className="font-data rounded-full bg-foreground/[0.06] px-2.5 py-0.5 text-[11px] font-semibold text-foreground/55">
              {graph
                ? `${graph.tasks.length} tasks · ${graph.agents.length} agents`
                : 'event log'}
            </span>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void refresh()}
              className="obs-refresh-btn"
            >
              <RefreshCw size={13} strokeWidth={2} /> Refresh
            </Button>
            <GitHubStarButton />
          </>
        }
      />

      {/* Body */}

      <div className="flex min-h-0 flex-1 overflow-hidden">
        {/* Left: fleet health + error taxonomy + traces list */}
        <div className="flex w-[320px] shrink-0 flex-col gap-4 overflow-y-auto border-r border-border p-4">
          <Section title="Fleet health" icon={<Activity size={13} strokeWidth={2} />}>
            {health.length === 0 ? (
              <EmptyState icon={Activity} title="No active agents" paddingTop={20} />
            ) : (
              <div className="-mx-1 flex flex-col">
                {health.map((a, i) => (
                  <motion.div
                    key={a.agentId}
                    initial={{ opacity: 0, y: 4 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ ...ENTER_SPRING, delay: listDelay(i) }}
                    className="flex items-center justify-between gap-2 rounded-lg px-1.5 py-1.5 text-[11px] transition-colors hover:bg-foreground/[0.03]"
                  >
                    <span className="flex min-w-0 items-center gap-2 truncate">
                      <StatusPill tone={STATUS_PILL_TONE[a.status]} aria-label={a.status} />
                      <span className="font-data truncate text-foreground/80">
                        {a.agentId.slice(0, 12)}
                      </span>
                      {a.openExecutions > 0 && (
                        <span className="font-data shrink-0 rounded-md bg-foreground/[0.06] px-1.5 py-0.5 text-[10px] text-foreground/50">
                          {a.openExecutions} run{a.openExecutions > 1 ? 's' : ''}
                        </span>
                      )}
                    </span>
                    <span className="font-data shrink-0 text-foreground/50">
                      {a.status} · ${a.costUsd.toFixed(3)}
                    </span>
                  </motion.div>
                ))}
              </div>
            )}
          </Section>

          <Section
            title={`Error taxonomy (${errorsByClass.length} · ${harnessBugCount} bug${harnessBugCount === 1 ? '' : 's'})`}
            icon={
              <AlertTriangle
                size={13}
                strokeWidth={2}
                className={harnessBugCount > 0 ? 'text-primary' : 'text-foreground/45'}
              />
            }
          >
            <div data-testid="obs-error-taxonomy">
              {errorsByClass.length === 0 ? (
                <EmptyState
                  icon={ShieldCheck}
                  title="No errors"
                  helper="Every run is clean."
                  tone="mint"
                  paddingTop={20}
                />
              ) : (
                <div className="-mx-1 flex flex-col">
                  {errorsByClass.map(([cls, info], i) => (
                    <motion.div
                      key={cls}
                      initial={{ opacity: 0, y: 4 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ ...ENTER_SPRING, delay: listDelay(i) }}
                      className="flex items-center justify-between gap-2 rounded-lg px-1.5 py-1.5 text-[11px] transition-colors hover:bg-foreground/[0.03]"
                    >
                      <span className="flex min-w-0 items-center gap-1.5">
                        <span
                          className={`font-data rounded-md px-1.5 py-0.5 text-[11px] ${
                            info.harnessBug
                              ? 'bg-primary/[0.12] text-primary'
                              : 'bg-foreground/[0.06] text-foreground/60'
                          }`}
                        >
                          {cls}
                        </span>
                        {info.harnessBug && (
                          <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-primary">
                            harness bug
                          </span>
                        )}
                      </span>
                      <span className="font-data font-semibold text-foreground/60">
                        {info.count}
                      </span>
                    </motion.div>
                  ))}
                </div>
              )}
            </div>
          </Section>

          <Section title={`Traces (${traces.length})`} icon={<GitBranch size={13} strokeWidth={2} />}>
            <div data-testid="obs-traces-list">
              {traces.length === 0 ? (
                <EmptyState
                  icon={GitBranch}
                  title="No traces yet"
                  helper="Run a board task to populate the trace log."
                  paddingTop={20}
                />
              ) : (
                <div className="-mx-1 flex flex-col">
                  {traces.map((t, i) => (
                    <motion.button
                      key={t.traceId}
                      data-testid="obs-trace-item"
                      initial={{ opacity: 0, y: 4 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ ...ENTER_SPRING, delay: listDelay(i) }}
                      onClick={() => void openTrace(t.traceId)}
                      className={`flex w-full cursor-pointer items-center justify-between gap-2 rounded-lg px-1.5 py-1.5 text-left text-[11px] transition-colors hover:bg-foreground/[0.05] ${
                        selectedTrace === t.traceId
                          ? 'bg-primary/[0.06] ring-1 ring-inset ring-primary/25'
                          : ''
                      }`}
                    >
                      <span className="font-data truncate text-foreground/80">
                        {t.traceId.slice(0, 16)}
                      </span>
                      <span className="flex shrink-0 items-center gap-2">
                        <span className="font-data text-[11px] text-foreground/45">
                          {t.count} ev
                        </span>
                        <span className="font-data text-foreground/45">
                          {new Date(t.ts).toLocaleTimeString()}
                        </span>
                      </span>
                    </motion.button>
                  ))}
                </div>
              )}
            </div>
          </Section>
        </div>

        {/* Right: the eval scorecard + the navigable single trace + the graph */}
        <div className="flex min-w-0 flex-1 flex-col overflow-y-auto px-6 py-5">
          <div className="mb-5">
            <EvalScorecard />
          </div>

          {trace ? (
            <div data-testid="obs-trace-detail">
              <div className={KICKER} style={{ color: KICKER_COLOR }}>
                <GitBranch size={12} strokeWidth={2} />
                Trace
              </div>
              <div
                className="rounded-2xl border border-border bg-surface p-5"
                style={{ boxShadow: 'var(--shadow-raised)' }}
              >
                <div className="mb-3 flex items-baseline gap-2 text-[12px] font-semibold">
                  <span className="font-data text-foreground/70">
                    {trace.traceId.slice(0, 24)}
                  </span>
                  <span className="font-data text-[11px] font-normal text-foreground/45">
                    {trace.events.length} events
                  </span>
                </div>

                {/* Metrics bar */}
                <div className="mb-4 flex flex-wrap gap-x-5 gap-y-1.5 rounded-xl border border-border bg-foreground/[0.02] px-4 py-2.5 text-[11px]">
                  <Metric label="cost" value={`$${trace.metrics.totalCostUsd.toFixed(4)}`} />
                  <Metric
                    label="tokens"
                    value={`${trace.metrics.inputTokens}→${trace.metrics.outputTokens}`}
                  />
                  <Metric label="tok/min" value={trace.metrics.tokensPerMinute.toFixed(0)} />
                  <Metric label="tools" value={`${trace.metrics.toolCalls}`} />
                  <Metric
                    label="tool err"
                    value={`${(trace.metrics.toolErrorRate * 100).toFixed(0)}%`}
                    tone={trace.metrics.toolErrorRate > 0 ? 'var(--amber)' : undefined}
                  />
                </div>

                {/* Span-nested timeline */}
                <div className="space-y-0.5 font-mono text-[11px]">
                  {trace.events.map((e, i) => (
                    <TraceRow key={e.seq} ev={e} depth={depths.get(e.seq) ?? 0} index={i} />
                  ))}
                </div>
              </div>
            </div>
          ) : (
            <EmptyState
              icon={GitBranch}
              title="No trace selected"
              helper="Select a trace to render the full multi-agent task."
            />
          )}

          {graph && graph.taskEdges.length > 0 && (
            <div className="mt-6">
              <div className={KICKER} style={{ color: KICKER_COLOR }}>
                <GitBranch size={12} strokeWidth={2} />
                Delegation graph
              </div>
              <div
                className="rounded-2xl border border-border bg-surface p-5"
                style={{ boxShadow: 'var(--shadow-raised)' }}
              >
                <div className="mb-3 flex items-center gap-4 text-[11px] text-foreground/45">
                  <span className="flex items-center gap-1.5">
                    <ArrowRight size={12} strokeWidth={2} className="text-primary" /> delegation
                  </span>
                  <span className="flex items-center gap-1.5">
                    <ArrowRight size={12} strokeWidth={2} className="text-primary opacity-60" />{' '}
                    dependency
                  </span>
                </div>
                <div className="space-y-0.5 font-mono text-[11px] text-foreground/50">
                  {graph.taskEdges.map((edge, i) => (
                    <motion.div
                      key={edge.id}
                      initial={{ opacity: 0, y: 4 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ ...ENTER_SPRING, delay: listDelay(i) }}
                      className="flex items-center py-0.5"
                    >
                      <span className="font-data text-foreground">{edge.source.slice(0, 8)}</span>
                      <ArrowRight
                        size={12}
                        strokeWidth={2}
                        className={`mx-1.5 text-primary ${edge.kind === 'delegation' ? '' : 'opacity-60'}`}
                      />
                      <span className="font-data text-foreground">{edge.target.slice(0, 8)}</span>
                      <span className="font-data ml-2 text-[11px] text-foreground/40">
                        {edge.kind}
                      </span>
                    </motion.div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function Metric({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <span className="flex items-baseline gap-1.5">
      <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-foreground/45">
        {label}
      </span>
      <span
        className="font-data font-semibold text-foreground"
        style={tone ? { color: tone } : undefined}
      >
        {value}
      </span>
    </span>
  )
}

function TraceRow({ ev, depth, index }: { ev: ObsEvent; depth: number; index: number }) {
  const tone =
    ev.kind === 'error'
      ? 'text-primary'
      : ev.kind === 'span_start' || ev.kind === 'span_end'
        ? 'text-mint'
        : ev.kind === 'cost'
          ? 'text-amber'
          : 'text-secondary'
  return (
    <motion.div
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ ...ENTER_SPRING, delay: listDelay(index) }}
      className="flex items-center gap-2 rounded px-1 py-0.5 transition-colors hover:bg-foreground/[0.02]"
    >
      <span className="font-data w-28 shrink-0 text-foreground/40">
        {new Date(ev.ts).toLocaleTimeString()}
      </span>
      <span className="flex w-36 shrink-0 items-stretch" style={{ paddingLeft: depth * 12 }}>
        {depth > 0 && (
          <span
            aria-hidden
            className="mr-2 shrink-0 self-stretch"
            style={{ width: 1, borderLeft: '1px solid var(--border)' }}
          />
        )}
        <span className={`truncate ${tone}`}>{ev.kind}</span>
      </span>
      <span className="truncate text-foreground/70">
        {ev.agentId ? `${ev.agentId.slice(0, 8)} ` : ''}
        {labelFor(ev)}
      </span>
    </motion.div>
  )
}

function labelFor(ev: ObsEvent): string {
  try {
    const d = JSON.parse(ev.data) as Record<string, unknown>
    if (ev.kind === 'tool_call' || ev.kind === 'tool_result') return String(d['name'] ?? '')
    if (ev.kind === 'cost') return `$${Number(d['costUsd'] ?? 0).toFixed(4)}`
    if (ev.kind === 'status_changed') return `→ ${String(d['to'] ?? '')}`
    if (ev.kind === 'error')
      return `[${String(d['errorClass'] ?? '')}] ${String(d['message'] ?? '').slice(0, 50)}`
    if (ev.kind === 'span_start' || ev.kind === 'span_end') return String(d['name'] ?? '')
    if (ev.kind === 'task_created') return String(d['title'] ?? '')
    return ''
  } catch {
    return ''
  }
}

function Section({
  title,
  icon,
  children,
}: {
  title: string
  icon: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <div
      className="rounded-2xl border border-border bg-surface p-4"
      style={{ boxShadow: 'var(--shadow-raised)' }}
    >
      <div className={KICKER} style={{ color: KICKER_COLOR }}>
        {icon}
        {title}
      </div>
      {children}
    </div>
  )
}
