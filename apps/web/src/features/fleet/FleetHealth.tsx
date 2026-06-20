// Fleet-health overview — ONE place that summarizes the whole fleet by reading
// existing data (it never recomputes). Header metric strip (agents · 24h task
// pass-rate · 24h verification pass-rate · 24h spend) + per-runtime tiles (the
// same depth badge as the diagnostics drawer, RuntimeId-agnostic) + recent issues
// from the obs taxonomy. Refreshes on the same 8s cadence as the Runtimes panel.

import { useCallback, useEffect, useState } from 'react'
import { Activity, AlertCircle, RefreshCw } from 'lucide-react'

import { GitHubStarButton } from '@/features/promo/GitHubStarButton'
import { EmptyState } from '@/features/shared/EmptyState'
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

const muted = (o: number) => `rgb(var(--foreground-rgb) / ${o})`

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
    <div className="surface-raised-tier rounded-xl" style={{ padding: '12px 14px', minWidth: 0 }}>
      <div
        className="font-mono uppercase"
        style={{ fontSize: 9.5, letterSpacing: '0.06em', color: muted(0.45) }}
      >
        {label}
      </div>
      <div
        className="tabular-nums"
        style={{ fontSize: 24, fontWeight: 700, color: 'var(--foreground)', marginTop: 2 }}
      >
        {value}
      </div>
      {sub ? <div style={{ fontSize: 11, color: muted(0.5), marginTop: 1 }}>{sub}</div> : null}
    </div>
  )
}

function HealthDot({ ok }: { ok: boolean | null }) {
  const color = ok === null ? muted(0.3) : ok ? 'var(--mint)' : 'var(--primary)'
  return (
    <span
      aria-hidden
      style={{ width: 8, height: 8, borderRadius: 4, background: color, flexShrink: 0 }}
    />
  )
}

function CountChip({ n, label, color }: { n: number; label: string; color: string }) {
  return (
    <span
      className="tabular-nums"
      style={{
        fontSize: 10.5,
        fontWeight: 600,
        padding: '1px 7px',
        borderRadius: 6,
        color,
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
      className="surface-raised-tier rounded-xl"
      style={{ padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 8 }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
        <RuntimeGlyph id={tile.runtime} size={28} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--foreground)' }}>
              {runtimeName(tile.runtime)}
            </span>
            <HealthDot ok={tile.healthOk} />
          </div>
          <div style={{ marginTop: 2 }}>
            <RuntimeDepthBadge runtimeClass={tile.runtimeClass} />
          </div>
        </div>
        <span className="tabular-nums" style={{ fontSize: 12, color: muted(0.55), flexShrink: 0 }}>
          {tile.agentCount} {tile.agentCount === 1 ? 'agent' : 'agents'}
        </span>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
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
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div
        style={{
          height: 44,
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '0 12px',
          borderBottom: '1px solid rgb(var(--foreground-rgb) / 0.06)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Activity size={15} style={{ color: 'var(--mint)' }} />
          <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--foreground)' }}>Fleet</span>
          {summary ? (
            <span
              className="tabular-nums"
              style={{
                fontSize: 10,
                fontFamily: 'var(--font-geist-mono, monospace)',
                color: 'var(--primary)',
                background: 'rgb(var(--primary-rgb) / 0.12)',
                borderRadius: 20,
                padding: '2px 8px',
              }}
            >
              {summary.totalAgents} agents
            </span>
          ) : null}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <button
            type="button"
            onClick={() => void refresh()}
            aria-label="Refresh"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 5,
              fontSize: 11,
              color: muted(0.5),
              background: 'transparent',
              border: 'none',
              cursor: 'pointer',
            }}
          >
            <RefreshCw size={12} /> Refresh
          </button>
          <GitHubStarButton />
        </div>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '16px 18px' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 18, maxWidth: 880 }}>
          {/* Metric strip */}
          <div
            style={{
              display: 'grid',
              gap: 10,
              gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
            }}
          >
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
            <p style={{ fontSize: 11, color: muted(0.45), marginBottom: 8, lineHeight: 1.6 }}>
              Each runtime, by integration depth — health, agent count, and status mix.
            </p>
            {summary && summary.runtimes.length > 0 ? (
              <div
                style={{
                  display: 'grid',
                  gap: 12,
                  gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
                }}
              >
                {summary.runtimes.map((t) => (
                  <RuntimeTile key={t.runtime} tile={t} />
                ))}
              </div>
            ) : loaded ? (
              <div style={{ fontSize: 12, color: muted(0.4) }}>No runtimes reporting yet.</div>
            ) : null}
          </div>

          {/* Recent issues */}
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 8 }}>
              <AlertCircle size={13} style={{ color: muted(0.5) }} />
              <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--foreground)' }}>
                Recent issues
              </span>
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
              <div className="surface-raised-tier rounded-xl" style={{ padding: '4px 14px' }}>
                {issues.map((e, i) => (
                  <div
                    key={i}
                    style={{
                      fontSize: 11.5,
                      padding: '8px 0',
                      borderTop: i === 0 ? 'none' : '1px solid rgb(var(--foreground-rgb) / 0.05)',
                    }}
                  >
                    <span style={{ color: 'var(--primary)', fontWeight: 600 }}>
                      {e.errorClass ?? 'Unknown'}
                    </span>
                    {e.runtime ? (
                      <span style={{ color: muted(0.45) }}> · {runtimeName(e.runtime)}</span>
                    ) : null}
                    <span style={{ color: muted(0.4) }}> · {e.ts ? formatRelative(e.ts) : ''}</span>
                    {e.message ? (
                      <div style={{ color: muted(0.6), marginTop: 2 }}>{e.message}</div>
                    ) : null}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
