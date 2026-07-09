import { useEffect, useState, useCallback, useRef, type ReactNode } from 'react'
import { RefreshCw, Settings } from 'lucide-react'
import { GatewayControls } from './GatewayControls'
import { ModelSelector } from './ModelSelector'
import { ApiKeyManager } from './ApiKeyManager'
import { BooZeroBriefsPanel } from './BooZeroBriefsPanel'
import { useConnectionStore } from '@/stores/connection'
import { useToastStore } from '@/stores/toast'
import { consumeApiSSE } from '@clawboo/control-client'
import { GitHubStarButton } from '@/features/promo/GitHubStarButton'
import { PanelHeader } from '@/features/shared/PanelHeader'
import { Button } from '@/features/shared/Button'
import { Switch } from '@/features/shared/Switch'
import { Select } from '@/features/shared/Select'
import { Spinner } from '@/features/shared/Spinner'

// ─── Types ───────────────────────────────────────────────────────────────────

interface SystemStatus {
  node: { version: string; major: number; sufficient: boolean; path: string }
  openclaw: {
    installed: boolean
    version: string | null
    path: string | null
    stateDir: string
    configExists: boolean
    envExists: boolean
  }
  gateway: {
    running: boolean
    port: number
    pid: number | null
    managedByClawboo: boolean
    uptimeMs: number | null
  }
}

interface OpenClawConfig {
  config: {
    agents?: { defaults?: { model?: { primary?: string } } }
    [key: string]: unknown
  }
  env: Record<string, boolean>
  version: string | null
}

// ─── Section card ────────────────────────────────────────────────────────────

/** A clean card with a mono-uppercase section label above its body. */
function SectionCard({
  label,
  children,
  ...rest
}: {
  label: string
  children: ReactNode
  'data-testid'?: string
}) {
  return (
    <section
      className="rounded-2xl border border-border bg-surface p-5"
      style={{ boxShadow: 'var(--shadow-raised)' }}
      {...rest}
    >
      <h2 className="font-mono text-[11px] font-semibold uppercase tracking-[0.14em] text-foreground/45">
        {label}
      </h2>
      <div className="mt-4">{children}</div>
    </section>
  )
}

// ─── Info row ────────────────────────────────────────────────────────────────

function InfoRow({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="flex items-baseline gap-3">
      <span className="w-[100px] shrink-0 text-[11px] font-medium text-foreground/40">{label}</span>
      <span className="font-data break-all text-[13px] text-foreground">{value ?? '—'}</span>
    </div>
  )
}

// ─── Agent Coordination Toggle ───────────────────────────────────────────────

function AgentCoordinationToggle() {
  const client = useConnectionStore((s) => s.client)
  const addToast = useToastStore((s) => s.addToast)
  const [enabled, setEnabled] = useState<boolean | null>(null)
  const [toggling, setToggling] = useState(false)

  // Fetch current value from openclaw.json via HTTP
  useEffect(() => {
    fetch('/api/system/openclaw-config')
      .then(
        (r) =>
          r.json() as Promise<{ config?: { tools?: { agentToAgent?: { enabled?: boolean } } } }>,
      )
      .then((data) => {
        setEnabled(data?.config?.tools?.agentToAgent?.enabled === true)
      })
      .catch(() => {
        // Can't read config — leave as null (hidden)
      })
  }, [])

  const handleToggle = useCallback(async () => {
    if (toggling) return
    const next = !enabled
    setToggling(true)
    try {
      const res = await fetch('/api/system/openclaw-config', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentToAgent: { enabled: next } }),
      })
      if (!res.ok) throw new Error(`Server returned ${res.status}`)
      setEnabled(next)
      addToast({
        message: next ? 'Agent coordination enabled' : 'Agent coordination disabled',
        type: 'success',
      })
    } catch {
      addToast({ message: 'Failed to update Gateway config', type: 'error' })
    } finally {
      setToggling(false)
    }

    // Best-effort Gateway hot reload (outside try/catch — config write already succeeded)
    try {
      if (client) await client.config.get()
    } catch {
      // Gateway may be disconnected — config still saved to disk, picked up on next turn
    }
  }, [client, enabled, toggling, addToast])

  // Don't render if no client or config couldn't be read
  if (!client || enabled === null) return null

  return (
    <SectionCard label="Agent Coordination">
      <div className="flex items-center gap-3">
        <Switch
          checked={enabled}
          onChange={() => void handleToggle()}
          disabled={toggling}
          label="Toggle agent-to-agent coordination"
        />
        <span className="text-[13px] text-foreground/60">
          {enabled
            ? 'Agents can delegate tasks to each other'
            : 'Agent-to-agent messaging disabled'}
        </span>
      </div>
      <p className="mt-3 text-[12px] leading-relaxed text-foreground/40">
        When enabled, agents can use routing defined in AGENTS.md to send messages to other agents
        via the Gateway&apos;s sessions_send tool.
      </p>
    </SectionCard>
  )
}

