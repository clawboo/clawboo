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
import { GatewayClient, resolveProxyGatewayUrl } from '@clawboo/gateway-client'
import { consumeSSE } from '@/lib/sseClient'
import { useSystemStore } from '@/stores/system'

// ─── Props ───────────────────────────────────────────────────────────────────

export type StartGatewayStepProps = {
  onStarted: (client: GatewayClient) => void
  onBack: () => void
}

// ─── Status phases ───────────────────────────────────────────────────────────

type Phase = 'starting' | 'connecting' | 'connected' | 'error'

const PHASE_LABELS: Record<Phase, string> = {
  starting: 'Starting Gateway…',
  connecting: 'Connecting…',
  connected: 'Connected!',
  error: 'Something went wrong',
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
    controllerRef.current = consumeSSE(
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
            appendGatewayLog('Gateway started — connecting…')
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
  useEffect(() => {
    if (firedRef.current) return
    firedRef.current = true
    clearGatewayLog()
    startGateway()

    return () => {
      controllerRef.current?.abort()
    }
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
    <div className="w-full max-w-[420px] rounded-2xl border border-white/8 bg-surface shadow-[0_32px_80px_rgba(0,0,0,0.65)]">
      <div className="flex flex-col items-center p-8">
        {/* ── Pulsing mascot ────────────────────────────────── */}
        <div className="relative mb-6">
          {/* Glow */}
          <div className="pointer-events-none absolute -inset-8 bg-[radial-gradient(circle,rgba(233,69,96,0.15),transparent)]" />
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
                : phase === 'connected'
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

        {/* ── Status text ───────────────────────────────────── */}
        <AnimatePresence mode="wait">
          <motion.div
            key={phase}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.2 }}
            className="mb-1 flex items-center gap-2"
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

        {/* ── Log toggle ─────────────────────────────────────── */}
        {gatewayLog.length > 0 && (
          <button
            type="button"
            onClick={() => setShowLog((v) => !v)}
            className="mt-2 mb-3 flex items-center gap-1 font-mono text-[10px] text-secondary/30 transition hover:text-secondary/60"
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
              className="mb-4 w-full overflow-hidden"
            >
              <div className="max-h-[180px] overflow-y-auto rounded-lg border border-white/8 bg-[#0d1117] p-3">
                {gatewayLog.map((line, i) => (
                  <div key={i} className="font-mono text-[11px] leading-relaxed text-secondary/60">
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
              className="mb-4 w-full overflow-hidden"
            >
              <div
                role="alert"
                className="rounded-lg border border-destructive/20 bg-destructive/8 px-3 py-2 text-[12px] leading-snug text-destructive"
              >
                {errorMessage}
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* ── Actions ────────────────────────────────────────── */}
        {phase === 'error' && (
          <div className="flex w-full flex-col gap-3">
            <button
              type="button"
              onClick={handleRetry}
              className="flex h-11 w-full items-center justify-center gap-2 rounded-lg bg-accent font-mono text-[13px] font-semibold tracking-wide text-white shadow-sm transition hover:brightness-110 active:scale-[0.98]"
            >
              <RotateCcw className="h-3.5 w-3.5" strokeWidth={2.5} />
              Retry
            </button>
            <button
              type="button"
              onClick={onBack}
              className="flex items-center justify-center gap-1 font-mono text-[11px] text-secondary/35 underline underline-offset-2 transition hover:text-secondary"
            >
              <ArrowLeft className="h-3 w-3" />
              Back
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
