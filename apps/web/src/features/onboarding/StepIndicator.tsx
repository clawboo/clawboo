/**
 * features/onboarding/StepIndicator.tsx
 *
 * 3-dot step indicator for the onboarding wizard.
 * Shows Setup / Team / Deploy progress.
 */

import { Check } from 'lucide-react'

export type IndicatorId = 'setup' | 'team' | 'deploy'

const INDICATOR_STEPS: { id: IndicatorId; label: string }[] = [
  { id: 'setup', label: 'Setup' },
  { id: 'team', label: 'Team' },
  { id: 'deploy', label: 'Deploy' },
]

export function StepIndicator({ current }: { current: IndicatorId }) {
  const currentIdx = INDICATOR_STEPS.findIndex((s) => s.id === current)

  return (
    <div className="flex items-start justify-center gap-0 mb-7">
      {INDICATOR_STEPS.map((s, i) => {
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
                      ? 'bg-accent text-white ring-4 ring-accent/20'
                      : 'bg-white/10 text-secondary/50',
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
            {i < INDICATOR_STEPS.length - 1 && (
              <div
                className={[
                  'h-px w-14 mx-1 mb-5 transition-colors duration-500',
                  done ? 'bg-mint/35' : 'bg-white/8',
                ].join(' ')}
              />
            )}
          </div>
        )
      })}
    </div>
  )
}