// ─── Command Approval Default ────────────────────────────────────────────────

const EXEC_ASK_OPTIONS = [
  { value: 'off', label: 'Run Freely', description: 'Agents execute commands without asking' },
  {
    value: 'on-miss',
    label: 'Ask for Unknown',
    description: 'Agents ask approval for commands not in allowlist',
  },
  { value: 'always', label: 'Always Ask', description: 'Agents ask approval for every command' },
]

function CommandApprovalDefault() {
  const client = useConnectionStore((s) => s.client)
  const addToast = useToastStore((s) => s.addToast)
  const [execAsk, setExecAsk] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  // Fetch current value from openclaw.json
  useEffect(() => {
    fetch('/api/system/openclaw-config')
      .then((r) => r.json() as Promise<{ config?: { tools?: { exec?: { ask?: string } } } }>)
      .then((data) => {
        const ask = data?.config?.tools?.exec?.ask
        setExecAsk(typeof ask === 'string' ? ask : 'off')
      })
      .catch(() => {
        // Can't read config — leave as null (hidden)
      })
  }, [])

  const handleChange = useCallback(
    async (value: string) => {
      setSaving(true)
      const prev = execAsk
      setExecAsk(value)
      try {
        const res = await fetch('/api/system/openclaw-config', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ exec: { ask: value } }),
        })
        if (!res.ok) throw new Error(`Server returned ${res.status}`)
        addToast({
          message: `Default command approval set to "${EXEC_ASK_OPTIONS.find((o) => o.value === value)?.label ?? value}"`,
          type: 'success',
        })
      } catch {
        setExecAsk(prev)
        addToast({ message: 'Failed to update Gateway config', type: 'error' })
      } finally {
        setSaving(false)
      }

      // Best-effort Gateway hot reload
      try {
        if (client) await client.config.get()
      } catch {
        // Gateway may be disconnected — config still saved to disk
      }
    },
    [client, execAsk, addToast],
  )

  if (!client || execAsk === null) return null

  const selected = EXEC_ASK_OPTIONS.find((o) => o.value === execAsk) ?? EXEC_ASK_OPTIONS[0]

  return (
    <SectionCard label="Command Approval">
      <div className="flex items-center gap-3">
        <span className="text-[13px] text-foreground/50">Default:</span>
        <Select
          value={execAsk}
          disabled={saving}
          onChange={(v) => void handleChange(v)}
          options={EXEC_ASK_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
          style={{ width: 220, maxWidth: '100%' }}
        />
      </div>
      <p className="mt-2 text-[12px] leading-relaxed text-foreground/45">{selected.description}</p>
      <p className="mt-2 text-[12px] leading-relaxed text-foreground/40">
        Default for all agents — individual agents can override this in their settings (Personality
        tab → Execution Permissions).
      </p>
    </SectionCard>
  )
}

// ─── MaintenancePanel ────────────────────────────────────────────────────────

