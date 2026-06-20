// System Health — the always-visible diagnostics surface over the boot probe
// (/api/health). Renders the resolved runtime state (state dir, db path, port),
// a per-check pass / degraded / fatal checklist, a degraded banner, and a Re-run
// probe button. This is the user-facing replacement for the deleted Labs
// Diagnostics panel — a normal navigation item, not a feature-gated lab.

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { motion } from 'framer-motion'
import { AlertCircle, CheckCircle2, HeartPulse, RefreshCw, XCircle } from 'lucide-react'

import { GitHubStarButton } from '@/features/promo/GitHubStarButton'
import { StatusPill, type StatusTone } from '@/features/shared/StatusPill'
import { FormattedAlert } from '@/features/shared/FormattedAlert'
import { Spinner } from '@/features/shared/Spinner'
import { ENTER_SPRING, listDelay } from '@/lib/motion'

import { fetchHealth, recheckHealth, type BootCheck, type BootReport } from './healthClient'

type CheckTone = 'ok' | 'degraded' | 'fatal'

function toneFor(report: BootReport, check: BootCheck): CheckTone {
  if (check.ok) return 'ok'
  return report.fatal.includes(check.id) ? 'fatal' : 'degraded'
}

const TONE_META: Record<
  CheckTone,
  { color: string; Icon: typeof CheckCircle2; pill: StatusTone; pillLabel: string }
> = {
  ok: { color: 'var(--mint)', Icon: CheckCircle2, pill: 'success', pillLabel: 'OK' },
  degraded: { color: 'var(--amber)', Icon: AlertCircle, pill: 'warning', pillLabel: 'Degraded' },
  fatal: { color: 'var(--primary)', Icon: XCircle, pill: 'error', pillLabel: 'Fatal' },
}

// Human-readable labels for the known boot-probe check ids. The raw camelCase
// id is demoted to a mono caption so the surface reads as a product, not a log.
const CHECK_LABELS: Record<string, string> = {
  clawbooHomeWritable: 'Clawboo home writable',
  vaultPerms: 'Secrets vault permissions',
  masterKeyBootSentinel: 'Master key',
  databaseIntegrity: 'Database integrity',
  databaseSchema: 'Database schema',
  apiPortFileMatches: 'API port file',
  mcpServersHealthy: 'MCP servers',
  openclawGatewayReachable: 'OpenClaw Gateway',
  otelExporterReachable: 'OTel exporter',
}

function humanizeCheckId(id: string): string {
  return (
    CHECK_LABELS[id] ??
    id.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase())
  )
}

const KICKER = 'mb-2.5 font-mono text-[11px] font-semibold uppercase tracking-wider'
const KICKER_COLOR = 'rgb(var(--foreground-rgb) / 0.4)'

function SectionCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section style={{ marginBottom: 18 }}>
      <div className={KICKER} style={{ color: KICKER_COLOR }}>
        {title}
      </div>
      <div className="surface-raised-tier" style={{ borderRadius: 12, padding: '4px 16px' }}>
        {children}
      </div>
    </section>
  )
}

function ResolvedRow({ label, value, last }: { label: string; value: string; last?: boolean }) {
  return (
    <div
      style={{
        display: 'flex',
        gap: 12,
        padding: '9px 0',
        fontSize: 12,
        borderBottom: last ? 'none' : '1px solid rgb(var(--foreground-rgb) / 0.05)',
      }}
    >
      <span style={{ width: 150, flexShrink: 0, color: 'rgb(var(--foreground-rgb) / 0.5)' }}>
        {label}
      </span>
      <span
        className="font-data"
        style={{ color: 'rgb(var(--foreground-rgb) / 0.85)', wordBreak: 'break-all' }}
      >
        {value}
      </span>
    </div>
  )
}

