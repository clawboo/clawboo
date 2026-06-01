import { useState, useEffect, useRef } from 'react'
import { motion } from 'framer-motion'
import { BarChart3, Globe, Loader2, ShoppingCart, type LucideIcon } from 'lucide-react'
import { useTeamStore } from '@/stores/team'
import { useViewStore } from '@/stores/view'
import { useConnectionStore } from '@/stores/connection'
import { CreateTeamModal } from '@/features/teams/CreateTeamModal'
import { consumeSSE } from '@/lib/sseClient'
import { SkyAtmosphere } from '@/features/atmosphere'
import type { SystemInfo } from '@/stores/system'

// ─── System Status Hint ──────────────────────────────────────────────────────

function SystemHint({ isConnected }: { isConnected: boolean }) {
  const [systemInfo, setSystemInfo] = useState<SystemInfo | null>(null)
  const [startingGw, setStartingGw] = useState(false)
  const [startError, setStartError] = useState<string | null>(null)
  const sseRef = useRef<AbortController | null>(null)

  useEffect(() => {
    if (isConnected) return
    let cancelled = false
    fetch('/api/system/status')
      .then((r) => r.json())
      .then((data: SystemInfo) => {
        if (!cancelled) setSystemInfo(data)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [isConnected])

  useEffect(() => {
    return () => {
      sseRef.current?.abort()
    }
  }, [])

  if (isConnected || !systemInfo) return null

  const handleStartGateway = () => {
    setStartingGw(true)
    setStartError(null)
    sseRef.current?.abort()
    sseRef.current = consumeSSE(
      '/api/system/gateway',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'start' }),
      },
      {
        onProgress() {},
        onOutput() {},
        onComplete(event) {
          if (event.success) {
            window.location.reload()
          } else {
            setStartingGw(false)
            setStartError('Gateway failed to start')
          }
        },
        onError(event) {
          setStartingGw(false)
          setStartError((event.message as string) ?? 'Failed to start Gateway')
        },
      },
    )
  }

  if (!systemInfo.openclaw.installed) {
    return (
      <div className="mt-2 text-[11px] leading-relaxed text-[rgba(30,37,64,0.62)]">
        <span className="text-amber">OpenClaw is not installed.</span>{' '}
        <a
          href="https://docs.openclaw.ai/start/getting-started"
          target="_blank"
          rel="noopener noreferrer"
          className="text-amber underline underline-offset-2"
        >
          Install OpenClaw to get started
        </a>
      </div>
    )
  }

  if (!systemInfo.gateway.running) {
    return (
      <div className="mt-2 text-[11px] leading-relaxed text-[rgba(30,37,64,0.62)]">
        <span className="text-amber">Gateway is offline.</span>{' '}
        <button
          onClick={handleStartGateway}
          disabled={startingGw}
          className="border-none bg-transparent p-0 text-[11px] font-semibold text-amber underline underline-offset-2 disabled:opacity-60"
          style={{ cursor: startingGw ? 'default' : 'pointer' }}
        >
          {startingGw ? (
            <span className="inline-flex items-center gap-1">
              <Loader2 size={10} className="animate-spin" />
              Starting...
            </span>
          ) : (
            'Start Gateway'
          )}
        </button>
        {startError && <div className="mt-1 text-[10px] text-destructive">{startError}</div>}
      </div>
    )
  }

  return (
    <div className="mt-2 text-[11px] leading-relaxed text-[rgba(30,37,64,0.62)]">
      Gateway is running. Connecting...
    </div>
  )
}

// ─── WelcomeState ────────────────────────────────────────────────────────────

