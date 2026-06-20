// The first real onboarding choice: "How do you want your agents to run?"
//
// Clawboo Native is the prominent, recommended card (paste a key, ~60s, no
// install). OpenClaw / Claude Code / Hermes / Codex are clearly-secondary
// affordances. The four runtime cards reuse the shared RuntimeConnectionCard in
// its wizard-pick variants; OpenClaw is rendered inline (it is the Gateway, not
// a RuntimeConnectionCard runtime). Picking a card sets the selected runtime and
// advances the wizard to the right next step.

import { useCallback, useRef } from 'react'
import { ArrowRight, Server } from 'lucide-react'

import { StepIndicator } from '../StepIndicator'
import { RuntimeConnectionCard } from '@/features/runtimes/RuntimeConnectionCard'
import { RUNTIME_CATALOG, type RuntimeId } from '@/features/runtimes/runtimeCatalog'
import type { WizardRuntime } from '@/lib/onboardingProgress'

const muted = (o: number) => `rgb(var(--foreground-rgb) / ${o})`

// Native card copy is wizard-specific (the ~60s promise + the shared-memory
// line). The Recommended pill is rendered by the card's wizard-primary variant.
const NATIVE_ENTRY = {
  ...RUNTIME_CATALOG['clawboo-native'],
  blurb:
    'Paste an API key and your team is ready in ~60 seconds. No extra install. ' +
    'Your agents share one memory.',
}

// The secondary coding-agent runtimes, in tab order after OpenClaw. These are
// RuntimeCatalog ids (a subset of WizardRuntime — no 'openclaw').
const SECONDARY_RUNTIMES: RuntimeId[] = ['claude-code', 'hermes', 'codex']

export interface ChooseRuntimeStepProps {
  /** Fired with the picked runtime; the wizard advances to the right step. */
  onPick: (runtime: WizardRuntime) => void
}

export function ChooseRuntimeStep({ onPick }: ChooseRuntimeStepProps) {
  const gridRef = useRef<HTMLDivElement | null>(null)

  // Arrow-key nav within the card group (tab + focus-visible handle the rest).
  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    const root = gridRef.current
    if (!root) return
    const cards = Array.from(
      root.querySelectorAll<HTMLButtonElement>('button[data-testid^="runtime-pick-"]'),
    )
    const idx = cards.findIndex((c) => c === document.activeElement)
    if (idx === -1) return
    e.preventDefault()
    const next = e.key === 'ArrowDown' ? idx + 1 : idx - 1
    cards[(next + cards.length) % cards.length]?.focus()
  }, [])

  return (
    <div
      data-testid="choose-runtime-step"
      className="surface-overlay-tier w-full max-w-[560px] rounded-2xl p-8"
    >
      <div className="flex flex-col items-center">
        <StepIndicator current="setup" />
        <h2
          className="mt-6 font-display text-[22px] font-semibold"
          style={{ color: 'var(--foreground)', letterSpacing: '-0.01em' }}
        >
          How do you want your agents to run?
        </h2>
        <p
          className="mt-1.5 text-center text-[12px] leading-relaxed"
          style={{ color: muted(0.55), maxWidth: 440 }}
        >
          Pick a runtime to get started. You can add or switch runtimes anytime from the Runtimes
          panel.
        </p>
      </div>

      <div ref={gridRef} className="mt-7 flex flex-col gap-2.5" onKeyDown={handleKeyDown}>
        {/* Primary — Clawboo Native */}
        <RuntimeConnectionCard
          entry={NATIVE_ENTRY}
          variant="wizard-primary"
          onPick={() => onPick('clawboo-native')}
        />

        {/* Divider */}
        <div className="my-1 flex items-center gap-3">
          <span className="h-px flex-1" style={{ background: muted(0.1) }} />
          <span
            className="font-mono text-[10px] uppercase tracking-widest"
            style={{ color: muted(0.4) }}
          >
            Or bring your own runtime
          </span>
          <span className="h-px flex-1" style={{ background: muted(0.1) }} />
        </div>

        {/* OpenClaw — the Gateway. Not a RuntimeConnectionCard runtime, so an
            inline card matching the wizard-secondary visual. */}
        <button
          type="button"
          data-testid="runtime-pick-openclaw"
          aria-label="Choose OpenClaw"
          onClick={() => onPick('openclaw')}
          className="surface-raised-tier group relative flex w-full items-center gap-3 rounded-xl p-3.5 text-left transition-[transform,filter] hover:-translate-y-px active:scale-[0.98] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
          style={{ outlineColor: 'var(--primary)', opacity: 0.92, cursor: 'pointer' }}
        >
          <span
            className="flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-lg"
            style={{ background: 'rgb(var(--primary-rgb) / 0.14)', color: 'var(--primary)' }}
          >
            <Server size={18} />
          </span>
          <div className="min-w-0 flex-1">
            <span className="font-semibold" style={{ color: 'var(--foreground)', fontSize: 13.5 }}>
              OpenClaw
            </span>
            <p className="mt-0.5 leading-relaxed" style={{ color: muted(0.5), fontSize: 11 }}>
              Pro setup — runs a local OpenClaw Gateway.
            </p>
          </div>
          <ArrowRight
            size={15}
            className="shrink-0 transition-transform group-hover:translate-x-0.5"
            style={{ color: muted(0.35) }}
          />
        </button>

        {/* Coding-agent runtimes */}
        {SECONDARY_RUNTIMES.map((id) => (
          <RuntimeConnectionCard
            key={id}
            entry={RUNTIME_CATALOG[id]}
            variant="wizard-secondary"
            onPick={() => onPick(id)}
          />
        ))}
      </div>
    </div>
  )
}
