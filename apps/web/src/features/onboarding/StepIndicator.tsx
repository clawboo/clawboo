/**
 * features/onboarding/StepIndicator.tsx
 *
 * Step-progress indicator for the native-first onboarding wizard. The spine is
 * a 4-beat flow — Connect (paste a provider key) → Runtimes (optionally add
 * OpenClaw / coding-agent runtimes so they're available to assign to the team)
 * → Team (pick + deploy a real team from the marketplace) → Ready. The OpenClaw
 * setup detour (Detect / Install / Configure / Start Gateway / Connect) is a
 * drill-in of the Runtimes beat, so those steps render `current="runtimes"`.
 */

import { Check } from 'lucide-react'

export type IndicatorId = 'connect' | 'runtimes' | 'team' | 'ready'

export type IndicatorStep = { id: IndicatorId; label: string }

/** The native-first spine: paste a key → add runtimes (opt-in) → pick + deploy a
 *  team → land. Runtimes come BEFORE team so a connected runtime can be assigned
 *  to a team agent. */
export const NATIVE_STEPS: IndicatorStep[] = [
  { id: 'connect', label: 'Connect' },
  { id: 'runtimes', label: 'Runtimes' },
  { id: 'team', label: 'Team' },
  { id: 'ready', label: 'Ready' },
]

/**
 * Minimal bottom step indicator — small dots, with the active step rendered as
 * an elongated brand pill (the premium onboarding pattern). Used by
 * `OnboardingScreen`; the labeled circle `StepIndicator` below is retained for
 * the OpenClaw detour steps until they migrate.
 */
export function StepDots({
  current,
  steps = NATIVE_STEPS,
  className = '',
}: {
  current: IndicatorId
  steps?: IndicatorStep[]
  className?: string
}) {
  const currentIdx = steps.findIndex((s) => s.id === current)

  return (
    <div
      className={['flex items-center justify-center gap-2', className].join(' ')}
      role="progressbar"
      aria-valuenow={currentIdx + 1}
      aria-valuemin={1}
      aria-valuemax={steps.length}
      aria-label={`Step ${currentIdx + 1} of ${steps.length}: ${steps[currentIdx]?.label ?? ''}`}
    >
      {steps.map((s, i) => {
        const active = i === currentIdx
        const done = i < currentIdx
        return (
          <span
            key={s.id}
            className="h-1.5 rounded-full transition-all duration-300"
            style={{
              width: active ? 26 : 6,
              background: active
                ? 'var(--primary)'
                : done
                  ? 'rgb(var(--primary-rgb) / 0.4)'
                  : 'rgb(var(--foreground-rgb) / 0.14)',
            }}
          />
        )
      })}
    </div>
  )
}

export function StepIndicator({
  current,
  steps = NATIVE_STEPS,
}: {
  current: IndicatorId
  steps?: IndicatorStep[]
}) {
  const currentIdx = steps.findIndex((s) => s.id === current)

  return (
    <div className="flex items-start justify-center gap-0 mb-7">
      {steps.map((s, i) => {
        const done = i < currentIdx
        const active = i === currentIdx

        return (
          <div key={s.id} className="flex items-center">
            <div className="flex flex-col items-center gap-1.5">
              <div
                className={[
                  'h-6 w-6 rounded-full flex items-center justify-center text-[10px] font-bold transition-all duration-300',
                  done
                    ? 'bg-mint text-background'
                    : active
                      ? 'bg-accent text-primary-foreground ring-4 ring-accent/20'
                      : 'bg-foreground/10 text-secondary/50',
                ].join(' ')}
              >
                {done ? <Check className="h-3.5 w-3.5" strokeWidth={2.5} /> : i + 1}
              </div>
              <span
                className={[
                  'text-[9px] font-mono uppercase tracking-wider transition-colors duration-300',
                  active ? 'text-accent' : done ? 'text-mint' : 'text-secondary/30',
                ].join(' ')}
              >
                {s.label}
              </span>
            </div>
            {i < steps.length - 1 && (
              <div
                className={[
                  'mx-1 mb-5 h-0.5 w-14 rounded-full transition-colors duration-500',
                  done ? 'bg-mint/45' : 'bg-foreground/[0.1]',
                ].join(' ')}
              />
            )}
          </div>
        )
      })}
    </div>
  )
}
