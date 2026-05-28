import { useState, useEffect, useRef } from 'react'
import { motion } from 'framer-motion'
import { Loader2 } from 'lucide-react'
import { useTeamStore } from '@/stores/team'
import { useViewStore } from '@/stores/view'
import { useConnectionStore } from '@/stores/connection'
import { CreateTeamModal } from '@/features/teams/CreateTeamModal'
import { consumeSSE } from '@/lib/sseClient'
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
      <div className="mt-2 text-[11px] leading-relaxed text-secondary/60">
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
      <div className="mt-2 text-[11px] leading-relaxed text-secondary/60">
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
    <div className="mt-2 text-[11px] leading-relaxed text-secondary/60">
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
      className="relative flex h-full flex-col items-center justify-center gap-6 p-8 text-center"
      style={{
        background:
          'radial-gradient(ellipse 80% 60% at 50% 40%, var(--welcome-glow) 0%, transparent 70%)',
      }}
    >
      <motion.img
        src="/logo.svg"
        alt="Clawboo"
        width={72}
        height={66}
        className="opacity-40"
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 0.4, y: 0 }}
        transition={{ duration: 0.4 }}
      />

      <div>
        <h2
          className="m-0 text-[18px] font-bold text-foreground/80"
          style={{ fontFamily: 'var(--font-display)' }}
        >
          Welcome to Clawboo
        </h2>
        <p className="mx-auto mt-2 max-w-[360px] text-[13px] leading-relaxed text-foreground/50">
          Deploy, orchestrate, and observe your AI agent fleet.
        </p>

        <SystemHint isConnected={isConnected} />
      </div>

      {/* Quick-start steps */}
      {isConnected && (
        <div className="flex w-full max-w-[340px] flex-col gap-3 text-left">
          {steps.map((step) => (
            <div key={step.num} className="flex items-start gap-3">
              <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/12 text-[12px] font-bold text-primary">
                {step.num}
              </div>
              <div className="flex-1 pt-0.5">
                <span className="text-[13px] text-foreground/70">{step.text}</span>
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
        <button
          onClick={() => setShowCreateModal(true)}
          className="mt-2 rounded-lg border-none bg-primary px-6 py-2.5 text-[13px] font-semibold text-primary-foreground transition-all duration-150 hover:bg-primary/90"
        >
          Create your first team
        </button>
      )}

      {/* Nav shortcuts when teams exist */}
      {isConnected && hasTeams && (
        <div className="mt-1 flex gap-2">
          {(
            [
              { label: 'Atlas', emoji: '🌐', view: 'graph' as const },
              { label: 'Marketplace', emoji: '🛒', view: 'marketplace' as const },
              { label: 'Cost', emoji: '💰', view: 'cost' as const },
            ] as const
          ).map((item) => (
            <button
              key={item.view}
              onClick={() => useViewStore.getState().navigateTo(item.view)}
              className="flex items-center gap-1.5 rounded-lg border border-border bg-foreground/[0.04] px-3.5 py-1.5 text-[12px] text-foreground/55 transition-all duration-150 hover:border-foreground/15 hover:text-foreground/80"
            >
              <span>{item.emoji}</span>
              {item.label}
            </button>
          ))}
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
