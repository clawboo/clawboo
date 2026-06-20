// Eval scorecard. The runnable "prove the harness works with a
// click" surface inside the Observability panel: a button runs the DETERMINISTIC
// smoke suite (server-side, ephemeral throwaway boards, no live model / keys) and
// renders the real SuiteReport (pass@1 / pass^k / per-task). Below it, the full
// ±verifier × ±structured-state ablation is rendered as its SHAPE + EXPLAINED — it
// runs in CI (4 variants × N trials with the live-model judge), never on demand,
// and no baseline numbers are hardcoded (em-dash placeholders until a CI run fills
// them). Observability is always on, so this surface serves unconditionally.

import { useCallback, useState } from 'react'

import { motion } from 'framer-motion'
import { Check, FlaskConical, Minus, Play } from 'lucide-react'

import { FormattedAlert } from '@/features/shared/FormattedAlert'
import { Spinner } from '@/features/shared/Spinner'
import { StatusPill } from '@/features/shared/StatusPill'
import { ENTER_SPRING, listDelay } from '@/lib/motion'
import { runSmokeEvals, type SuiteReport } from '@/lib/evalsClient'

function pct(v: number): string {
  return `${Math.round(v * 100)}%`
}

function passTone(v: number): string {
  return v >= 1 ? 'var(--mint)' : v > 0 ? 'var(--amber)' : 'var(--primary)'
}

const KICKER = 'mb-1.5 font-mono text-[11px] font-semibold uppercase tracking-wider'
const KICKER_COLOR = 'rgb(var(--foreground-rgb) / 0.4)'

// The ±verifier × ±structured-state ablation shape. The numbers come from the CI
// run (live-model judge) — here we render the SHAPE with em-dash placeholders so
// the scorecard reads as a real table, not a sentence.
const ABLATION_VARIANTS: { variant: string; verify: boolean; structured: boolean }[] = [
  { variant: 'full', verify: true, structured: true },
  { variant: '−verifier', verify: false, structured: true },
  { variant: '−structured', verify: true, structured: false },
  { variant: 'none', verify: false, structured: false },
]
const ABLATION_CONTRIBUTIONS = ['verifier', 'structured-state'] as const

function AblationFlag({ on }: { on: boolean }) {
  return on ? (
    <Check size={12} className="text-mint" aria-label="on" />
  ) : (
    <Minus size={12} className="text-foreground/30" aria-label="off" />
  )
}

function Metric({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <span className="flex items-baseline gap-1.5">
      <span className="text-[11px] uppercase tracking-wider text-secondary">{label}</span>
      <span
        className="font-data font-semibold text-foreground"
        style={tone ? { color: tone } : undefined}
      >
        {value}
      </span>
    </span>
  )
}

