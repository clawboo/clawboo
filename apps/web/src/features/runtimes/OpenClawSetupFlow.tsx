/**
 * apps/web/src/features/runtimes/OpenClawSetupFlow.tsx
 *
 * Standalone OpenClaw setup, launched from the Runtimes dashboard — the "add it
 * later" surface for a native-first user who skipped OpenClaw at onboarding.
 *
 * It owns the SAME mini state machine the onboarding wizard's OpenClaw detour
 * uses (detect → install → configure → startGateway) and reuses the four step
 * components VERBATIM. The only difference from the wizard: instead of deferring
 * the surface+hydrate to `onComplete`, the moment a client is connected the host
 * calls `enterGatewayMode` (surface the client to the connection store + hydrate
 * fleet/teams) and closes — the user stays on the Runtimes view and the OpenClaw
 * row flips "Healthy" reactively off the store status.
 *
 * `StartGatewayStep` handles NOT_PAIRED device pairing inline (its own
 * DevicePairingApproval), so the host needs no extra pairing handling.
 *
 * Note: the host does NOT reuse the wizard's inline ConnectStep (a remote-gateway
 * connect form) — it's wizard-private/unexported. Remote-gateway connect from the
 * dashboard is deferred; `onAdvancedConnect` routes to `startGateway` (which
 * starts + connects a local gateway and handles pairing).
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { motion } from 'framer-motion'
import { X } from 'lucide-react'
import type { GatewayClient } from '@clawboo/gateway-client'
import { DetectStep, InstallStep, ConfigureStep, StartGatewayStep } from '@/features/onboarding/steps'
import { connectGatewayFromSettings } from '@/lib/gatewayConnect'
import { enterGatewayMode } from '@/features/connection/GatewayBootstrap'

export type OpenClawSetupFlowProps = {
  /** Close the modal (also called on the resolved happy path). */
  onClose: () => void
}

type SetupStep = 'detect' | 'install' | 'configure' | 'startGateway'

const DEFAULT_GATEWAY_URL = 'ws://localhost:18789'

export function OpenClawSetupFlow({ onClose }: OpenClawSetupFlowProps) {
  const [step, setStep] = useState<SetupStep>('detect')
  // Gateway URL captured from ConfigureStep — passed to enterGatewayMode when
  // StartGatewayStep completes (falls back to the local default when the
  // configure step wasn't visited, e.g. reached via onNeedGateway).
  const [configuredUrl, setConfiguredUrl] = useState('')
  // DetectStep fires onAllGood from BOTH its 1.5s auto-advance AND the Continue
  // CTA; the handler does a real WS connect, so guard against a double-connect.
  const allGoodInFlight = useRef(false)

  // Escape closes. Scoped (stopPropagation) so it doesn't bubble to any
  // dashboard-level keyboard shortcut behind the modal.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // DetectStep: everything is green → connect via saved settings + finalize.
  const handleAllGood = useCallback(async () => {
    if (allGoodInFlight.current) return
    allGoodInFlight.current = true
    try {
      const { client, gatewayUrl } = await connectGatewayFromSettings()
      await enterGatewayMode(client, gatewayUrl)
      onClose()
    } catch {
      // Read green but couldn't connect (transient, or NOT_PAIRED). Route to
      // StartGatewayStep — it re-starts (idempotent when already running) and
      // handles device pairing inline, landing the user where it's solvable.
      allGoodInFlight.current = false
      setStep('startGateway')
    }
  }, [onClose])

  // StartGatewayStep completed — the client is live. Surface + hydrate, then close.
  const handleStarted = useCallback(
    async (client: GatewayClient) => {
      await enterGatewayMode(client, configuredUrl || DEFAULT_GATEWAY_URL)
      onClose()
    },
    [configuredUrl, onClose],
  )

  // Portalled to <body> so this fixed overlay resolves against the viewport
  // and layers above the Settings modal (z-70) when reached from the modal's
  // Runtimes pane, instead of being clipped inside the modal's glass container.
  return createPortal(
    <motion.div
      role="dialog"
      aria-modal="true"
      aria-label="Set up OpenClaw"
      data-testid="openclaw-setup-flow"
      className="fixed inset-0 z-[80] flex items-center justify-center overflow-y-auto px-4 py-8"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.2 }}
    >
      {/* Scrim — dims the dashboard behind; click to close. */}
      <div
        className="absolute inset-0 bg-[var(--overlay-scrim)] backdrop-blur-sm"
        onClick={onClose}
        aria-hidden
      />

      {/* Close affordance. */}
      <button
        type="button"
        onClick={onClose}
        aria-label="Close OpenClaw setup"
        data-testid="openclaw-setup-close"
        className="absolute right-4 top-4 z-20 rounded-md p-1.5 text-secondary/60 transition-colors hover:bg-foreground/[0.06] hover:text-text"
      >
        <X size={18} />
      </button>

      {/* Current step. A keyed motion.div plays an enter fade on each step swap.
          Deliberately NOT wrapped in a nested `AnimatePresence` — this modal lives
          inside ContentArea's own `mode="wait"`, where a nested `AnimatePresence
          mode="wait"` deadlocks the exit cycle (see CLAUDE.md GroupChatView note).
          A keyed enter-only fade needs no AnimatePresence. */}
      <div className="relative z-10 flex w-full justify-center">
        <motion.div
          key={step}
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.2 }}
          className="flex w-full justify-center"
        >
          {step === 'detect' && (
            <DetectStep
              onAllGood={() => void handleAllGood()}
              onNeedInstall={() => setStep('install')}
              onNeedConfigure={() => setStep('configure')}
              onNeedGateway={() => setStep('startGateway')}
              onAdvancedConnect={() => setStep('startGateway')}
            />
          )}
          {step === 'install' && (
            <InstallStep onInstalled={() => setStep('configure')} onBack={() => setStep('detect')} />
          )}
          {step === 'configure' && (
            <ConfigureStep
              onConfigured={({ gatewayUrl }) => {
                setConfiguredUrl(gatewayUrl)
                setStep('startGateway')
              }}
              onBack={() => setStep('detect')}
            />
          )}
          {step === 'startGateway' && (
            <StartGatewayStep
              onStarted={(client) => void handleStarted(client)}
              onBack={() => setStep('configure')}
            />
          )}
        </motion.div>
      </div>
    </motion.div>,
    document.body,
  )
}
