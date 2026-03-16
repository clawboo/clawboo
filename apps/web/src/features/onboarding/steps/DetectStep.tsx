/**
 * features/onboarding/steps/DetectStep.tsx
 *
 * System detection checklist with animated results.
 * Fetches GET /api/system/status on mount and displays
 * Node.js / OpenClaw / Gateway status with staggered reveals.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { Check, ExternalLink, Loader2, X } from 'lucide-react'
import { useSystemStore } from '@/stores/system'
import type { SystemInfo } from '@/stores/system'
import { StepIndicator } from '../StepIndicator'

// ─── Props ───────────────────────────────────────────────────────────────────

export type DetectStepProps = {
  onAllGood: () => void
  onNeedInstall: () => void
  onNeedConfigure: () => void
  onNeedGateway: () => void
  onAdvancedConnect: () => void
}

// ─── Constants ───────────────────────────────────────────────────────────────

const STAGGER_MS = 300

type CheckStatus = 'loading' | 'pass' | 'fail' | 'warn'

interface CheckItem {
  label: string
  status: CheckStatus
  detail: string
}

function deriveChecklist(info: SystemInfo): CheckItem[] {
  return [
    {
      label: 'Node.js',
      status: info.node.sufficient ? 'pass' : 'fail',
      detail: info.node.sufficient ? info.node.version : `${info.node.version} — v22+ required`,
    },
    {
      label: 'OpenClaw',
      status: info.openclaw.installed ? 'pass' : 'warn',
      detail: info.openclaw.installed ? `v${info.openclaw.version ?? 'unknown'}` : 'Not found',
    },
    {
      label: 'Gateway',
      status: info.gateway.running ? 'pass' : 'warn',
      detail: info.gateway.running ? `Running on :${info.gateway.port}` : 'Not running',
    },
  ]
}

// ─── Component ───────────────────────────────────────────────────────────────

export function DetectStep({
  onAllGood,
  onNeedInstall,
  onNeedConfigure,
  onNeedGateway,
  onAdvancedConnect,
}: DetectStepProps) {
  const { info, detecting, setInfo, setDetecting } = useSystemStore()
  const [revealCount, setRevealCount] = useState(0)
  const firedRef = useRef(false)
  const autoAdvanceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // ── Fetch system status on mount ─────────────────────────────────────────
  useEffect(() => {
    if (firedRef.current) return
    firedRef.current = true

    setDetecting(true)

    void (async () => {
      try {
        const res = await fetch('/api/system/status')
        const data = (await res.json()) as SystemInfo
        setInfo(data)
      } catch {
        // Detection failed — leave info as null
      } finally {
        setDetecting(false)
      }
    })()
  }, [setDetecting, setInfo])

  // ── Staggered reveal of checklist items ──────────────────────────────────
  useEffect(() => {
    if (!info) return
    if (revealCount >= 3) return

    const timer = setTimeout(() => {
      setRevealCount((c) => c + 1)
    }, STAGGER_MS)

    return () => clearTimeout(timer)
  }, [info, revealCount])

  // ── Auto-advance when everything is green ────────────────────────────────
  const allGood =
    info !== null &&
    info.node.sufficient &&
    info.openclaw.installed &&
    info.openclaw.configExists &&
    info.gateway.running

  useEffect(() => {
    if (allGood && revealCount >= 3) {
      autoAdvanceRef.current = setTimeout(onAllGood, 1500)
      return () => {
        if (autoAdvanceRef.current) clearTimeout(autoAdvanceRef.current)
      }
    }
  }, [allGood, revealCount, onAllGood])

  // ── Derive CTA ───────────────────────────────────────────────────────────
  const handleCta = useCallback(() => {
    if (!info) return
    if (!info.node.sufficient) return
    if (!info.openclaw.installed) return onNeedInstall()
    if (!info.openclaw.configExists || !info.openclaw.envExists) return onNeedConfigure()
    if (!info.gateway.running) return onNeedGateway()
    onAllGood()
  }, [info, onAllGood, onNeedInstall, onNeedConfigure, onNeedGateway])

  const ctaLabel = !info
    ? null
    : !info.node.sufficient
      ? null
      : !info.openclaw.installed
        ? 'Install OpenClaw'
        : !info.openclaw.configExists || !info.openclaw.envExists
          ? 'Set Up OpenClaw'
          : !info.gateway.running
            ? 'Start Gateway'
            : 'Continue'

  const checklist: CheckItem[] = info
    ? deriveChecklist(info)
    : [
        { label: 'Node.js', status: 'loading', detail: 'Checking…' },
        { label: 'OpenClaw', status: 'loading', detail: 'Checking…' },
        { label: 'Gateway', status: 'loading', detail: 'Checking…' },
      ]

  return (
    <div className="w-full max-w-[420px] rounded-2xl border border-white/8 bg-surface shadow-[0_32px_80px_rgba(0,0,0,0.65)]">
      <div className="p-8">
        <StepIndicator current="setup" />

        <h2
          className="text-[20px] font-bold text-text mb-1"
          style={{ fontFamily: 'var(--font-display)' }}
        >
          System Check
        </h2>
        <p className="text-[12px] text-secondary mb-6">Checking your environment for OpenClaw…</p>

        {/* ── Checklist ──────────────────────────────────────── */}
        <div className="flex flex-col gap-3 mb-6">
          {checklist.map((item, i) => {
            const revealed = info ? i < revealCount : true
            const showLoader = detecting || (!info && item.status === 'loading') || !revealed

            return (
              <motion.div
                key={item.label}
                initial={{ opacity: 0, x: -12 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{
                  type: 'spring',
                  stiffness: 320,
                  damping: 30,
                  delay: i * 0.1,
                }}
                className="flex items-center gap-3"
              >
                {/* Icon */}
                <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-white/5">
                  <AnimatePresence mode="wait">
                    {showLoader ? (
                      <motion.div
                        key="loader"
                        initial={{ opacity: 0, scale: 0.8 }}
                        animate={{ opacity: 1, scale: 1 }}
                        exit={{ opacity: 0, scale: 0.8 }}
                        transition={{ duration: 0.15 }}
                      >
                        <Loader2
                          className="h-3.5 w-3.5 animate-spin text-secondary/40"
                          strokeWidth={2.5}
                        />
                      </motion.div>
                    ) : item.status === 'pass' ? (
                      <motion.div
                        key="check"
                        initial={{ opacity: 0, scale: 0.5 }}
                        animate={{ opacity: 1, scale: 1 }}
                        transition={{
                          type: 'spring',
                          stiffness: 400,
                          damping: 20,
                        }}
                      >
                        <Check className="h-3.5 w-3.5 text-mint" strokeWidth={2.5} />
                      </motion.div>
                    ) : item.status === 'fail' ? (
                      <motion.div
                        key="fail"
                        initial={{ opacity: 0, scale: 0.5 }}
                        animate={{ opacity: 1, scale: 1 }}
                        transition={{
                          type: 'spring',
                          stiffness: 400,
                          damping: 20,
                        }}
                      >
                        <X className="h-3.5 w-3.5 text-destructive" strokeWidth={2.5} />
                      </motion.div>
                    ) : (
                      <motion.div
                        key="warn"
                        initial={{ opacity: 0, scale: 0.5 }}
                        animate={{ opacity: 1, scale: 1 }}
                        transition={{
                          type: 'spring',
                          stiffness: 400,
                          damping: 20,
                        }}
                      >
                        <div className="h-2 w-2 rounded-full bg-amber" />
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>

                {/* Label + detail */}
                <div className="flex flex-1 items-baseline justify-between gap-2">
                  <span className="text-[13px] font-medium text-text">{item.label}</span>
                  <span
                    className={[
                      'font-mono text-[11px]',
                      item.status === 'pass'
                        ? 'text-mint/70'
                        : item.status === 'fail'
                          ? 'text-destructive/80'
                          : item.status === 'warn'
                            ? 'text-amber/70'
                            : 'text-secondary/30',
                    ].join(' ')}
                  >
                    {revealed ? item.detail : ''}
                  </span>
                </div>
              </motion.div>
            )
          })}
        </div>

        {/* ── Node.js version error ──────────────────────────── */}
        <AnimatePresence initial={false}>
          {info && !info.node.sufficient && revealCount >= 1 && (
            <motion.div
              key="node-error"
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
                Node.js 22 or later is required.{' '}
                <a
                  href="https://nodejs.org"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 underline underline-offset-2"
                >
                  Download Node.js
                  <ExternalLink className="h-3 w-3" />
                </a>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* ── CTA button ─────────────────────────────────────── */}
        <AnimatePresence initial={false}>
          {ctaLabel && revealCount >= 3 && (
            <motion.div
              key="cta"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ type: 'spring', stiffness: 320, damping: 30 }}
            >
              <button
                type="button"
                onClick={handleCta}
                className="flex h-11 w-full items-center justify-center gap-2 rounded-lg bg-accent font-mono text-[13px] font-semibold tracking-wide text-white shadow-sm transition hover:brightness-110 active:scale-[0.98]"
              >
                {ctaLabel}
              </button>
            </motion.div>
          )}
        </AnimatePresence>

        {/* ── Advanced connect link ──────────────────────────── */}
        <p className="mt-5 text-center">
          <button
            type="button"
            onClick={onAdvancedConnect}
            className="font-mono text-[11px] text-secondary/35 underline underline-offset-2 transition hover:text-secondary"
          >
            Connect to remote gateway &rarr;
          </button>
        </p>
      </div>
    </div>
  )
}
