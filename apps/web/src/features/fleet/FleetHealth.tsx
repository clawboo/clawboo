// Fleet-health overview — ONE place that summarizes the whole fleet by reading
// existing data (it never recomputes). Header metric strip (agents · 24h task
// pass-rate · 24h verification pass-rate · 24h spend) + per-runtime tiles (the
// same depth badge as the diagnostics drawer, RuntimeId-agnostic) + recent issues
// from the obs taxonomy. Refreshes on the same 8s cadence as the Runtimes panel.

import { useCallback, useEffect, useState } from 'react'
import { Activity, AlertCircle, RefreshCw } from 'lucide-react'

import { GitHubStarButton } from '@/features/promo/GitHubStarButton'
import { Button } from '@/features/shared/Button'
import { EmptyState } from '@/features/shared/EmptyState'
import { PanelHeader } from '@/features/shared/PanelHeader'
import { formatRelative } from '@/lib/formatRelative'
import {
  fetchFleetSummary,
  fetchRecentIssues,
  type FleetIssue,
  type FleetRuntimeTile,
  type FleetSummary,
} from '@/lib/fleetClient'

import { RUNTIME_CATALOG, type RuntimeId } from '../runtimes/runtimeCatalog'
import { RuntimeDepthBadge, RuntimeGlyph } from '../runtimes/runtimeDepth'

const SECTION_LABEL =
  'font-mono text-[11px] font-semibold uppercase tracking-[0.14em] text-foreground/45'
const CARD = 'rounded-2xl border border-border bg-surface'
const CARD_SHADOW = { boxShadow: 'var(--shadow-raised)' } as const

const BRANDED = new Set<string>(['clawboo-native', 'claude-code', 'codex', 'hermes'])

function runtimeName(id: string): string {
  if (id === 'openclaw') return 'OpenClaw'
  return BRANDED.has(id) ? RUNTIME_CATALOG[id as RuntimeId].name : id
}

function pct(v: number | null): string {
  return v === null ? '—' : `${Math.round(v * 100)}%`
}

function MetricCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className={`${CARD} min-w-0 px-4 py-3.5`} style={CARD_SHADOW}>
      <div className={SECTION_LABEL}>{label}</div>
      <div className="font-data mt-1.5 text-[24px] font-bold leading-none text-foreground">
        {value}
      </div>
      {sub ? <div className="mt-1.5 text-[11px] text-foreground/50">{sub}</div> : null}
    </div>
  )
}

function HealthDot({ ok }: { ok: boolean | null }) {
  const color = ok === null ? 'rgb(var(--foreground-rgb) / 0.3)' : ok ? 'var(--mint)' : 'var(--primary)'
  return (
    <span
      aria-hidden
      className="h-2 w-2 shrink-0 rounded-full"
      style={{ background: color }}
    />
  )
}

function CountChip({ n, label, color }: { n: number; label: string; color: string }) {
  const active = n > 0
  return (
    <span
      className="font-data rounded-full px-2 py-0.5 text-[11px] font-semibold"
      style={{
        color: active ? color : 'rgb(var(--foreground-rgb) / 0.4)',
        background: 'rgb(var(--foreground-rgb) / 0.05)',
      }}
    >
      {n} {label}
    </span>
  )
}

function RuntimeTile({ tile }: { tile: FleetRuntimeTile }) {
  return (
    <div
      data-testid={`fleet-tile-${tile.runtime}`}
      className={`${CARD} flex flex-col gap-2.5 p-4`}
      style={CARD_SHADOW}
    >
      <div className="flex items-center gap-2.5">
        <RuntimeGlyph id={tile.runtime} size={28} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="text-[13px] font-semibold text-foreground">
              {runtimeName(tile.runtime)}
            </span>
            <HealthDot ok={tile.healthOk} />
          </div>
          <div className="mt-1">
            <RuntimeDepthBadge runtimeClass={tile.runtimeClass} />
          </div>
        </div>
        <span className="font-data shrink-0 text-[12px] text-foreground/55">
          {tile.agentCount} {tile.agentCount === 1 ? 'agent' : 'agents'}
        </span>
      </div>
      <div className="flex flex-wrap gap-1.5">
        <CountChip n={tile.healthy} label="healthy" color="var(--mint)" />
        <CountChip n={tile.degraded} label="degraded" color="var(--amber)" />
        <CountChip n={tile.down} label="down" color="var(--primary)" />
      </div>
    </div>
  )
}