export function MaintenancePanel() {
  const [status, setStatus] = useState<SystemStatus | null>(null)
  const [config, setConfig] = useState<OpenClawConfig | null>(null)
  const [loading, setLoading] = useState(true)
  const [updating, setUpdating] = useState(false)
  const [updateLog, setUpdateLog] = useState<string[]>([])

  const client = useConnectionStore((s) => s.client)
  const addToast = useToastStore((s) => s.addToast)
  const sseRef = useRef<AbortController | null>(null)

  // Fetch initial data
  useEffect(() => {
    let cancelled = false

    Promise.all([
      fetch('/api/system/status').then((r) => r.json() as Promise<SystemStatus>),
      fetch('/api/system/openclaw-config').then((r) => r.json() as Promise<OpenClawConfig>),
    ])
      .then(([statusData, configData]) => {
        if (cancelled) return
        setStatus(statusData)
        setConfig(configData)
        setLoading(false)
      })
      .catch(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
      sseRef.current?.abort()
    }
  }, [])

  // Model change handler
  const handleModelChange = useCallback(
    async (model: string) => {
      try {
        const res = await fetch('/api/system/openclaw-config', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model }),
        })
        if (!res.ok) throw new Error(`Server returned ${res.status}`)

        // Update local state
        setConfig((prev) => {
          if (!prev) return prev
          return {
            ...prev,
            config: {
              ...prev.config,
              agents: {
                ...prev.config.agents,
                defaults: {
                  ...prev.config.agents?.defaults,
                  model: {
                    ...prev.config.agents?.defaults?.model,
                    primary: model,
                  },
                },
              },
            },
          }
        })

        addToast({ message: 'Default model updated', type: 'success' })

        // Best-effort hot reload via Gateway client. OpenClaw 2026.5.x's
        // config.patch requires the snapshot hash (from config.get), and the model
        // lives at agents.defaults.model.primary (the config-file shape used above),
        // not a bare top-level `model`.
        if (client) {
          try {
            const snapshot = await client.config.get()
            const baseHash = (snapshot['hash'] ?? snapshot['baseHash']) as string | undefined
            await client.config.patch(
              { agents: { defaults: { model: { primary: model } } } },
              baseHash,
            )
          } catch {
            // Hot reload failed — config file was still updated
          }
        }
      } catch (err) {
        addToast({
          message: `Failed: ${err instanceof Error ? err.message : 'Unknown error'}`,
          type: 'error',
        })
      }
    },
    [client, addToast],
  )

  // Check for updates handler
  const handleCheckUpdates = useCallback(() => {
    setUpdating(true)
    setUpdateLog([])

    sseRef.current?.abort()
    sseRef.current = consumeApiSSE(
      '/api/system/install-openclaw',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      },
      {
        onProgress: (e) => {
          if (e.message) setUpdateLog((prev) => [...prev, e.message!])
        },
        onOutput: (e) => {
          if (e.line) setUpdateLog((prev) => [...prev, e.line!])
        },
        onComplete: (e) => {
          setUpdating(false)
          if (e.success) {
            addToast({ message: `Updated to ${e.version ?? 'latest'}`, type: 'success' })
            // Refresh status to get new version
            void fetch('/api/system/status')
              .then((r) => r.json() as Promise<SystemStatus>)
              .then(setStatus)
          } else {
            addToast({ message: 'Update failed', type: 'error' })
          }
        },
        onError: (e) => {
          setUpdating(false)
          if (e.message) setUpdateLog((prev) => [...prev, `Error: ${e.message}`])
          addToast({ message: e.message ?? 'Update failed', type: 'error' })
        },
      },
    )
  }, [addToast])

  const currentModel = config?.config?.agents?.defaults?.model?.primary ?? null

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center gap-2 bg-background text-[13px] text-foreground/40">
        <Spinner size={18} />
        Loading system info...
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col bg-background text-foreground">
      <PanelHeader
        title="System"
        subtitle="Manage your OpenClaw installation"
        icon={Settings}
        actions={<GitHubStarButton />}
        border
      />

      {/* Scrollable body */}
      <div className="flex-1 overflow-y-auto px-6 py-5">
        <div className="mx-auto flex max-w-2xl flex-col gap-4">
          {/* Section 1: Gateway */}
          <SectionCard label="Gateway">
            <GatewayControls />
          </SectionCard>

          {/* Section 2: Default Model */}
          <SectionCard label="Default Model">
            <div className="flex items-center gap-3">
              <span className="text-[13px] text-foreground/50">Current:</span>
              <ModelSelector currentModel={currentModel} onModelChange={handleModelChange} />
            </div>
          </SectionCard>

          {/* Section 3: API Keys */}
          <SectionCard label="API Keys">
            <ApiKeyManager />
          </SectionCard>

          {/* Section 4: Boo Zero — universal team leader context. The actual
            editors moved out of System: Display Name + Global Brief now live
            in Boo Zero's agent "Brief" tab, and per-team brief + rules live in
            each team's settings sheet (gear icon on the team-chat header).
            This section is a breadcrumb to the new homes. */}
          <SectionCard label="Boo Zero" data-testid="boo-zero-briefs-section">
            <p className="-mt-1 mb-4 text-[12px] leading-relaxed text-foreground/45">
              Manage Boo Zero in the Boo Zero agent view, and per-team settings in each team&apos;s
              chat header.
            </p>
            <BooZeroBriefsPanel />
          </SectionCard>

          {/* Section 5: Agent Coordination */}
          <AgentCoordinationToggle />

          {/* Section 6: Command Approval */}
          <CommandApprovalDefault />

          {/* Section 7: System Info */}
          <SectionCard label="System Info">
            <div className="flex flex-col gap-2">
              <InfoRow label="OpenClaw" value={status?.openclaw.version ?? 'Not installed'} />
              <InfoRow label="Node.js" value={status?.node.version ?? null} />
              <InfoRow label="State Dir" value={status?.openclaw.stateDir ?? null} />
              <InfoRow
                label="Config"
                value={status?.openclaw.configExists ? 'openclaw.json' : 'Not found'}
              />
            </div>

            {/* Check for updates */}
            <div className="mt-4">
              <Button
                variant="secondary"
                size="sm"
                disabled={updating}
                loading={updating}
                onClick={handleCheckUpdates}
              >
                {!updating && <RefreshCw size={14} strokeWidth={2} />}
                {updating ? 'Updating...' : 'Check for Updates'}
              </Button>
            </div>

            {/* Update log */}
            {updateLog.length > 0 && (
              <div
                className="font-data mt-3 max-h-40 overflow-y-auto rounded-xl border border-border p-3 text-[11px] leading-relaxed"
                style={{ background: 'var(--terminal-bg)', color: 'rgba(201,209,217,0.72)' }}
              >
                {updateLog.map((line, i) => (
                  <div key={i}>{line}</div>
                ))}
              </div>
            )}
          </SectionCard>
        </div>
      </div>
    </div>
  )
}
