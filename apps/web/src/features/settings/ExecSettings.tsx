import { useState, useEffect, useCallback } from 'react'
import { Shield } from 'lucide-react'
import { useFleetStore } from '@/stores/fleet'
import { useConnectionStore } from '@/stores/connection'
import { useToastStore } from '@/stores/toast'
import { resolveExecPatchParams, upsertExecApprovalPolicy } from '@/lib/execSettingsForGateway'
import { Select } from '@/features/shared/Select'

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
      <div className="mb-2 flex items-center gap-1.5">
        <Shield size={14} strokeWidth={2} style={{ color: 'var(--amber)' }} />
        <span className="text-[12px] font-semibold text-foreground">Execution Permissions</span>
      </div>

      <p className="mb-3.5 text-[11px] leading-relaxed text-foreground/45">
        Controls whether this agent needs your approval before running shell commands. Changes take
        effect on the next message.
      </p>

      <div
        className="rounded-2xl border border-border bg-surface p-4"
        style={{ boxShadow: 'var(--shadow-raised)' }}
      >
        <label className="mb-2 block font-mono text-[11px] uppercase tracking-[0.14em] text-foreground/45">
          Command Execution
        </label>
        <Select
          value={execAsk}
          onChange={handleChange}
          options={EXEC_OPTIONS.map((opt) => ({ value: opt.value, label: opt.label }))}
          style={{ width: '100%' }}
        />
        <p className="mt-2 text-[11px] leading-relaxed text-foreground/40">{selected.description}</p>
      </div>
    </div>
  )
}
