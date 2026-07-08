// System Health — the always-visible diagnostics surface over the boot probe
// (/api/health). Renders the resolved runtime state (state dir, db path, port),
// a per-check pass / degraded / fatal checklist, a degraded banner, and a Re-run
// probe button. This is the user-facing replacement for the deleted Labs
// Diagnostics panel — a normal navigation item, not a feature-gated lab.

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { motion } from 'framer-motion'
import { AlertCircle, CheckCircle2, HeartPulse, RefreshCw, XCircle } from 'lucide-react'

import { GitHubStarButton } from '@/features/promo/GitHubStarButton'
import { Button } from '@/features/shared/Button'
import { PanelHeader } from '@/features/shared/PanelHeader'
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
  fatal: { color: 'var(--destructive)', Icon: XCircle, pill: 'error', pillLabel: 'Fatal' },
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

const SECTION_LABEL = 'font-mono text-[11px] font-semibold uppercase tracking-[0.14em]'

const cardStyle: React.CSSProperties = { boxShadow: 'var(--shadow-raised)' }

function SectionCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mb-6">
      <div className={`${SECTION_LABEL} mb-2.5 text-foreground/45`}>{title}</div>
      <div
        className="rounded-2xl border border-border bg-surface px-4"
        style={cardStyle}
      >
        {children}
      </div>
    </section>
  )
}

function ResolvedRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-3 border-b border-border py-2.5 text-[13px] last:border-b-0">
      <span className="w-[150px] shrink-0 text-foreground/50">{label}</span>
      <span className="font-data break-all text-foreground/85">{value}</span>
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
      className="flex h-full flex-col overflow-hidden bg-background"
    >
      <PanelHeader
        title="System Health"
        icon={HeartPulse}
        size="md"
        border
        actions={
          <>
            {headerTone && <StatusPill tone={headerTone} label={headerLabel} />}
            <Button
              variant="secondary"
              size="sm"
              data-testid="system-health-recheck"
              onClick={() => void load(true)}
              disabled={loading}
              loading={loading}
              title="Re-run the boot probe"
            >
              <RefreshCw size={14} strokeWidth={2} />
              Re-run probe
            </Button>
            <GitHubStarButton />
          </>
        }
      />

      <div className="max-w-[920px] flex-1 overflow-y-auto px-6 py-5">
        {error && (
          <div data-testid="system-health-error" className="mb-4">
            <FormattedAlert tone="error">Could not load health: {error}</FormattedAlert>
          </div>
        )}

        {report && (fatalCount > 0 || degradedCount > 0) && (
          <div data-testid="system-health-banner" className="mb-5">
            <FormattedAlert tone={fatalCount > 0 ? 'error' : 'warning'}>
              {fatalCount > 0 ? (
                <>
                  <strong>The install has a fatal problem.</strong> clawboo has no upgrade/repair
                  path — reset{' '}
                  <code className="font-data text-[11px]">~/.clawboo</code>{' '}
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
        <section className="mb-6">
          <div className={`${SECTION_LABEL} mb-2.5 text-foreground/45`}>Checks</div>
          {!report && loading ? (
            <div
              className="flex items-center gap-2 rounded-2xl border border-border bg-surface p-4 text-[13px] text-foreground/50"
              style={cardStyle}
            >
              <Spinner size={13} /> Running boot probe…
            </div>
          ) : (
            <div
              className="rounded-2xl border border-border bg-surface px-4"
              style={cardStyle}
            >
              {report?.checks.map((check, i) => {
                const tone = toneFor(report, check)
                const meta = TONE_META[tone]
                const { color, Icon } = meta
                return (
                  <motion.div
                    key={check.id}
                    data-testid={`health-check-${check.id}`}
                    initial={{ opacity: 0, y: 4 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ ...ENTER_SPRING, delay: listDelay(i) }}
                    className="flex gap-3 border-b border-border py-3 last:border-b-0"
                  >
                    <Icon size={16} className="mt-px shrink-0" style={{ color }} />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-[13px] font-semibold text-foreground">
                          {humanizeCheckId(check.id)}
                        </span>
                        <StatusPill tone={meta.pill} label={meta.pillLabel} />
                        <span className="font-data text-[11px] text-foreground/40">
                          {check.durationMs}ms
                        </span>
                      </div>
                      <div className="mt-0.5 text-[13px] leading-snug text-foreground/60">
                        {check.message}
                      </div>
                      {!check.ok && check.detail && (
                        <div className="font-data mt-1 break-all text-[11px] text-foreground/45">
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
              />
            </SectionCard>
          </>
        )}
      </div>
    </div>
  )
}
