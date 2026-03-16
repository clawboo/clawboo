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
import { consumeSSE } from '@/lib/sseClient'
import { useSystemStore } from '@/stores/system'

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
    controllerRef.current = consumeSSE(
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
  useEffect(() => {
    if (firedRef.current) return
    firedRef.current = true
    clearInstallLog()
    startInstall()

    return () => {
      controllerRef.current?.abort()
    }
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
    <div className="w-full max-w-lg rounded-2xl border border-white/8 bg-surface shadow-[0_32px_80px_rgba(0,0,0,0.65)]">
      <div className="p-8">
        {/* ── Header ───────────────────────────────────────────── */}
        <div className="mb-1 flex items-center gap-2">
          <h2
            className="text-[20px] font-bold text-text"
            style={{ fontFamily: 'var(--font-display)' }}
          >
            Installing OpenClaw
          </h2>
          {installStatus === 'installing' && (
            <Loader2 className="h-4 w-4 animate-spin text-accent" strokeWidth={2.5} />
          )}
          {installStatus === 'success' && (
            <motion.div
              initial={{ opacity: 0, scale: 0.5 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ type: 'spring', stiffness: 400, damping: 20 }}
            >
              <Check className="h-4 w-4 text-mint" strokeWidth={2.5} />
            </motion.div>
          )}
        </div>
        <p className="text-[12px] text-secondary mb-5">
          {installStatus === 'success' ? `Installed! v${version}` : 'This may take a minute…'}
        </p>

        {/* ── Terminal log ──────────────────────────────────────── */}
        <div className="mb-4 max-h-[240px] overflow-y-auto rounded-lg border border-white/8 bg-[#0d1117] p-3">
          {installLog.map((line, i) => (
            <div key={i} className="font-mono text-[11px] leading-relaxed text-secondary/60">
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
              className="mb-4 overflow-hidden"
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
                          <code className="rounded bg-white/5 px-1 py-0.5 font-mono text-[10px]">
                            brew postinstall node
                          </code>
                        </li>
                        <li>
                          <strong>Otherwise:</strong> Run{' '}
                          <code className="rounded bg-white/5 px-1 py-0.5 font-mono text-[10px]">
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
              className="mb-4 overflow-hidden"
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
        {installStatus === 'error' && (
          <div className="flex flex-col gap-3">
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
