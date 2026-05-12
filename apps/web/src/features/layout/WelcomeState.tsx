import { useState, useEffect, useRef } from 'react'
import { motion } from 'framer-motion'
import { Loader2 } from 'lucide-react'
import { useTeamStore } from '@/stores/team'
import { useViewStore } from '@/stores/view'
import { useConnectionStore } from '@/stores/connection'
import { CreateTeamModal } from '@/features/teams/CreateTeamModal'
import { consumeSSE } from '@/lib/sseClient'
import type { SystemInfo } from '@/stores/system'

// ─── System hint styles ──────────────────────────────────────────────────────

const HINT_STYLE: React.CSSProperties = {
  fontSize: 11,
  color: 'rgba(232,232,232,0.35)',
  marginTop: 8,
  lineHeight: 1.5,
}

const AMBER = '#FBBF24'

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

  // Cleanup SSE on unmount
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

  // OpenClaw not installed
  if (!systemInfo.openclaw.installed) {
    return (
      <div style={HINT_STYLE}>
        <span style={{ color: AMBER }}>OpenClaw is not installed.</span>{' '}
        <a
          href="https://docs.openclaw.ai/start/getting-started"
          target="_blank"
          rel="noopener noreferrer"
          style={{
            color: AMBER,
            textDecoration: 'underline',
            textUnderlineOffset: 2,
          }}
        >
          Install OpenClaw to get started
        </a>
      </div>
    )
  }

  // Installed but gateway not running
  if (!systemInfo.gateway.running) {
    return (
      <div style={HINT_STYLE}>
        <span style={{ color: AMBER }}>Gateway is offline.</span>{' '}
        <button
          onClick={handleStartGateway}
          disabled={startingGw}
          style={{
            fontSize: 11,
            fontWeight: 600,
            color: AMBER,
            background: 'none',
            border: 'none',
            cursor: startingGw ? 'default' : 'pointer',
            padding: 0,
            textDecoration: 'underline',
            textUnderlineOffset: 2,
            opacity: startingGw ? 0.6 : 1,
          }}
        >
          {startingGw ? (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <Loader2 size={10} style={{ animation: 'spin 1s linear infinite' }} />
              Starting...
            </span>
          ) : (
            'Start Gateway'
          )}
        </button>
        {startError && (
          <div style={{ color: '#E94560', marginTop: 4, fontSize: 10 }}>{startError}</div>
        )}
      </div>
    )
  }

  // Gateway running but not connected yet
  return <div style={HINT_STYLE}>Gateway is running. Connecting...</div>
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
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100%',
        gap: 24,
        textAlign: 'center',
        padding: 32,
      }}
    >
      <motion.img
        src="/logo.svg"
        alt="Clawboo"
        width={72}
        height={66}
        style={{ opacity: 0.3 }}
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 0.3, y: 0 }}
        transition={{ duration: 0.4 }}
      />

      <div>
        <h2
          style={{
            fontSize: 18,
            fontWeight: 700,
            color: 'rgba(232,232,232,0.8)',
            margin: 0,
            fontFamily: 'var(--font-display)',
          }}
        >
          Welcome to Clawboo
        </h2>
        <p
          style={{
            fontSize: 13,
            color: 'rgba(232,232,232,0.4)',
            margin: '8px 0 0',
            lineHeight: 1.6,
            maxWidth: 360,
          }}
        >
          Deploy, orchestrate, and observe your AI agent fleet.
        </p>

        {/* System status hint when not connected */}
        <SystemHint isConnected={isConnected} />
      </div>

      {/* Quick-start steps */}
      {isConnected && (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 12,
            width: '100%',
            maxWidth: 340,
            textAlign: 'left',
          }}
        >
          {steps.map((step) => (
            <div key={step.num} style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
              <div
                style={{
                  width: 24,
                  height: 24,
                  borderRadius: 12,
                  background: 'rgba(233,69,96,0.12)',
                  color: '#E94560',
                  fontSize: 12,
                  fontWeight: 700,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  flexShrink: 0,
                }}
              >
                {step.num}
              </div>
              <div style={{ flex: 1, paddingTop: 2 }}>
                <span style={{ fontSize: 13, color: 'rgba(232,232,232,0.65)' }}>{step.text}</span>
                {step.action && (
                  <button
                    onClick={step.action}
                    style={{
                      display: 'block',
                      marginTop: 4,
                      fontSize: 11,
                      fontWeight: 600,
                      color: '#E94560',
                      background: 'none',
                      border: 'none',
                      cursor: 'pointer',
                      padding: 0,
                    }}
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
          style={{
            background: '#E94560',
            border: 'none',
            borderRadius: 8,
            color: '#fff',
            fontSize: 13,
            fontWeight: 600,
            padding: '10px 24px',
            cursor: 'pointer',
            transition: 'all 0.15s',
            marginTop: 8,
          }}
        >
          Create your first team
        </button>
      )}

      {/* Nav shortcuts when teams exist */}
      {isConnected && hasTeams && (
        <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
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
              style={{
                background: 'rgba(255,255,255,0.04)',
                border: '1px solid rgba(255,255,255,0.08)',
                borderRadius: 8,
                color: 'rgba(232,232,232,0.5)',
                fontSize: 12,
                padding: '6px 14px',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                transition: 'all 0.15s',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.borderColor = 'rgba(255,255,255,0.15)'
                e.currentTarget.style.color = 'rgba(232,232,232,0.7)'
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.borderColor = 'rgba(255,255,255,0.08)'
                e.currentTarget.style.color = 'rgba(232,232,232,0.5)'
              }}
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
          // CreateTeamModal selects the newly-created team before firing
          // onCreated — land in its group chat instead of leaving the user
          // on the welcome screen with nothing visibly happening.
          const newTeamId = useTeamStore.getState().selectedTeamId
          if (newTeamId) {
            useViewStore.getState().openGroupChat(newTeamId)
          }
        }}
      />
    </div>
  )
}
