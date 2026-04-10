import { useState, useEffect, useCallback } from 'react'
import { Shield, ChevronDown } from 'lucide-react'
import { useFleetStore } from '@/stores/fleet'
import { useConnectionStore } from '@/stores/connection'
import { useToastStore } from '@/stores/toast'
import { resolveExecPatchParams, upsertExecApprovalPolicy } from '@/lib/execSettingsForGateway'

// ─── Option definitions ─────────────────────────────────────────────────────

interface ExecOption {
  value: string
  label: string
  description: string
}

const EXEC_OPTIONS: ExecOption[] = [
  { value: 'off', label: 'Run Freely', description: 'Executes commands without asking' },
  {
    value: 'on-miss',
    label: 'Ask for Unknown',
    description: 'Asks approval for unlisted commands',
  },
  { value: 'always', label: 'Always Ask', description: 'Asks approval for every command' },
]

// ─── Main component ─────────────────────────────────────────────────────────

export function ExecSettings({ agentId }: { agentId: string }) {
  const [execAsk, setExecAsk] = useState('off')
  const [loaded, setLoaded] = useState(false)
  const updateExecConfig = useFleetStore((s) => s.updateExecConfig)
  const client = useConnectionStore((s) => s.client)
  const addToast = useToastStore((s) => s.addToast)

  // Load saved exec config from SQLite on mount
  useEffect(() => {
    setLoaded(false)
    fetch(`/api/exec-settings?agentId=${encodeURIComponent(agentId)}`)
      .then((r) => r.json())
      .then((data: { values: { execAsk?: string } | null }) => {
        if (data.values?.execAsk) {
          setExecAsk(data.values.execAsk)
          updateExecConfig(agentId, { execAsk: data.values.execAsk })
        }
        setLoaded(true)
      })
      .catch(() => setLoaded(true))
  }, [agentId, updateExecConfig])

  const persist = useCallback(
    async (newAsk: string) => {
      // Update Zustand store immediately
      updateExecConfig(agentId, { execAsk: newAsk })

      // Persist to SQLite
      try {
        await fetch('/api/exec-settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ agentId, values: { execAsk: newAsk } }),
        })
      } catch {
        // Non-fatal
      }

      // Apply immediately if connected
      if (client) {
        // 1. Write per-agent approval policy to Gateway's exec-approvals file
        try {
          await upsertExecApprovalPolicy(client, agentId, newAsk)
        } catch {
          // Non-fatal — policy will be retried on next message
        }

        // 2. Patch the live session with exec settings
        const agent = useFleetStore.getState().agents.find((a) => a.id === agentId)
        if (agent?.sessionKey) {
          try {
            const execParams = resolveExecPatchParams(newAsk)
            await client.call('sessions.patch', {
              key: agent.sessionKey,
              ...execParams,
            })
          } catch {
            addToast({
              message:
                'Could not apply setting to live session. It will be retried on next message.',
              type: 'error',
            })
          }
        }
      }

      addToast({ message: 'Execution permissions updated', type: 'success' })
    },
    [agentId, client, updateExecConfig, addToast],
  )

  const handleChange = useCallback(
    (value: string) => {
      setExecAsk(value)
      void persist(value)
    },
    [persist],
  )

  if (!loaded) return null

  const selected = EXEC_OPTIONS.find((o) => o.value === execAsk) ?? EXEC_OPTIONS[0]

  return (
    <div>
      {/* Section header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          marginBottom: 12,
        }}
      >
        <Shield style={{ width: 14, height: 14, color: '#FBBF24' }} strokeWidth={2} />
        <span
          style={{
            fontSize: 12,
            fontWeight: 600,
            color: '#E8E8E8',
          }}
        >
          Execution Permissions
        </span>
      </div>

      <p
        style={{
          fontSize: 10,
          color: 'rgba(232,232,232,0.35)',
          lineHeight: 1.5,
          marginBottom: 14,
        }}
      >
        Controls whether this agent needs your approval before running shell commands. Changes take
        effect on the next message.
      </p>

      <div style={{ marginBottom: 14 }}>
        <label
          style={{
            display: 'block',
            fontSize: 11,
            fontWeight: 500,
            color: 'rgba(232,232,232,0.55)',
            marginBottom: 6,
          }}
        >
          Command Execution
        </label>
        <div style={{ position: 'relative' }}>
          <select
            value={execAsk}
            onChange={(e) => handleChange(e.target.value)}
            style={{
              width: '100%',
              padding: '8px 32px 8px 10px',
              borderRadius: 6,
              border: '1px solid rgba(255,255,255,0.08)',
              background: '#0A0E1A',
              color: '#E8E8E8',
              fontSize: 12,
              fontWeight: 500,
              fontFamily: 'inherit',
              cursor: 'pointer',
              appearance: 'none',
              outline: 'none',
            }}
          >
            {EXEC_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
          <ChevronDown
            style={{
              position: 'absolute',
              right: 10,
              top: '50%',
              transform: 'translateY(-50%)',
              width: 14,
              height: 14,
              color: 'rgba(232,232,232,0.4)',
              pointerEvents: 'none',
            }}
            strokeWidth={2}
          />
        </div>
        <p
          style={{
            marginTop: 4,
            fontSize: 10,
            color: 'rgba(232,232,232,0.3)',
            lineHeight: 1.4,
          }}
        >
          {selected.description}
        </p>
      </div>
    </div>
  )
}
