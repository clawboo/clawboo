// Optional onboarding step: connect non-OpenClaw coding-agent runtimes
// (Claude Code / Codex / Hermes). Skippable + additive — OpenClaw is already set
// up by this point; these are extra executor runtimes the team can use. Reuses
// the shared RuntimeConnectionCard (same card the Runtimes panel uses), so a
// runtime connected here shows up enabled in Runtimes later.

import { useCallback, useEffect, useState } from 'react'
import { ArrowRight, X } from 'lucide-react'

import { StepIndicator } from '../StepIndicator'
import { RuntimeConnectionCard } from '@/features/runtimes/RuntimeConnectionCard'
import { RUNTIME_CATALOG, RUNTIME_ORDER, type RuntimeId } from '@/features/runtimes/runtimeCatalog'
import { fetchRuntimes, type RuntimeStatus } from '@/lib/runtimesClient'

// The "connect coding agents" step covers the wrapped CLI runtimes — Native has
// its own primary onboarding path (configureNative), so it isn't listed here.
const CODING_RUNTIMES: RuntimeId[] = RUNTIME_ORDER.filter((id) => id !== 'clawboo-native')

export interface ConnectAgentsStepProps {
  /** Advance to team setup (Continue). */
  onContinue: () => void
  /** Advance to team setup, skipping runtime connection. */
  onSkip: () => void
  /** Runtime the user picked on chooseRuntime — its card gets a focus ring. */
  focusRuntime?: string | null
  /**
   * True on the OpenClaw continuation (a live Gateway client exists → this step
   * leads into team → deploy). False on a coding-agent first choice, where this
   * step is TERMINAL (Continue/Skip completes onboarding). Gates the 3-beat
   * Setup/Team/Deploy indicator so the terminal path doesn't promise beats it
   * never reaches.
   */
  continuesToTeam?: boolean
}

export function ConnectAgentsStep({
  onContinue,
  onSkip,
  focusRuntime,
  continuesToTeam = false,
}: ConnectAgentsStepProps) {
  const [statuses, setStatuses] = useState<RuntimeStatus[]>([])

  const refresh = useCallback(async () => {
    setStatuses(await fetchRuntimes())
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  return (
    <div
      data-testid="connect-agents-step"
      className="surface-overlay-tier w-full max-w-3xl rounded-2xl p-8"
    >
      <div className="flex flex-col items-center">
        {/* Only the OpenClaw continuation goes on to Team/Deploy — on the
            terminal coding-agent path the 3-beat indicator is omitted. */}
        {continuesToTeam && <StepIndicator current="setup" />}
        <h2
          className="mt-6 font-display text-[22px] font-semibold"
          style={{ color: 'var(--foreground)', letterSpacing: '-0.01em' }}
        >
          Connect coding agents
        </h2>
        <p
          className="mt-1.5 text-center text-[12px] leading-relaxed"
          style={{ color: 'rgb(var(--foreground-rgb) / 0.55)', maxWidth: 460 }}
        >
          Optional — add Claude Code, Codex, or Hermes as executor runtimes. You can always manage
          these later in Runtimes.
        </p>
      </div>

      <div className="mt-6 grid gap-3 sm:grid-cols-3">
        {CODING_RUNTIMES.map((id) => {
          const entry = RUNTIME_CATALOG[id]
          const status = statuses.find((s) => s.id === id)
          const focused = focusRuntime === id
          return (
            <div
              key={id}
              data-focused={focused ? 'true' : undefined}
              className="rounded-xl transition-shadow"
              style={
                focused ? { boxShadow: '0 0 0 2px var(--primary)', borderRadius: 12 } : undefined
              }
            >
              <RuntimeConnectionCard
                entry={entry}
                status={status}
                variant="onboarding"
                onChanged={() => void refresh()}
              />
            </div>
          )
        })}
      </div>

      <div className="mt-6 flex items-center justify-between">
        <button
          type="button"
          data-testid="connect-agents-skip"
          onClick={onSkip}
          className="flex items-center gap-1 text-[12px] underline-offset-4 hover:underline"
          style={{
            color: 'rgb(var(--foreground-rgb) / 0.5)',
            background: 'transparent',
            border: 'none',
            cursor: 'pointer',
          }}
        >
          <X size={13} /> Skip for now
        </button>
        <button
          type="button"
          data-testid="connect-agents-continue"
          onClick={onContinue}
          className="inline-flex items-center gap-1.5 rounded-lg px-4 py-2 text-[13px] font-semibold active:scale-[0.98]"
          style={{ background: 'var(--primary)', color: 'var(--primary-foreground)' }}
        >
          Continue <ArrowRight size={14} />
        </button>
      </div>
    </div>
  )
}