export function EvalScorecard() {
  const [report, setReport] = useState<SuiteReport | null>(null)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState(false)

  const run = useCallback(async () => {
    setRunning(true)
    setError(false)
    const r = await runSmokeEvals({ trials: 1 })
    if (r) setReport(r)
    else setError(true)
    setRunning(false)
  }, [])

  return (
    <div
      data-testid="eval-scorecard"
      className="surface-raised-tier flex flex-col gap-3"
      style={{ borderRadius: 12, padding: '12px 14px' }}
    >
      {/* Header + run button */}
      <div className="flex items-center justify-between gap-2.5">
        <span className="flex items-center gap-2">
          <FlaskConical size={14} className="text-mint" />
          <span
            style={{
              fontSize: 13,
              fontWeight: 600,
              fontFamily: 'var(--font-display)',
              letterSpacing: '-0.01em',
              color: 'var(--foreground)',
            }}
          >
            Eval scorecard
          </span>
        </span>
        <button
          type="button"
          data-testid="obs-run-smoke-evals"
          onClick={() => void run()}
          disabled={running}
          className="eval-run-btn flex h-[30px] items-center gap-1.5 rounded-md border px-3 text-[12px] font-semibold transition-colors"
          style={{
            border: '1px solid rgb(var(--mint-rgb) / 0.3)',
            background: 'rgb(var(--mint-rgb) / 0.12)',
            color: 'var(--mint)',
            cursor: running ? 'default' : 'pointer',
            opacity: running ? 0.7 : 1,
          }}
          onMouseEnter={(e) => {
            if (running) return
            e.currentTarget.style.background = 'rgb(var(--mint-rgb) / 0.2)'
            e.currentTarget.style.borderColor = 'rgb(var(--mint-rgb) / 0.45)'
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = 'rgb(var(--mint-rgb) / 0.12)'
            e.currentTarget.style.borderColor = 'rgb(var(--mint-rgb) / 0.3)'
          }}
        >
          {running ? <Spinner size={12} /> : <Play size={12} />}
          {running ? 'Running…' : 'Run smoke evals'}
        </button>
      </div>

      <div className="text-[12px] leading-relaxed text-secondary">
        Runs the deterministic smoke suite (the CI subset) on throwaway boards — no live model, no
        API keys. The results are real and reproducible.
      </div>

      {error && !report && (
        <div className="text-[12px] text-primary">Smoke run failed — check the server log.</div>
      )}

      {/* Live SuiteReport */}
      {report && (
        <div
          data-testid="eval-suite-report"
          className="surface-raised-tier flex flex-col gap-2"
          style={{ borderRadius: 10, padding: 12 }}
        >
          <div className="flex flex-wrap gap-4">
            <Metric label="pass@1" value={pct(report.passAt1)} tone={passTone(report.passAt1)} />
            <Metric label="pass^k" value={pct(report.passPowK)} tone={passTone(report.passPowK)} />
            <Metric label="k" value={String(report.k)} />
            <Metric label="tasks" value={String(report.tasks.length)} />
          </div>
          <div className="flex flex-col gap-0.5">
            <div className="flex pb-0.5 text-[11px] uppercase tracking-wider text-secondary">
              <span className="flex-[2]">task</span>
              <span className="flex-1">suite</span>
              <span className="flex-1">kind</span>
              <span className="w-14 text-right">pass@1</span>
              <span className="w-14 text-right">score</span>
            </div>
            {report.tasks.map((t, i) => (
              <motion.div
                key={t.taskId}
                data-testid="eval-task-row"
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ ...ENTER_SPRING, delay: listDelay(i) }}
                className="flex items-center py-0.5 text-[12px] text-foreground/70"
              >
                <span className="flex-[2] truncate font-mono">{t.taskId}</span>
                <span className="flex-1 text-secondary">{t.suite}</span>
                <span className="flex-1 text-secondary">{t.kind}</span>
                <span className="font-data w-14 text-right" style={{ color: passTone(t.passAt1) }}>
                  {pct(t.passAt1)}
                </span>
                <span className="font-data w-14 text-right text-foreground/55">
                  {t.meanScore.toFixed(2)}
                </span>
              </motion.div>
            ))}
          </div>
        </div>
      )}

      {/* Ablation — the real scorecard SHAPE, explained (runs in CI, not on demand) */}
      <div
        data-testid="ablation-scorecard"
        className="surface-raised-tier flex flex-col gap-2.5"
        style={{ borderRadius: 10, padding: 12 }}
      >
        <div className="flex items-center justify-between gap-2">
          <span className={KICKER} style={{ color: KICKER_COLOR, marginBottom: 0 }}>
            Ablation
          </span>
          <StatusPill tone="idle" label="CI only" />
        </div>
        <FormattedAlert tone="info">
          The ±verifier × ±structured-state marginal-contribution scorecard runs in CI (4 variants ×
          N trials, live-model judge) — trigger it from the Actions tab, not on demand.
        </FormattedAlert>

        {/* Variant rows — the shape; numbers fill in from the CI run. */}
        <div className="flex flex-col gap-0.5">
          <div className="flex pb-0.5 text-[11px] uppercase tracking-wider text-secondary">
            <span className="flex-[2]">variant</span>
            <span className="flex-1 text-center">verify</span>
            <span className="flex-1 text-center">structured</span>
            <span className="w-14 text-right">pass@1</span>
            <span className="w-14 text-right">pass^k</span>
          </div>
          {ABLATION_VARIANTS.map((v) => (
            <div
              key={v.variant}
              data-testid="ablation-variant-row"
              className="flex items-center py-0.5 text-[12px] text-foreground/70"
            >
              <span className="flex-[2] font-mono">{v.variant}</span>
              <span className="flex flex-1 justify-center">
                <AblationFlag on={v.verify} />
              </span>
              <span className="flex flex-1 justify-center">
                <AblationFlag on={v.structured} />
              </span>
              <span className="font-data w-14 text-right text-foreground/40">—</span>
              <span className="font-data w-14 text-right text-foreground/40">—</span>
            </div>
          ))}
        </div>

        {/* Marginal contributions (Δ pass@1) — verifier / structured-state. */}
        <div className="flex flex-col gap-0.5">
          <span className="text-[11px] uppercase tracking-wider text-secondary">
            marginal contribution (Δ pass@1)
          </span>
          {ABLATION_CONTRIBUTIONS.map((c) => (
            <div
              key={c}
              data-testid="ablation-contribution-row"
              className="flex items-center py-0.5 text-[12px] text-foreground/70"
            >
              <span className="flex-1 font-mono">{c}</span>
              <span className="font-data w-14 text-right text-foreground/40">—</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
