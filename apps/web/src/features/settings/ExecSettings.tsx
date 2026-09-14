import { useState, useEffect, useCallback } from 'react'
import { Shield } from 'lucide-react'
import { apiFetch } from '@clawboo/control-client'
import { useFleetStore } from '@/stores/fleet'
import { useConnectionStore } from '@/stores/connection'
import { useToastStore } from '@/stores/toast'
import { resolveExecPatchParams } from '@clawboo/gateway-client'
import { Select } from '@/features/shared/Select'
import { ExecAllowlist } from './ExecAllowlist'

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
    apiFetch(`/api/exec-settings?agentId=${encodeURIComponent(agentId)}`)
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

  // THE SERVER OWNS THE GATEWAY WRITE, and this no longer duplicates it.
  //
  // This function used to call `upsertExecApprovalPolicy` itself, behind
  // `if (client)` and inside a `catch {}`, then show the success toast whatever
  // happened. A tab with no Gateway connection therefore reported "Saved" while
  // OpenClaw's policy stayed empty and the Boo went on running every command
  // unasked. `POST /api/exec-settings` now performs that write from the server,
  // which holds a long-lived connection and resolves OPENCLAW'S agent id rather
  // than clawboo's row id, and returns 502 when the Gateway refuses.
  //
  // HALF OF THAT FIX WAS STILL BEING THROWN AWAY HERE. `apiFetch` is a thin
  // wrapper over `fetch`, so a 502 resolves normally and the `catch` never runs.
  // The server reported the failure honestly and the browser discarded the
  // report and toasted success, which is the same lie one layer up.
  const persist = useCallback(
    async (newAsk: string, prevAsk: string) => {
      updateExecConfig(agentId, { execAsk: newAsk })

      let failure: string | null = null
      try {
        const res = await apiFetch('/api/exec-settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ agentId, values: { execAsk: newAsk } }),
        })
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as { error?: string } | null
          failure = body?.error ?? `clawboo could not apply this (${res.status})`
        }
      } catch (err) {
        failure = err instanceof Error ? err.message : 'clawboo could not be reached'
      }

      if (failure) {
        // PUT THE CONTROL BACK. A permissions switch left sitting in the position
        // you moved it to is itself a claim that the change took, and this one is
        // read later as the state of the gate.
        setExecAsk(prevAsk)
        updateExecConfig(agentId, { execAsk: prevAsk })
        addToast({ message: `Not applied. ${failure}`, type: 'error' })
        return
      }

      // A separate concern from the policy: this only tells the live session to
      // run commands on the Gateway host. Its failure does not mean the approval
      // posture was not applied, so it does not undo the change above.
      const agent = useFleetStore.getState().agents.find((a) => a.id === agentId)
      if (client && agent?.sessionKey) {
        try {
          await client.call('sessions.patch', {
            key: agent.sessionKey,
            ...resolveExecPatchParams(),
          })
        } catch {
          addToast({
            message: 'Saved. The running session picks this up on its next message.',
            type: 'error',
          })
        }
      }

      addToast({ message: 'Execution permissions updated', type: 'success' })
    },
    [agentId, client, updateExecConfig, addToast],
  )

  const handleChange = useCallback(
    (value: string) => {
      const prev = execAsk
      setExecAsk(value)
      void persist(value, prev)
    },
    [persist, execAsk],
  )

  const selected = EXEC_OPTIONS.find((o) => o.value === execAsk) ?? EXEC_OPTIONS[0]

  return (
    <div>
      {/* Section header */}
      <div className="mb-2 flex items-center gap-1.5">
        <Shield size={14} strokeWidth={2} style={{ color: 'var(--amber)' }} />
        <span className="text-[12px] font-semibold text-foreground">Execution Permissions</span>
      </div>

      <p className="mb-3.5 text-[11px] leading-relaxed text-muted-foreground">
        Controls whether this agent needs your approval before running shell commands. Changes take
        effect on the next message.
      </p>

      {/* GATED SEPARATELY from the grants list below. `loaded` tracks clawboo's
          own exec_config read; letting it hide the whole component meant a failed
          local read also hid a working, Gateway-backed permission list. */}
      {loaded && (
        <div
          className="rounded-2xl border border-border bg-surface p-4"
          style={{ boxShadow: 'var(--shadow-raised)' }}
        >
          <label className="mb-2 block font-mono text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
            Command Execution
          </label>
          <Select
            data-testid="exec-ask-select"
            value={execAsk}
            onChange={handleChange}
            options={EXEC_OPTIONS.map((opt) => ({ value: opt.value, label: opt.label }))}
            style={{ width: '100%' }}
          />
          <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
            {selected.description}
          </p>
        </div>
      )}

      <ExecAllowlist agentId={agentId} />
    </div>
  )
}
