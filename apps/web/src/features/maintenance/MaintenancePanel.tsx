import { useEffect, useState, useCallback, useRef, type CSSProperties } from 'react'
import { ChevronDown, Loader2 } from 'lucide-react'
import { GatewayControls } from './GatewayControls'
import { ModelSelector } from './ModelSelector'
import { ApiKeyManager } from './ApiKeyManager'
import { useConnectionStore } from '@/stores/connection'
import { useToastStore } from '@/stores/toast'
import { consumeSSE } from '@/lib/sseClient'

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

// ─── Section heading ────────────────────────────────────────────────────────

function SectionHeading({ children }: { children: string }) {
  return (
    <h2
      style={{
        fontSize: 14,
        fontWeight: 600,
        color: '#E8E8E8',
        margin: 0,
        fontFamily: 'var(--font-cabinet-grotesk, sans-serif)',
      }}
    >
      {children}
    </h2>
  )
}

// ─── Info row ────────────────────────────────────────────────────────────────

function InfoRow({ label, value }: { label: string; value: string | null }) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
      <span
        style={{
          fontSize: 11,
          color: 'rgba(232,232,232,0.4)',
          fontWeight: 500,
          minWidth: 100,
          flexShrink: 0,
        }}
      >
        {label}
      </span>
      <span
        style={{
          fontSize: 13,
          color: '#E8E8E8',
          fontFamily: 'var(--font-geist-mono, monospace)',
          wordBreak: 'break-all',
        }}
      >
        {value ?? '—'}
      </span>
    </div>
  )
}

// ─── Agent Coordination Toggle ───────────────────────────────────────────────

const toggleTrack: CSSProperties = {
  width: 36,
  height: 20,
  borderRadius: 10,
  border: '1px solid rgba(255,255,255,0.1)',
  cursor: 'pointer',
  position: 'relative',
  transition: 'background 0.15s',
  flexShrink: 0,
}

