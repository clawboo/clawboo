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

import { Button } from '@/features/shared/Button'
import { FormattedAlert } from '@/features/shared/FormattedAlert'
import { StatusPill } from '@/features/shared/StatusPill'
import { ENTER_SPRING, listDelay } from '@/lib/motion'
import { runSmokeEvals, type SuiteReport } from '@/lib/evalsClient'

function pct(v: number): string {
  return `${Math.round(v * 100)}%`
}

function passTone(v: number): string {
  return v >= 1 ? 'var(--mint)' : v > 0 ? 'var(--amber)' : 'var(--primary)'
}

const KICKER = 'mb-1.5 font-mono text-[11px] font-semibold uppercase tracking-[0.14em]'
const KICKER_COLOR = 'rgb(var(--foreground-rgb) / 0.45)'

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
      <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-foreground/45">
        {label}
      </span>
      <span
        className="font-data text-[15px] font-semibold text-foreground"
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
      className="flex flex-col gap-3 rounded-2xl border border-border bg-surface p-5"
      style={{ boxShadow: 'var(--shadow-raised)' }}
    >
      {/* Header + run button */}
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <span className="flex items-center gap-2.5">
          <span
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl"
            style={{ background: 'rgb(var(--mint-rgb) / 0.12)', color: 'var(--mint)' }}
          >
            <FlaskConical size={16} strokeWidth={2} />
          </span>
          <span
            className="whitespace-nowrap font-display font-bold text-foreground"
            style={{ fontSize: 15, letterSpacing: '-0.01em' }}
          >
            Eval scorecard
          </span>
        </span>
        <Button
          variant="primary"
          size="sm"
          data-testid="obs-run-smoke-evals"
          className="eval-run-btn shrink-0"
          onClick={() => void run()}
          disabled={running}
          loading={running}
        >
          {!running && <Play size={13} strokeWidth={2} />}
          {running ? 'Running…' : 'Run smoke evals'}
        </Button>
      </div>

      <div className="text-[13px] leading-relaxed text-foreground/55">
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
          className="flex flex-col gap-3 rounded-xl border border-border bg-foreground/[0.02] p-4"
        >
          <div className="flex flex-wrap gap-5">
            <Metric label="pass@1" value={pct(report.passAt1)} tone={passTone(report.passAt1)} />
            <Metric label="pass^k" value={pct(report.passPowK)} tone={passTone(report.passPowK)} />
            <Metric label="k" value={String(report.k)} />
            <Metric label="tasks" value={String(report.tasks.length)} />
          </div>
          <div className="-mx-1 overflow-x-auto px-1">
            <div className="flex min-w-[320px] flex-col">
              <div className="flex gap-2.5 border-b border-border pb-1.5 font-mono text-[10px] uppercase tracking-[0.14em] text-foreground/45">
                <span className="min-w-0 flex-[2]">task</span>
                <span className="min-w-0 flex-1">suite</span>
                <span className="min-w-0 flex-1">kind</span>
                <span className="w-12 shrink-0 text-right">pass@1</span>
                <span className="w-12 shrink-0 text-right">score</span>
              </div>
              {report.tasks.map((t, i) => (
                <motion.div
                  key={t.taskId}
                  data-testid="eval-task-row"
                  initial={{ opacity: 0, y: 4 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ ...ENTER_SPRING, delay: listDelay(i) }}
                  className="flex items-center gap-2.5 border-b border-border py-1.5 text-[12px] text-foreground/70 last:border-0 hover:bg-foreground/[0.02]"
                >
                  <span className="font-data min-w-0 flex-[2] truncate">{t.taskId}</span>
                  <span className="min-w-0 flex-1 truncate text-foreground/50">{t.suite}</span>
                  <span className="min-w-0 flex-1 truncate text-foreground/50">{t.kind}</span>
                  <span
                    className="font-data w-12 shrink-0 text-right font-semibold"
                    style={{ color: passTone(t.passAt1) }}
                  >
                    {pct(t.passAt1)}
                  </span>
                  <span className="font-data w-12 shrink-0 text-right text-foreground/55">
                    {t.meanScore.toFixed(2)}
                  </span>
                </motion.div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Ablation — the real scorecard SHAPE, explained (runs in CI, not on demand) */}
      <div
        data-testid="ablation-scorecard"
        className="flex flex-col gap-3 rounded-xl border border-border bg-foreground/[0.02] p-4"
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

        {/* Variant rows — the shape; numbers fill in from the CI run.
            Wrapped in overflow-x-auto with a min-width + column gaps so the
            headers keep clear separation (never collide) in a narrow pane. */}
        <div className="-mx-1 overflow-x-auto px-1">
          <div className="flex min-w-[300px] flex-col">
            <div className="flex gap-2.5 border-b border-border pb-1.5 font-mono text-[10px] uppercase tracking-[0.14em] text-foreground/45">
              <span className="min-w-0 flex-1">variant</span>
              <span className="w-16 shrink-0 text-center">verify</span>
              <span className="w-20 shrink-0 text-center">structured</span>
              <span className="w-12 shrink-0 text-right">pass@1</span>
              <span className="w-12 shrink-0 text-right">pass^k</span>
            </div>
            {ABLATION_VARIANTS.map((v) => (
              <div
                key={v.variant}
                data-testid="ablation-variant-row"
                className="flex items-center gap-2.5 border-b border-border py-1.5 text-[12px] text-foreground/70 last:border-0"
              >
                <span className="font-data min-w-0 flex-1 truncate">{v.variant}</span>
                <span className="flex w-16 shrink-0 justify-center">
                  <AblationFlag on={v.verify} />
                </span>
                <span className="flex w-20 shrink-0 justify-center">
                  <AblationFlag on={v.structured} />
                </span>
                <span className="font-data w-12 shrink-0 text-right text-foreground/40">—</span>
                <span className="font-data w-12 shrink-0 text-right text-foreground/40">—</span>
              </div>
            ))}
          </div>
        </div>

        {/* Marginal contributions (Δ pass@1) — verifier / structured-state. */}
        <div className="flex flex-col">
          <span className="mb-1 font-mono text-[10px] uppercase tracking-[0.14em] text-foreground/45">
            marginal contribution (Δ pass@1)
          </span>
          {ABLATION_CONTRIBUTIONS.map((c) => (
            <div
              key={c}
              data-testid="ablation-contribution-row"
              className="flex items-center border-b border-border py-1.5 text-[12px] text-foreground/70 last:border-0"
            >
              <span className="font-data flex-1">{c}</span>
              <span className="font-data w-14 text-right text-foreground/40">—</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
