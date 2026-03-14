import { useState } from 'react'
import { motion } from 'framer-motion'
import { useTeamStore } from '@/stores/team'
import { useViewStore } from '@/stores/view'
import { useConnectionStore } from '@/stores/connection'
import { CreateTeamModal } from '@/features/teams/CreateTeamModal'

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
      text: 'Explore the Ghost Graph to see your fleet',
      action: () => useViewStore.getState().navigateTo('graph'),
      actionLabel: 'Open Graph',
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
          Multi-agent mission control for OpenClaw.
        </p>
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
              { label: 'Ghost Graph', emoji: '👻', view: 'graph' as const },
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
        onCreated={() => setShowCreateModal(false)}
      />
    </div>
  )
}