export function FleetHealth() {
  const [summary, setSummary] = useState<FleetSummary | null>(null)
  const [issues, setIssues] = useState<FleetIssue[]>([])
  const [loaded, setLoaded] = useState(false)

  const refresh = useCallback(async () => {
    const [s, i] = await Promise.all([fetchFleetSummary(), fetchRecentIssues()])
    setSummary(s)
    setIssues(i)
    setLoaded(true)
  }, [])

  useEffect(() => {
    void refresh()
    const id = setInterval(() => void refresh(), 8000)
    return () => clearInterval(id)
  }, [refresh])

  return (
    <div className="flex h-full flex-col overflow-hidden bg-background text-foreground">
      <PanelHeader
        title="Fleet"
        subtitle="Fleet health across every runtime"
        icon={Activity}
        size="md"
        border
        actions={
          <>
            {summary ? (
              <span className="font-data rounded-full bg-foreground/[0.06] px-2.5 py-0.5 text-[11px] font-semibold text-foreground/55">
                {summary.totalAgents} agents
              </span>
            ) : null}
            <Button variant="secondary" size="sm" onClick={() => void refresh()}>
              <RefreshCw size={13} strokeWidth={2} /> Refresh
            </Button>
            <GitHubStarButton />
          </>
        }
      />

      <div className="flex-1 overflow-y-auto px-6 py-5">
        <div className="mx-auto flex max-w-[880px] flex-col gap-6">
          {/* Metric strip */}
          <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))' }}>
            <MetricCard
              label="Agents"
              value={String(summary?.totalAgents ?? 0)}
              sub="across all runtimes"
            />
            <MetricCard
              label="Task pass-rate · 24h"
              value={pct(summary?.tasks24h.passRate ?? null)}
              sub={
                summary
                  ? `${summary.tasks24h.done} done · ${summary.tasks24h.inProgress} active`
                  : undefined
              }
            />
            <MetricCard
              label="Verify pass-rate · 24h"
              value={pct(summary?.verification24h.passRate ?? null)}
              sub={summary ? `${summary.verification24h.total} verdicts` : undefined}
            />
            <MetricCard
              label="Spend · 24h"
              value={`$${(summary?.spend24hUsd ?? 0).toFixed(2)}`}
              sub={
                summary
                  ? summary.budgets.paused > 0
                    ? `${summary.budgets.paused} budget paused`
                    : `${summary.budgets.count} budgets`
                  : undefined
              }
            />
          </div>

          {/* Per-runtime tiles */}
          <div>
            <div className={`${SECTION_LABEL} mb-2.5`}>Runtimes</div>
            {summary && summary.runtimes.length > 0 ? (
              <div
                className="grid gap-3"
                style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))' }}
              >
                {summary.runtimes.map((t) => (
                  <RuntimeTile key={t.runtime} tile={t} />
                ))}
              </div>
            ) : loaded ? (
              <div className="text-[12px] text-foreground/40">No runtimes reporting yet.</div>
            ) : null}
          </div>

          {/* Recent issues */}
          <div>
            <div className={`${SECTION_LABEL} mb-2.5 flex items-center gap-1.5`}>
              <AlertCircle size={13} strokeWidth={2} className="text-foreground/45" />
              Recent issues
            </div>
            {issues.length === 0 ? (
              loaded ? (
                <EmptyState
                  icon={Activity}
                  title="All clear"
                  helper="No recent errors across the fleet."
                />
              ) : null
            ) : (
              <div className={`${CARD} px-4 py-1`} style={CARD_SHADOW}>
                {issues.map((e, i) => {
                  const cls = e.errorClass ?? 'Unknown'
                  const isHarness = cls === 'Unknown'
                  return (
                    <div
                      key={i}
                      className={`py-2 text-[11.5px] ${i === 0 ? '' : 'border-t border-border'}`}
                    >
                      <span
                        className="font-semibold"
                        style={{ color: isHarness ? 'var(--primary)' : 'var(--amber)' }}
                      >
                        {cls}
                      </span>
                      {e.runtime ? (
                        <span className="text-foreground/45"> · {runtimeName(e.runtime)}</span>
                      ) : null}
                      <span className="text-foreground/40"> · {e.ts ? formatRelative(e.ts) : ''}</span>
                      {e.message ? (
                        <div className="mt-0.5 text-foreground/60">{e.message}</div>
                      ) : null}
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
