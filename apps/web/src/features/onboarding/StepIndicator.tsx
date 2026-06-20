/**
 * features/onboarding/StepIndicator.tsx
 *
 * Step-progress indicator for the onboarding wizard. The OpenClaw path runs the
 * default Setup / Team / Deploy beats; the native path is a shorter
 * Connect / Ready flow (it seeds a team server-side and lands directly), so it
 * passes `steps={NATIVE_STEPS}` to avoid promising Team/Deploy beats it never
 * reaches.
 */

import { Check } from 'lucide-react'

export type IndicatorId = 'setup' | 'team' | 'deploy' | 'connect' | 'ready'

export type IndicatorStep = { id: IndicatorId; label: string }

const DEFAULT_STEPS: IndicatorStep[] = [
  { id: 'setup', label: 'Setup' },
  { id: 'team', label: 'Team' },
  { id: 'deploy', label: 'Deploy' },
]

/** The native path's 2-beat flow (paste a key → land in the dashboard). */
export const NATIVE_STEPS: IndicatorStep[] = [
  { id: 'connect', label: 'Connect' },
  { id: 'ready', label: 'Ready' },
]

export function StepIndicator({
  current,
  steps = DEFAULT_STEPS,
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
