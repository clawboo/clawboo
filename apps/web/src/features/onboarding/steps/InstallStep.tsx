/**
 * features/onboarding/steps/InstallStep.tsx
 *
 * Installation progress with terminal output.
 * Streams `npm install -g openclaw@latest` via SSE and
 * handles EACCES permission errors with fix instructions.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { ArrowLeft, Check, ChevronDown, Loader2, RotateCcw } from 'lucide-react'
import { consumeApiSSE } from '@clawboo/control-client'
import { useSystemStore } from '@/stores/system'
import { NATIVE_STEPS } from '../StepIndicator'
import { OnboardingGhost, OnboardingPrimary, OnboardingScreen } from '../OnboardingScreen'

// ─── Props ───────────────────────────────────────────────────────────────────

export type InstallStepProps = {
  onInstalled: (version: string) => void
  onBack: () => void
}

// ─── Component ───────────────────────────────────────────────────────────────

export function InstallStep({ onInstalled, onBack }: InstallStepProps) {
  const { installStatus, installLog, setInstallStatus, appendInstallLog, clearInstallLog } =
    useSystemStore()

  const [errorCode, setErrorCode] = useState<string | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [version, setVersion] = useState<string | null>(null)
  const [showPermFix, setShowPermFix] = useState(false)

  const logEndRef = useRef<HTMLDivElement>(null)
  const controllerRef = useRef<AbortController | null>(null)
  const firedRef = useRef(false)

  // ── Start install SSE ────────────────────────────────────────────────────
  const startInstall = useCallback(() => {
    setInstallStatus('installing')
    setErrorCode(null)
    setErrorMessage(null)
    setVersion(null)

    controllerRef.current?.abort()
    controllerRef.current = consumeApiSSE(
      '/api/system/install-openclaw',
      { method: 'POST' },
      {
        onProgress(event) {
          if (event.message) appendInstallLog(event.message)
        },
        onOutput(event) {
          if (event.line) appendInstallLog(event.line)
        },
        onComplete(event) {
          setInstallStatus('success')
          const v = (event.version as string) ?? 'unknown'
          setVersion(v)
        },
        onError(event) {
          setInstallStatus('error')
          setErrorCode((event.code as string) ?? null)
          setErrorMessage((event.message as string) ?? 'Installation failed')
        },
      },
    )
  }, [setInstallStatus, appendInstallLog])

  // ── Mount: auto-start ────────────────────────────────────────────────────
  // Intentionally NO abort-on-cleanup here. The install is a one-time op
  // guarded by `firedRef`. Aborting on unmount made it fragile: React
  // StrictMode (dev) double-invokes effects (mount → cleanup → mount), so the
  // cleanup aborted the in-flight install (the server's res.on('close') even
  // killed the npm child) AND the fire-once guard blocked the re-fire —
  // leaving the wizard stuck on "Installing OpenClaw" forever. Letting the
  // install run to completion server-side, even across an incidental remount,
  // is the safer behavior. The Retry path still aborts the prior controller
  // before re-firing (see startInstall), so we don't leak overlapping streams.
  useEffect(() => {
    if (firedRef.current) return
    firedRef.current = true
    clearInstallLog()
    startInstall()
  }, [clearInstallLog, startInstall])

  // ── Auto-scroll log ──────────────────────────────────────────────────────
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [installLog.length])

  // ── Auto-advance on success ──────────────────────────────────────────────
  useEffect(() => {
    if (installStatus !== 'success' || !version) return
    const timer = setTimeout(() => onInstalled(version), 1000)
    return () => clearTimeout(timer)
  }, [installStatus, version, onInstalled])

  // ── Retry handler ────────────────────────────────────────────────────────
  const handleRetry = useCallback(() => {
    clearInstallLog()
    firedRef.current = false
    startInstall()
  }, [clearInstallLog, startInstall])

  const isEacces = errorCode === 'EACCES'

  return (
    <OnboardingScreen
      step="runtimes"
      steps={NATIVE_STEPS}
      title="Installing OpenClaw"
      subtitle={
        <span className="inline-flex items-center gap-2">
          {installStatus === 'installing' && (
            <Loader2
              className="h-4 w-4 animate-spin"
              style={{ color: 'var(--primary)' }}
              strokeWidth={2.5}
            />
          )}
          {installStatus === 'success' && (
            <Check className="h-4 w-4" style={{ color: 'var(--mint)' }} strokeWidth={2.5} />
          )}
          {installStatus === 'success'
            ? `Installed v${version}.`
            : installStatus === 'error'
              ? 'The install ran into a problem.'
              : 'This may take a minute, pulling openclaw from npm.'}
        </span>
      }
      footer={
        installStatus === 'error' ? (
          <div className="flex flex-col items-center gap-3">
            <OnboardingPrimary onClick={handleRetry} className="w-full">
              <RotateCcw size={15} strokeWidth={2.5} /> Retry
            </OnboardingPrimary>
            <OnboardingGhost onClick={onBack}>
              <ArrowLeft size={14} /> Back
            </OnboardingGhost>
          </div>
        ) : undefined
      }
    >
      {/* ── Terminal log ──────────────────────────────────────── */}
      <div
        className="max-h-[280px] overflow-y-auto rounded-xl border border-border p-4"
        style={{ background: 'var(--terminal-bg, #0d1117)' }}
      >
        {installLog.length === 0 && (
          <div
            className="font-mono text-[12px] leading-relaxed"
            style={{ color: 'rgb(201 209 217 / 0.55)' }}
          >
            Starting install…
          </div>
        )}
        {installLog.map((line, i) => (
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

      {/* ── EACCES error panel ─────────────────────────────── */}
      <AnimatePresence initial={false}>
        {installStatus === 'error' && isEacces && (
          <motion.div
            key="eacces"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.15 }}
            className="mt-4 overflow-hidden"
          >
              <div
                role="alert"
                className="rounded-lg border border-destructive/20 bg-destructive/8 px-3 py-2.5 text-[12px] leading-snug text-destructive"
              >
                <p className="font-semibold mb-1.5">{errorMessage}</p>
                <button
                  type="button"
                  onClick={() => setShowPermFix((v) => !v)}
                  className="flex items-center gap-1 text-[11px] text-destructive/70 underline underline-offset-2"
                >
                  How to fix
                  <ChevronDown
                    className={[
                      'h-3 w-3 transition-transform',
                      showPermFix ? 'rotate-180' : '',
                    ].join(' ')}
                  />
                </button>
                <AnimatePresence initial={false}>
                  {showPermFix && (
                    <motion.div
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: 'auto' }}
                      exit={{ opacity: 0, height: 0 }}
                      transition={{ duration: 0.15 }}
                      className="overflow-hidden"
                    >
                      <ul className="mt-2 flex flex-col gap-1.5 text-[11px] text-destructive/60">
                        <li>
                          <strong>nvm / fnm:</strong> Global installs should work without sudo. Try
                          closing and reopening your terminal.
                        </li>
                        <li>
                          <strong>Homebrew:</strong> Run{' '}
                          <code className="rounded bg-foreground/5 px-1 py-0.5 font-mono text-[10px]">
                            brew postinstall node
                          </code>
                        </li>
                        <li>
                          <strong>Otherwise:</strong> Run{' '}
                          <code className="rounded bg-foreground/5 px-1 py-0.5 font-mono text-[10px]">
                            sudo npm install -g openclaw@latest
                          </code>{' '}
                          in your terminal
                        </li>
                      </ul>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* ── Generic error panel ────────────────────────────── */}
        <AnimatePresence initial={false}>
          {installStatus === 'error' && !isEacces && (
            <motion.div
              key="generic-error"
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              transition={{ duration: 0.15 }}
              className="mt-4 overflow-hidden"
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
    </OnboardingScreen>
  )
}
