/**
 * features/onboarding/steps/StartGatewayStep.tsx
 *
 * Gateway startup with health-check animation.
 * Starts the Gateway via SSE, then auto-connects GatewayClient
 * through the same-origin WS proxy.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { ArrowLeft, Check, ChevronDown, Loader2, RotateCcw } from 'lucide-react'
import {
  GatewayClient,
  GatewayResponseError,
  resolveProxyGatewayUrl,
} from '@clawboo/gateway-client'
import { consumeApiSSE } from '@clawboo/control-client'
import { useSystemStore } from '@/stores/system'
import { DevicePairingApproval } from '@/features/connection/DevicePairingApproval'
import { NATIVE_STEPS } from '../StepIndicator'
import { OnboardingGhost, OnboardingPrimary, OnboardingScreen } from '../OnboardingScreen'

// ─── Props ───────────────────────────────────────────────────────────────────

export type StartGatewayStepProps = {
  onStarted: (client: GatewayClient) => void
  onBack: () => void
}

// ─── Status phases ───────────────────────────────────────────────────────────

type Phase = 'starting' | 'connecting' | 'connected' | 'error' | 'pairing-required'

const PHASE_LABELS: Record<Phase, string> = {
  starting: 'Starting Gateway…',
  connecting: 'Connecting…',
  connected: 'Connected!',
  error: 'Something went wrong',
  // 'pairing-required' hides the status label entirely — the
  // DevicePairingApproval card below has its own "Approve this device" header.
  'pairing-required': '',
}

// ─── Component ───────────────────────────────────────────────────────────────

export function StartGatewayStep({ onStarted, onBack }: StartGatewayStepProps) {
  const { gatewayLog, setGatewayControlStatus, appendGatewayLog, clearGatewayLog } =
    useSystemStore()

  const [phase, setPhase] = useState<Phase>('starting')
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [showLog, setShowLog] = useState(false)

  const controllerRef = useRef<AbortController | null>(null)
  const clientRef = useRef<GatewayClient | null>(null)
  const firedRef = useRef(false)
  const logEndRef = useRef<HTMLDivElement>(null)

  // ── Auto-connect after Gateway is reachable ──────────────────────────────
  const autoConnect = useCallback(async () => {
    setPhase('connecting')

    const client = new GatewayClient()
    clientRef.current = client

    try {
      await client.connect(resolveProxyGatewayUrl(), {
        clientName: 'openclaw-control-ui',
        clientVersion: '0.1.0',
        disableDeviceAuth: true,
      })

      setPhase('connected')
      setGatewayControlStatus('running')
      onStarted(client)
    } catch (err) {
      // OpenClaw 2026.5+ rejects unapproved devices with NOT_PAIRED on first
      // connect. Render the in-product approval card inline instead of
      // showing the generic "Something went wrong" error — saves the user
      // from having to refresh the page to escape the wizard. After they
      // click Approve, `onApproved` calls autoConnect() again and the
      // wizard advances to the next step normally.
      if (err instanceof GatewayResponseError && err.code === 'NOT_PAIRED') {
        setPhase('pairing-required')
        clientRef.current = null
        return
      }
      setPhase('error')
      setGatewayControlStatus('error')
      setErrorMessage(err instanceof Error ? err.message : 'Failed to connect to Gateway')
      clientRef.current = null
    }
  }, [onStarted, setGatewayControlStatus])

  // ── Start Gateway via SSE ────────────────────────────────────────────────
  const startGateway = useCallback(() => {
    setPhase('starting')
    setErrorMessage(null)
    setGatewayControlStatus('starting')

    controllerRef.current?.abort()
    controllerRef.current = consumeApiSSE(
      '/api/system/gateway',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'start' }),
      },
      {
        onProgress(event) {
          if (event.message) appendGatewayLog(event.message)
        },
        onOutput(event) {
          if (event.line) appendGatewayLog(event.line)
        },
        onComplete(event) {
          if (event.success) {
            appendGatewayLog('Gateway started, connecting…')
            void autoConnect()
          } else {
            setPhase('error')
            setGatewayControlStatus('error')
            setErrorMessage('Gateway started but reported failure')
          }
        },
        onError(event) {
          setPhase('error')
          setGatewayControlStatus('error')
          setErrorMessage((event.message as string) ?? 'Failed to start Gateway')
        },
      },
    )
  }, [appendGatewayLog, autoConnect, setGatewayControlStatus])

  // ── Mount: auto-start ────────────────────────────────────────────────────
  // No abort-on-cleanup (same rationale as InstallStep): React StrictMode's
  // mount → cleanup → mount double-invoke would abort the gateway-start SSE
  // and the fire-once guard would block the re-fire, stranding the wizard on
  // "Starting Gateway". The spawned gateway is detached (child.unref()) so it
  // keeps running regardless; we just need the SSE stream to survive so its
  // `complete` event fires and advances to the team step. Retry still aborts
  // the prior controller before re-firing.
  useEffect(() => {
    if (firedRef.current) return
    firedRef.current = true
    clearGatewayLog()
    startGateway()
  }, [clearGatewayLog, startGateway])

  // ── Auto-scroll log ──────────────────────────────────────────────────────
  useEffect(() => {
    if (showLog) {
      logEndRef.current?.scrollIntoView({ behavior: 'smooth' })
    }
  }, [gatewayLog.length, showLog])

  // ── Retry handler ────────────────────────────────────────────────────────
  const handleRetry = useCallback(() => {
    clearGatewayLog()
    firedRef.current = false
    startGateway()
  }, [clearGatewayLog, startGateway])

  const isRunning = phase === 'starting' || phase === 'connecting'

  return (
    <OnboardingScreen
      step="runtimes"
      steps={NATIVE_STEPS}
      align="center"
      title="Start the Gateway"
      subtitle="Bringing up the OpenClaw Gateway and connecting Clawboo to it. This runs on its own, no action needed unless something goes wrong."
      footer={
        <div className="flex justify-center">
          {phase === 'error' ? (
            <div className="flex w-full flex-col items-center gap-3">
              <OnboardingPrimary onClick={handleRetry} className="w-full">
                <RotateCcw size={15} strokeWidth={2.5} />
                Retry
              </OnboardingPrimary>
              <OnboardingGhost onClick={onBack}>
                <ArrowLeft size={14} /> Back
              </OnboardingGhost>
            </div>
          ) : (
            <OnboardingGhost onClick={onBack}>
              <ArrowLeft size={14} /> Back
            </OnboardingGhost>
          )}
        </div>
      }
    >
      <div className="flex flex-col items-center">
        {/* ── Pulsing mascot ────────────────────────────────── */}
        <div className="relative">
          {/* Glow */}
          <div className="pointer-events-none absolute -inset-8 bg-[radial-gradient(circle,rgb(var(--primary-rgb) / 0.15),transparent)]" />
          <motion.img
            src="/logo.svg"
            alt="Clawboo"
            className="relative h-20 w-20"
            animate={
              isRunning
                ? {
                    scale: [1, 1.06, 1],
                    opacity: [0.4, 0.7, 0.4],
                  }
                : phase === 'connected' || phase === 'pairing-required'
                  ? { scale: 1, opacity: 1 }
                  : { scale: 1, opacity: 0.3 }
            }
            transition={
              isRunning
                ? {
                    duration: 2.5,
                    repeat: Infinity,
                    ease: 'easeInOut',
                  }
                : { duration: 0.3 }
            }
          />
        </div>

        {/* ── Status text (hidden during pairing — approval card owns its own header) ── */}
        {phase !== 'pairing-required' && (
          <AnimatePresence mode="wait">
            <motion.div
              key={phase}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              transition={{ duration: 0.2 }}
              className="mt-6 flex items-center gap-2"
            >
              {phase === 'connected' && <Check className="h-4 w-4 text-mint" strokeWidth={2.5} />}
              {isRunning && (
                <Loader2 className="h-4 w-4 animate-spin text-accent" strokeWidth={2.5} />
              )}
              <span
                className={[
                  'text-[15px] font-semibold',
                  phase === 'connected'
                    ? 'text-mint'
                    : phase === 'error'
                      ? 'text-destructive'
                      : 'text-text',
                ].join(' ')}
                style={{ fontFamily: 'var(--font-display)' }}
              >
                {PHASE_LABELS[phase]}
              </span>
            </motion.div>
          </AnimatePresence>
        )}

        {/* ── Device pairing approval (OpenClaw 2026.5+ NOT_PAIRED) ── */}
        <AnimatePresence initial={false}>
          {phase === 'pairing-required' && (
            <motion.div
              key="pairing"
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              transition={{ duration: 0.18 }}
              className="mt-6 w-full overflow-hidden text-left"
            >
              <DevicePairingApproval onApproved={() => void autoConnect()} />
            </motion.div>
          )}
        </AnimatePresence>

        {/* ── Log toggle ─────────────────────────────────────── */}
        {gatewayLog.length > 0 && (
          <button
            type="button"
            onClick={() => setShowLog((v) => !v)}
            className="mt-4 flex items-center gap-1 font-mono text-[10px] text-secondary/30 transition hover:text-secondary/60"
          >
            {showLog ? 'Hide' : 'Show'} log
            <ChevronDown
              className={['h-3 w-3 transition-transform', showLog ? 'rotate-180' : ''].join(' ')}
            />
          </button>
        )}

        {/* ── Collapsible log ────────────────────────────────── */}
        <AnimatePresence initial={false}>
          {showLog && gatewayLog.length > 0 && (
            <motion.div
              key="log"
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              transition={{ duration: 0.15 }}
              className="mt-4 w-full overflow-hidden text-left"
            >
              <div
                className="max-h-[180px] overflow-y-auto rounded-xl border border-border p-4"
                style={{ background: 'var(--terminal-bg, #0d1117)' }}
              >
                {gatewayLog.map((line, i) => (
                  <div
                    key={i}
                    className="font-mono text-[12px] leading-relaxed"
                    style={{ color: 'rgb(201 209 217 / 0.72)' }}
                  >
                    {line}
                  </div>
                ))}
                <div ref={logEndRef} />
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* ── Error ──────────────────────────────────────────── */}
        <AnimatePresence initial={false}>
          {phase === 'error' && errorMessage && (
            <motion.div
              key="error"
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              transition={{ duration: 0.15 }}
              className="mt-6 w-full overflow-hidden text-left"
            >
              <div
                role="alert"
                className="rounded-xl border border-destructive/20 bg-destructive/8 px-4 py-3 text-[13px] leading-snug text-destructive"
              >
                {errorMessage}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </OnboardingScreen>
  )
}