const toggleThumb: CSSProperties = {
  width: 14,
  height: 14,
  borderRadius: 7,
  background: '#E8E8E8',
  position: 'absolute',
  top: 2,
  transition: 'left 0.15s',
}

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
    <div style={{ margin: '24px 0 28px' }}>
      <SectionHeading>Agent Coordination</SectionHeading>
      <div
        style={{
          marginTop: 12,
          display: 'flex',
          alignItems: 'center',
          gap: 12,
        }}
      >
        <button
          type="button"
          onClick={handleToggle}
          disabled={toggling}
          aria-label="Toggle agent-to-agent coordination"
          style={{
            ...toggleTrack,
            background: enabled ? 'rgba(52,211,153,0.25)' : 'rgba(255,255,255,0.04)',
          }}
        >
          <div style={{ ...toggleThumb, left: enabled ? 18 : 2 }} />
        </button>
        <span style={{ fontSize: 12, color: 'rgba(232,232,232,0.6)' }}>
          {enabled
            ? 'Agents can delegate tasks to each other'
            : 'Agent-to-agent messaging disabled'}
        </span>
      </div>
      <p
        style={{
          marginTop: 8,
          fontSize: 11,
          color: 'rgba(232,232,232,0.3)',
          lineHeight: 1.5,
        }}
      >
        When enabled, agents can use routing defined in AGENTS.md to send messages to other agents
        via the Gateway&apos;s sessions_send tool.
      </p>
    </div>
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
    <div style={{ margin: '24px 0 28px' }}>
      <SectionHeading>Command Approval</SectionHeading>
      <div
        style={{
          marginTop: 12,
          display: 'flex',
          alignItems: 'center',
          gap: 12,
        }}
      >
        <span style={{ fontSize: 12, color: 'rgba(232,232,232,0.5)' }}>Default:</span>
        <div style={{ position: 'relative', flex: 1, maxWidth: 220 }}>
          <select
            value={execAsk}
            disabled={saving}
            onChange={(e) => void handleChange(e.target.value)}
            style={{
              width: '100%',
              padding: '7px 32px 7px 10px',
              borderRadius: 6,
              border: '1px solid rgba(255,255,255,0.08)',
              background: '#0A0E1A',
              color: '#E8E8E8',
              fontSize: 12,
              fontWeight: 500,
              fontFamily: 'inherit',
              cursor: saving ? 'default' : 'pointer',
              appearance: 'none',
              outline: 'none',
              opacity: saving ? 0.6 : 1,
            }}
          >
            {EXEC_ASK_OPTIONS.map((opt) => (
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
      </div>
      <p
        style={{
          marginTop: 6,
          fontSize: 10,
          color: 'rgba(232,232,232,0.3)',
          lineHeight: 1.4,
        }}
      >
        {selected.description}
      </p>
      <p
        style={{
          marginTop: 8,
          fontSize: 11,
          color: 'rgba(232,232,232,0.3)',
          lineHeight: 1.5,
        }}
      >
        Default for all agents — individual agents can override this in their settings (Personality
        tab → Execution Permissions).
      </p>
    </div>
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

        // Best-effort hot reload via Gateway client
        if (client) {
          try {
            await client.config.patch({ model })
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
    sseRef.current = consumeSSE(
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
      <div
        style={{
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#0A0E1A',
          color: 'rgba(232,232,232,0.4)',
        }}
      >
        <Loader2
          style={{ width: 20, height: 20, animation: 'spin 1s linear infinite', marginRight: 8 }}
        />
        Loading system info...
      </div>
    )
  }

  return (
    <div
      style={{
        height: '100%',
        overflowY: 'auto',
        background: '#0A0E1A',
        padding: '24px 28px',
        color: '#E8E8E8',
      }}
    >
      {/* Header */}
      <div style={{ marginBottom: 28 }}>
        <h1
          style={{
            fontSize: 22,
            fontWeight: 700,
            color: '#E8E8E8',
            margin: 0,
            fontFamily: 'var(--font-cabinet-grotesk, sans-serif)',
          }}
        >
          System
        </h1>
        <p style={{ fontSize: 12, color: 'rgba(232,232,232,0.45)', margin: '4px 0 0' }}>
          Manage your OpenClaw installation
        </p>
      </div>

      {/* Section 1: Gateway */}
      <div style={{ marginBottom: 28 }}>
        <SectionHeading>Gateway</SectionHeading>
        <div style={{ marginTop: 14 }}>
          <GatewayControls />
        </div>
      </div>

      <div style={{ borderTop: '1px solid rgba(255,255,255,0.05)' }} />

      {/* Section 2: Default Model */}
      <div style={{ margin: '24px 0 28px' }}>
        <SectionHeading>Default Model</SectionHeading>
        <div
          style={{
            marginTop: 12,
            display: 'flex',
            alignItems: 'center',
            gap: 12,
          }}
        >
          <span style={{ fontSize: 12, color: 'rgba(232,232,232,0.5)' }}>Current:</span>
          <ModelSelector currentModel={currentModel} onModelChange={handleModelChange} />
        </div>
      </div>

      <div style={{ borderTop: '1px solid rgba(255,255,255,0.05)' }} />

      {/* Section 3: API Keys */}
      <div style={{ margin: '24px 0 28px' }}>
        <SectionHeading>API Keys</SectionHeading>
        <div style={{ marginTop: 10 }}>
          <ApiKeyManager />
        </div>
      </div>

      <div style={{ borderTop: '1px solid rgba(255,255,255,0.05)' }} />

      {/* Section 4: Agent Coordination */}
      <AgentCoordinationToggle />

      <div style={{ borderTop: '1px solid rgba(255,255,255,0.05)' }} />

      {/* Section 5: Command Approval */}
      <CommandApprovalDefault />

      <div style={{ borderTop: '1px solid rgba(255,255,255,0.05)' }} />

      {/* Section 6: System Info */}
      <div style={{ margin: '24px 0 28px' }}>
        <SectionHeading>System</SectionHeading>
        <div style={{ marginTop: 14, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <InfoRow label="OpenClaw" value={status?.openclaw.version ?? 'Not installed'} />
          <InfoRow label="Node.js" value={status?.node.version ?? null} />
          <InfoRow label="State Dir" value={status?.openclaw.stateDir ?? null} />
          <InfoRow
            label="Config"
            value={status?.openclaw.configExists ? 'openclaw.json' : 'Not found'}
          />
        </div>

        {/* Check for updates */}
        <div style={{ marginTop: 16 }}>
          <button
            type="button"
            disabled={updating}
            onClick={handleCheckUpdates}
            style={{
              height: 32,
              padding: '0 14px',
              fontSize: 11,
              fontWeight: 600,
              borderRadius: 8,
              border: '1px solid rgba(255,255,255,0.1)',
              background: updating ? 'rgba(255,255,255,0.04)' : 'rgba(255,255,255,0.06)',
              color: updating ? 'rgba(232,232,232,0.4)' : 'rgba(232,232,232,0.7)',
              cursor: updating ? 'default' : 'pointer',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              transition: 'all 0.15s',
            }}
          >
            {updating && (
              <Loader2 style={{ width: 12, height: 12, animation: 'spin 1s linear infinite' }} />
            )}
            {updating ? 'Updating...' : 'Check for Updates'}
          </button>
        </div>

        {/* Update log */}
        {updateLog.length > 0 && (
          <div
            style={{
              marginTop: 12,
              background: 'rgba(255,255,255,0.03)',
              border: '1px solid rgba(255,255,255,0.06)',
              borderRadius: 8,
              padding: '10px 12px',
              maxHeight: 160,
              overflowY: 'auto',
              fontFamily: 'var(--font-geist-mono, monospace)',
              fontSize: 11,
              lineHeight: 1.6,
              color: 'rgba(232,232,232,0.55)',
            }}
          >
            {updateLog.map((line, i) => (
              <div key={i}>{line}</div>
            ))}
          </div>
        )}
      </div>

      {/* CSS for Loader2 spin */}
      <style>{`
        @keyframes spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  )
}
