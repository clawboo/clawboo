// Native-first onboarding step: "Add more runtimes" (optional).
//
// By this point the user has already connected the native runtime. This step is
// purely additive — a premium connect LIST (RuntimeConnectList): every runtime
// (the connected native foundation, Claude Code / Codex / Hermes, and OpenClaw)
// is a visible row so it's discoverable at a glance, and each expands in place
// to its connect flow. OpenClaw setup runs IN-PLACE in its row (OpenClawInlineSetup),
// reusing the provider key already entered so it never re-asks. Continue advances
// to the ready landing whether or not anything was connected — nothing here can
// strand the user (the native team exists), so there is a single forward action.

import { useCallback, useEffect, useState } from 'react'
import { ArrowLeft, ArrowRight } from 'lucide-react'

import type { GatewayClient } from '@clawboo/gateway-client'

import { NATIVE_STEPS } from '../StepIndicator'
import { OnboardingGhost, OnboardingPrimary, OnboardingScreen } from '../OnboardingScreen'
import { RuntimeConnectList } from '@/features/runtimes/RuntimeConnectList'
import { OpenClawInlineSetup } from '@/features/runtimes/OpenClawInlineSetup'
import { RUNTIME_ORDER, type RuntimeId } from '@/features/runtimes/runtimeCatalog'
import { fetchRuntimes, type RuntimeStatus } from '@clawboo/control-client'

// Native has its own primary onboarding path (configureNative), so it isn't a
// connectable row here — the rows are the wrapped CLI runtimes (+ OpenClaw),
// with native shown as the already-connected foundation.
const CODING_RUNTIMES: RuntimeId[] = RUNTIME_ORDER.filter((id) => id !== 'clawboo-native')

export interface AddRuntimesStepProps {
  /** Finish — advance to the ready landing (works with or without connections). */
  onContinue: () => void
  /** Back to the provider-connect step (the ONE place a key is added — the
   *  runtime rows here only show what is already connected). */
  onBack: () => void
  /** The inline OpenClaw setup connected a live Gateway client — the wizard tracks
   *  it (staying in the wizard; NOT the global enterGatewayMode). */
  onOpenClawConnected: (client: GatewayClient, gatewayUrl: string) => void
  /** True once the OpenClaw Gateway is connected (a live client in the wizard). */
  openClawConnected: boolean
}

export function AddRuntimesStep({
  onContinue,
  onBack,
  onOpenClawConnected,
  openClawConnected,
}: AddRuntimesStepProps) {
  const [statuses, setStatuses] = useState<RuntimeStatus[]>([])
  const [loaded, setLoaded] = useState(false)
  const [setupOpen, setSetupOpen] = useState(false)

  const refresh = useCallback(async () => {
    setStatuses(await fetchRuntimes())
    setLoaded(true)
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
      subtitle="Optional. Connect any of these to work alongside your native team, or continue and add them anytime from Settings → Runtimes."
      footer={
        <div className="flex items-center justify-between">
          <OnboardingGhost testId="addruntimes-back" onClick={onBack}>
            <ArrowLeft size={15} /> Back
          </OnboardingGhost>
          <OnboardingPrimary testId="addruntimes-continue" onClick={onContinue}>
            Continue <ArrowRight size={16} />
          </OnboardingPrimary>
        </div>
      }
    >
      <RuntimeConnectList
        runtimeIds={CODING_RUNTIMES}
        statuses={statuses}
        loaded={loaded}
        onChanged={refresh}
        openclaw={{
          connected: openClawConnected,
          statusLabel: openClawConnected ? 'Connected' : 'Not set up',
          onSetup: () => setSetupOpen(true),
          setupTestId: 'addruntimes-setup-openclaw',
          setupOpen,
          setupContent: (
            <OpenClawInlineSetup
              onConnected={onOpenClawConnected}
              onFinish={() => setSetupOpen(false)}
              onCancel={() => setSetupOpen(false)}
            />
          ),
        }}
      />
    </OnboardingScreen>
  )
}