export function WelcomeState() {
  const teams = useTeamStore((s) => s.teams)
  const status = useConnectionStore((s) => s.status)
  const isConnected = status === 'connected'
  const hasTeams = teams.length > 0
  const [showCreateModal, setShowCreateModal] = useState(false)

  const steps = [
    {
      num: '1',
      text: hasTeams ? 'Select a team from the sidebar' : 'Create your first team',
      action: hasTeams ? undefined : () => setShowCreateModal(true),
      actionLabel: 'Create team',
    },
    {
      num: '2',
      text: 'Click an agent to start chatting',
    },
    {
      num: '3',
      text: 'Open the Atlas to see all your teams',
      action: () => useViewStore.getState().navigateTo('graph'),
      actionLabel: 'Open Atlas',
    },
  ]

  return (
    <div
      className="relative flex h-full flex-col items-center justify-center gap-6 overflow-hidden p-8 text-center"
      style={{ background: '#8fb9ee' }}
    >
      {/* Calm Day sky with drifting clouds — theme-independent (always the
          bright Day sky regardless of the app's light/dark preference). */}
      <SkyAtmosphere />

      <motion.div
        className="relative z-10"
        initial={{ opacity: 0, y: 12, scale: 0.92 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ type: 'spring', stiffness: 200, damping: 22 }}
      >
        <motion.img
          src="/logo.svg"
          alt="Clawboo"
          width={96}
          height={88}
          animate={{ y: [0, -4, 0] }}
          transition={{ duration: 4, repeat: Infinity, ease: 'easeInOut' }}
          style={{
            opacity: 0.85,
            filter: 'drop-shadow(0 12px 32px rgb(var(--primary-rgb) / 0.25))',
          }}
        />
      </motion.div>

      <motion.div
        className="relative z-10"
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.1, duration: 0.4, ease: 'easeOut' }}
      >
        <h1
          className="m-0"
          style={{
            fontFamily: 'var(--font-display)',
            fontSize: 36,
            fontWeight: 700,
            letterSpacing: '-0.02em',
            lineHeight: 1.1,
            // Pinned dark — the Day sky is always light; white halo lifts the
            // heading off the clouds regardless of the app theme.
            color: 'rgb(30,37,64)',
            textShadow: '0 2px 24px rgba(255,255,255,0.7), 0 1px 4px rgba(255,255,255,0.8)',
          }}
        >
          Welcome to Clawboo
        </h1>
        <p
          className="mx-auto mt-3 max-w-[400px] text-[14px] leading-relaxed"
          style={{ color: 'rgba(30,37,64,0.78)', textShadow: '0 1px 12px rgba(255,255,255,0.7)' }}
        >
          Deploy, orchestrate, and observe your AI agent fleet.
        </p>

        <SystemHint isConnected={isConnected} />
      </motion.div>

      {/* Quick-start steps */}
      {isConnected && (
        <div className="relative z-10 flex w-full max-w-[340px] flex-col gap-3 text-left">
          {steps.map((step) => (
            <div key={step.num} className="flex items-start gap-3">
              <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/20 text-[12px] font-bold text-primary">
                {step.num}
              </div>
              <div className="flex-1 pt-0.5">
                <span
                  className="text-[13px]"
                  style={{
                    color: 'rgba(30,37,64,0.82)',
                    textShadow: '0 1px 10px rgba(255,255,255,0.7)',
                  }}
                >
                  {step.text}
                </span>
                {step.action && (
                  <button
                    onClick={step.action}
                    className="mt-1 block border-none bg-transparent p-0 text-[11px] font-semibold text-primary"
                  >
                    {step.actionLabel} →
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Primary CTA when no teams */}
      {isConnected && !hasTeams && (
        <motion.button
          onClick={() => setShowCreateModal(true)}
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.2, duration: 0.3, ease: 'easeOut' }}
          whileHover={{ y: -1 }}
          whileTap={{ scale: 0.98 }}
          className="relative z-10 mt-2 rounded-xl border-none bg-primary px-6 py-3 text-[14px] font-semibold text-primary-foreground"
          style={{
            boxShadow:
              '0 8px 24px rgb(var(--primary-rgb) / 0.3), 0 0 0 1px rgb(var(--primary-rgb) / 0.15)',
            transition: 'box-shadow var(--motion-base)',
          }}
        >
          Create your first team
        </motion.button>
      )}

      {/* Nav shortcuts when teams exist */}
      {isConnected && hasTeams && (
        <div className="relative z-10 mt-1 flex gap-2">
          {(
            [
              { label: 'Atlas', icon: Globe, view: 'graph' as const },
              { label: 'Marketplace', icon: ShoppingCart, view: 'marketplace' as const },
              { label: 'Cost', icon: BarChart3, view: 'cost' as const },
            ] as { label: string; icon: LucideIcon; view: 'graph' | 'marketplace' | 'cost' }[]
          ).map((item) => {
            const Icon = item.icon
            return (
              <button
                key={item.view}
                onClick={() => useViewStore.getState().navigateTo(item.view)}
                className="flex items-center gap-2 rounded-lg border border-[rgba(30,37,64,0.14)] bg-[rgba(255,255,255,0.45)] px-3.5 py-1.5 text-[12px] text-[rgba(30,37,64,0.7)] transition-all duration-150 hover:border-[rgba(30,37,64,0.28)] hover:text-[rgba(30,37,64,0.92)]"
                style={{
                  transitionTimingFunction: 'var(--motion-easing-standard)',
                }}
              >
                <Icon size={13} strokeWidth={1.75} aria-hidden />
                {item.label}
              </button>
            )
          })}
        </div>
      )}

      <CreateTeamModal
        isOpen={showCreateModal}
        onClose={() => setShowCreateModal(false)}
        onCreated={() => {
          setShowCreateModal(false)
          const newTeamId = useTeamStore.getState().selectedTeamId
          if (newTeamId) {
            useViewStore.getState().openGroupChat(newTeamId)
          }
        }}
      />
    </div>
  )
}
