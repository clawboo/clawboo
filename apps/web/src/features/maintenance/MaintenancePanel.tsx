import { useEffect, useState, useCallback, useRef, type ReactNode } from 'react'
import { RefreshCw, Settings } from 'lucide-react'
import { useConnectionStore } from '@/stores/connection'
import { useToastStore } from '@/stores/toast'
import { consumeApiSSE } from '@clawboo/control-client'
import { GitHubStarButton } from '@/features/promo/GitHubStarButton'
import { PanelHeader } from '@/features/shared/PanelHeader'
import { Button } from '@/features/shared/Button'
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
  const [loading, setLoading] = useState(true)
  const [updating, setUpdating] = useState(false)
  const [updateLog, setUpdateLog] = useState<string[]>([])

  const addToast = useToastStore((s) => s.addToast)
  const sseRef = useRef<AbortController | null>(null)

  // Fetch initial data
  useEffect(() => {
    let cancelled = false

    fetch('/api/system/status')
      .then((r) => r.json() as Promise<SystemStatus>)
      .then((statusData) => {
        if (cancelled) return
        setStatus(statusData)
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
          {/* The OpenClaw Gateway process controls + the OpenClaw default-model
            picker moved onto the Runtimes → OpenClaw row (that runtime's home).
            Provider keys live in the Providers hub, Boo Zero + per-team settings
            in their own surfaces (the Boo Zero agent view + each team's chat
            header), and agent coordination is always on — the core of the product,
            not a togglable option. So none of those get a System-panel section. */}

          {/* Section 1: Command Approval */}
          <CommandApprovalDefault />

          {/* Section 2: System Info */}
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
