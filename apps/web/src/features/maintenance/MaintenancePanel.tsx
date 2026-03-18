import { useEffect, useState, useCallback, useRef } from 'react'
import { Loader2 } from 'lucide-react'
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

      {/* Section 4: System Info */}
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
