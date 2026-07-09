// Native-first onboarding step: "Add more runtimes" (optional, skippable).
//
// By this point the user has already seeded a working native team (the previous
// step). This step is purely additive — connect Claude Code / Codex / Hermes as
// executor runtimes, or set up OpenClaw via the advanced detour. Both Continue
// and "Skip for now" advance to the ready landing; nothing here can strand the
// user (the native team already exists). Reuses the shared RuntimeConnectionCard
// so a runtime connected here shows up enabled in the Runtimes panel later.

import { useCallback, useEffect, useState } from 'react'
import { ArrowRight, Server, X } from 'lucide-react'

import { NATIVE_STEPS } from '../StepIndicator'
import { OnboardingGhost, OnboardingPrimary, OnboardingScreen } from '../OnboardingScreen'
import { RuntimeConnectionCard } from '@/features/runtimes/RuntimeConnectionCard'
import { RUNTIME_CATALOG, RUNTIME_ORDER, type RuntimeId } from '@/features/runtimes/runtimeCatalog'
import { fetchRuntimes, type RuntimeStatus } from '@clawboo/control-client'
import { GlossTerm } from '@/features/shared/GlossTerm'
import { StatusPill } from '@/features/shared/StatusPill'

const muted = (o: number) => `rgb(var(--foreground-rgb) / ${o})`

// Native has its own primary onboarding path (configureNative), so it isn't
// listed here — this grid is the wrapped CLI runtimes only.
const CODING_RUNTIMES: RuntimeId[] = RUNTIME_ORDER.filter((id) => id !== 'clawboo-native')

export interface AddRuntimesStepProps {
  /** Finish (Continue) — advance to the ready landing. */
  onContinue: () => void
  /** Finish without connecting anything — advance to the ready landing. */
  onSkip: () => void
  /** Enter the OpenClaw setup detour (detect → … → start gateway, returns here). */
  onSetupOpenClaw: () => void
  /** True once the OpenClaw Gateway was connected via the detour. */
  openClawConnected: boolean
}

export function AddRuntimesStep({
  onContinue,
  onSkip,
  onSetupOpenClaw,
  openClawConnected,
}: AddRuntimesStepProps) {
  const [statuses, setStatuses] = useState<RuntimeStatus[]>([])

  const refresh = useCallback(async () => {
    setStatuses(await fetchRuntimes())
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  return (
    <OnboardingScreen
      testId="add-runtimes-step"
      step="runtimes"
      steps={NATIVE_STEPS}
      size="lg"
      title="Add more runtimes"
      subtitle="Optional — connect Claude Code, Codex, Hermes, or OpenClaw as peers alongside your native team. You can always do this later from the Runtimes panel."
      footer={
        <div className="flex items-center justify-between">
          <OnboardingGhost testId="addruntimes-skip" onClick={onSkip}>
            <X size={15} /> Skip for now
          </OnboardingGhost>
          <OnboardingPrimary testId="addruntimes-continue" onClick={onContinue}>
            Continue <ArrowRight size={16} />
          </OnboardingPrimary>
        </div>
      }
    >
      <div className="grid gap-4 sm:grid-cols-3">
        {CODING_RUNTIMES.map((id) => (
          <RuntimeConnectionCard
            key={id}
            entry={RUNTIME_CATALOG[id]}
            status={statuses.find((s) => s.id === id)}
            variant="onboarding"
            onChanged={() => void refresh()}
          />
        ))}
      </div>

      {/* OpenClaw — the Gateway. Not a RuntimeConnectionCard runtime, so an
          inline row: a Connected pill once the detour succeeded, else a button
          into the advanced OpenClaw setup detour (which returns here). */}
      <div
        className="mt-4 flex items-center gap-4 rounded-2xl border border-border bg-surface p-4"
        style={{ boxShadow: 'var(--shadow-raised)' }}
      >
        <span
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl"
          style={{ background: 'rgb(var(--primary-rgb) / 0.12)', color: 'var(--primary)' }}
        >
          <Server size={20} />
        </span>
        <div className="min-w-0 flex-1">
          <span className="text-[15px] font-semibold" style={{ color: 'var(--foreground)' }}>
            OpenClaw
          </span>
          <p className="mt-0.5 text-[12.5px] leading-relaxed" style={{ color: muted(0.5) }}>
            Pro setup — runs a local OpenClaw{' '}
            <GlossTerm
              term="Gateway"
              definition="The local OpenClaw server that runs and coordinates OpenClaw agents. Clawboo talks to it over a same-origin WebSocket proxy."
            >
              Gateway
            </GlossTerm>
            .
          </p>
        </div>
        {openClawConnected ? (
          <StatusPill tone="success" label="Connected" />
        ) : (
          <button
            type="button"
            data-testid="addruntimes-setup-openclaw"
            onClick={onSetupOpenClaw}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-lg px-3.5 py-2 text-[13px] font-semibold transition-[filter,transform] duration-150 hover:brightness-[0.97] active:scale-[0.98]"
            style={{
              background: 'rgb(var(--primary-rgb) / 0.12)',
              color: 'var(--primary)',
              cursor: 'pointer',
            }}
          >
            Set up OpenClaw <ArrowRight size={14} />
          </button>
        )}
      </div>
    </OnboardingScreen>
  )
}