export function SystemHealthPanel() {
  const [report, setReport] = useState<BootReport | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const mountedRef = useRef(true)

  const load = useCallback(async (recheck: boolean) => {
    setLoading(true)
    setError(null)
    try {
      const r = recheck ? await recheckHealth() : await fetchHealth()
      if (mountedRef.current) setReport(r)
    } catch (err) {
      if (mountedRef.current) setError(err instanceof Error ? err.message : String(err))
    } finally {
      if (mountedRef.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    mountedRef.current = true
    void load(false)
    const t = setInterval(() => void load(false), 30_000)
    return () => {
      mountedRef.current = false
      clearInterval(t)
    }
  }, [load])

  const degradedCount = report?.degraded.length ?? 0
  const fatalCount = report?.fatal.length ?? 0
  const headerTone: StatusTone | null = report
    ? fatalCount > 0
      ? 'error'
      : degradedCount > 0
        ? 'warning'
        : 'success'
    : null
  const headerLabel =
    fatalCount > 0
      ? `${fatalCount} fatal`
      : degradedCount > 0
        ? `${degradedCount} degraded`
        : 'All systems go'

  return (
    <div
      data-testid="system-health-panel"
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        background: 'var(--background)',
        overflow: 'hidden',
      }}
    >
      {/* Toolbar (44px to host the GitHub Star pill — AppTopBar is hidden for nav views) */}
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
          <HeartPulse size={15} style={{ color: 'rgb(var(--foreground-rgb) / 0.55)' }} />
          <span
            style={{
              fontSize: 13,
              fontWeight: 600,
              fontFamily: 'var(--font-display)',
              letterSpacing: '-0.01em',
              color: 'var(--foreground)',
            }}
          >
            System Health
          </span>
          {headerTone && <StatusPill tone={headerTone} label={headerLabel} />}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <button
            data-testid="system-health-recheck"
            onClick={() => void load(true)}
            disabled={loading}
            title="Re-run the boot probe"
            className="health-recheck-btn"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              height: 30,
              padding: '0 11px',
              borderRadius: 7,
              background: 'transparent',
              border: '1px solid rgb(var(--foreground-rgb) / 0.1)',
              color: 'rgb(var(--foreground-rgb) / 0.6)',
              fontSize: 12,
              fontWeight: 500,
              cursor: loading ? 'not-allowed' : 'pointer',
              opacity: loading ? 0.6 : 1,
              transition:
                'background var(--motion-fast), border-color var(--motion-fast), color var(--motion-fast)',
            }}
            onMouseEnter={(e) => {
              if (loading) return
              e.currentTarget.style.background = 'rgb(var(--foreground-rgb) / 0.05)'
              e.currentTarget.style.borderColor = 'rgb(var(--foreground-rgb) / 0.2)'
              e.currentTarget.style.color = 'var(--foreground)'
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'transparent'
              e.currentTarget.style.borderColor = 'rgb(var(--foreground-rgb) / 0.1)'
              e.currentTarget.style.color = 'rgb(var(--foreground-rgb) / 0.6)'
            }}
          >
            {loading ? <Spinner size={12} /> : <RefreshCw size={12} />}
            Re-run probe
          </button>
          <GitHubStarButton />
        </div>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '20px 24px', maxWidth: 920 }}>
        {error && (
          <div data-testid="system-health-error" style={{ marginBottom: 16 }}>
            <FormattedAlert tone="error">Could not load health: {error}</FormattedAlert>
          </div>
        )}

        {report && (fatalCount > 0 || degradedCount > 0) && (
          <div data-testid="system-health-banner" style={{ marginBottom: 20 }}>
            <FormattedAlert tone={fatalCount > 0 ? 'error' : 'warning'}>
              {fatalCount > 0 ? (
                <>
                  <strong>The install has a fatal problem.</strong> clawboo has no upgrade/repair
                  path — reset{' '}
                  <code className="font-data" style={{ fontSize: 11 }}>
                    ~/.clawboo
                  </code>{' '}
                  and re-run onboarding to start clean.
                </>
              ) : (
                <>
                  <strong>Running degraded.</strong> Some optional subsystems are unavailable; the
                  rest of clawboo works normally. See the failing checks below.
                </>
              )}
            </FormattedAlert>
          </div>
        )}

        {/* Checks */}
        <section style={{ marginBottom: 18 }}>
          <div className={KICKER} style={{ color: KICKER_COLOR }}>
            Checks
          </div>
          {!report && loading ? (
            <div
              className="surface-raised-tier"
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                color: 'rgb(var(--foreground-rgb) / 0.5)',
                fontSize: 12,
                borderRadius: 12,
                padding: '16px',
              }}
            >
              <Spinner size={13} /> Running boot probe…
            </div>
          ) : (
            <div className="surface-raised-tier" style={{ borderRadius: 12, padding: '4px 16px' }}>
              {report?.checks.map((check, i) => {
                const tone = toneFor(report, check)
                const meta = TONE_META[tone]
                const { color, Icon } = meta
                const last = i === report.checks.length - 1
                return (
                  <motion.div
                    key={check.id}
                    data-testid={`health-check-${check.id}`}
                    initial={{ opacity: 0, y: 4 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ ...ENTER_SPRING, delay: listDelay(i) }}
                    style={{
                      display: 'flex',
                      gap: 11,
                      padding: '11px 0',
                      borderBottom: last ? 'none' : '1px solid rgb(var(--foreground-rgb) / 0.05)',
                    }}
                  >
                    <Icon size={16} style={{ color, flexShrink: 0, marginTop: 1 }} />
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div
                        style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}
                      >
                        <span
                          style={{
                            fontSize: 13,
                            fontWeight: 600,
                            color: 'var(--foreground)',
                          }}
                        >
                          {humanizeCheckId(check.id)}
                        </span>
                        <StatusPill tone={meta.pill} label={meta.pillLabel} />
                        <span
                          className="font-data"
                          style={{ fontSize: 11, color: 'rgb(var(--foreground-rgb) / 0.4)' }}
                        >
                          {check.durationMs}ms
                        </span>
                      </div>
                      <div
                        style={{
                          fontSize: 12,
                          color: 'rgb(var(--foreground-rgb) / 0.6)',
                          marginTop: 2,
                          lineHeight: 1.45,
                        }}
                      >
                        {check.message}
                      </div>
                      {!check.ok && check.detail && (
                        <div
                          className="font-data"
                          style={{
                            fontSize: 11,
                            color: 'rgb(var(--foreground-rgb) / 0.45)',
                            marginTop: 4,
                            wordBreak: 'break-all',
                          }}
                        >
                          {check.detail}
                        </div>
                      )}
                    </div>
                  </motion.div>
                )
              })}
            </div>
          )}
        </section>

        {/* Resolved runtime state */}
        {report && (
          <>
            <SectionCard title="Runtime state">
              <ResolvedRow label="clawboo home" value={report.resolved.clawbooHome} />
              <ResolvedRow label="database" value={report.resolved.dbPath} />
              <ResolvedRow
                label="API port"
                value={
                  report.resolved.apiPort == null ? '(unknown)' : String(report.resolved.apiPort)
                }
              />
              <ResolvedRow
                label="OpenClaw state dir"
                value={report.resolved.stateDir || '(not resolved)'}
              />
              <ResolvedRow
                label="secrets vault"
                value={report.resolved.vaultPresent ? 'present' : 'not yet created'}
              />
              <ResolvedRow
                label="master key"
                value={
                  report.resolved.masterKeyOk ? 'verified' : 'unreadable — re-enter runtime keys'
                }
                last
              />
            </SectionCard>

            <SectionCard title="Production defaults">
              <ResolvedRow label="log level" value={report.config.logLevel} />
              <ResolvedRow
                label="budget posture"
                value={
                  report.config.budgetHardCapUsdCents == null
                    ? `${report.config.budgetPosture} (no global hard cap; warns at ${report.config.budgetWarnSoftPct}%)`
                    : `hard cap $${(report.config.budgetHardCapUsdCents / 100).toFixed(2)}`
                }
              />
              <ResolvedRow
                label="observability"
                value={
                  report.config.otelActive
                    ? 'OTel exporter active'
                    : 'local event log (OTel opt-in)'
                }
                last
              />
            </SectionCard>
          </>
        )}
      </div>
    </div>
  )
}
