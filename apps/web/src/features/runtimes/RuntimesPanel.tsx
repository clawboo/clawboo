import { useEffect, useState, useCallback } from 'react'
import { AnimatePresence } from 'framer-motion'
import { Cpu, Info, RefreshCw, ChevronDown } from 'lucide-react'

import { useConnectionStore } from '@/stores/connection'
import { GitHubStarButton } from '@/features/promo/GitHubStarButton'
import { Skeleton } from '@/features/shared/Skeleton'
import { StatusPill, type StatusTone } from '@/features/shared/StatusPill'
import {
  fetchRuntimes,
  recheckRuntime,
  type ConnectionState,
  type RuntimeClass,
  type RuntimeStatus,
} from '@/lib/runtimesClient'

import { RuntimeConnectionCard } from './RuntimeConnectionCard'
import { RuntimeDiagnosticsDrawer, type RuntimeDiagnosticsTarget } from './RuntimeDiagnosticsDrawer'
import { useRuntimeProbeStore } from './runtimeProbeStore'
import { RUNTIME_CATALOG, RUNTIME_ORDER, type RuntimeId } from './runtimeCatalog'

function connStatePill(state?: ConnectionState): { tone: StatusTone; label: string } {
  switch (state) {
    case 'ready':
      return { tone: 'success', label: 'Connected' }
    case 'needs-auth':
      return { tone: 'warning', label: 'Needs key' }
    case 'needs-login':
      return { tone: 'warning', label: 'Needs login' }
    case 'not-installed':
      return { tone: 'idle', label: 'Not installed' }
    default:
      return { tone: 'idle', label: 'Unknown' }
  }
}

const muted = (o: number) => `rgb(var(--foreground-rgb) / ${o})`

interface Capabilities {
  streaming?: boolean
  mcp?: boolean
  worktrees?: boolean
  resume?: boolean
  toolApproval?: boolean
  models?: string[]
}

interface OpenClawInfo {
  id: string
  participantKind?: string
  capabilities?: Capabilities
  health?: { ok: boolean; message?: string }
}

const CAP_KEYS: (keyof Capabilities)[] = ['streaming', 'mcp', 'worktrees', 'resume', 'toolApproval']

function CapChip({ label, on }: { label: string; on: boolean }) {
  return (
    <span
      className="font-mono"
      style={{
        fontSize: 9.5,
        fontWeight: 600,
        padding: '1px 6px',
        borderRadius: 5,
        color: on ? 'var(--mint)' : muted(0.3),
        background: on ? 'rgb(var(--mint-rgb) / 0.12)' : 'rgb(var(--foreground-rgb) / 0.03)',
        textDecoration: on ? 'none' : 'line-through',
      }}
    >
      {label}
    </span>
  )
}

function McpAttach({ runtimeId }: { runtimeId: string }) {
  const [open, setOpen] = useState(false)
  const [snippet, setSnippet] = useState<string | null>(null)
  const toggle = useCallback(async () => {
    const next = !open
    setOpen(next)
    if (next && snippet === null) {
      try {
        const r = await fetch(
          `/api/mcp/config?runtime=${encodeURIComponent(runtimeId)}&server=tasks&transport=http`,
        )
        const body = (await r.json()) as unknown
        setSnippet(r.ok ? JSON.stringify(body, null, 2) : 'Could not load attach config.')
      } catch {
        setSnippet('Could not load attach config.')
      }
    }
  }, [open, snippet, runtimeId])

  return (
    <div style={{ marginTop: 6 }}>
      <button
        type="button"
        onClick={() => void toggle()}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          fontSize: 10.5,
          fontWeight: 500,
          color: muted(0.5),
          background: 'transparent',
          border: 'none',
          cursor: 'pointer',
          padding: '2px 4px',
          marginLeft: -4,
          borderRadius: 6,
          transition: 'color var(--motion-fast), background var(--motion-fast)',
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.color = 'var(--foreground)'
          e.currentTarget.style.background = 'rgb(var(--foreground-rgb) / 0.05)'
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.color = muted(0.5)
          e.currentTarget.style.background = 'transparent'
        }}
      >
        <ChevronDown
          size={11}
          style={{
            transform: open ? 'rotate(0deg)' : 'rotate(-90deg)',
            transition: 'transform 0.15s',
          }}
        />{' '}
        MCP attach config
      </button>
      {open && (
        <div
          className="font-data"
          style={{
            marginTop: 4,
            fontSize: 10.5,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            background: 'var(--code-block-bg, rgb(var(--foreground-rgb) / 0.05))',
            borderRadius: 7,
            padding: '8px 10px',
            color: muted(0.7),
            maxHeight: 200,
            overflowY: 'auto',
          }}
        >
          {snippet ?? 'Loading…'}
        </div>
      )}
    </div>
  )
}

/** OpenClaw is always present (the Gateway runtime); its health = the live gateway
 *  connection. Rendered as a status row (no install/connect — it's the host). */
function OpenClawRow({ info, onDiagnostics }: { info: OpenClawInfo; onDiagnostics: () => void }) {
  const caps = info.capabilities ?? {}
  const ok = info.health?.ok ?? false
  return (
    <div
      data-testid="runtime-row-openclaw"
      className="surface-raised-tier"
      style={{ borderRadius: 12, padding: '13px 15px' }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
        <span
          aria-hidden
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 26,
            height: 26,
            borderRadius: 8,
            color: 'var(--mint)',
            background: 'rgb(var(--mint-rgb) / 0.14)',
            flexShrink: 0,
          }}
        >
          <Cpu size={15} />
        </span>
        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--foreground)' }}>openclaw</span>
        <span className="font-mono" style={{ fontSize: 10, color: muted(0.4) }}>
          {info.participantKind ?? 'agent'}
        </span>
        <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          <StatusPill
            tone={ok ? 'success' : 'error'}
            label={ok ? 'Healthy' : (info.health?.message ?? 'Unavailable')}
          />
          <button
            type="button"
            data-testid="runtime-openclaw-diagnostics"
            aria-label="OpenClaw diagnostics"
            onClick={onDiagnostics}
            className="shrink-0 rounded-md p-1 transition-colors hover:bg-foreground/[0.06]"
            style={{
              color: muted(0.45),
              border: 'none',
              background: 'transparent',
              cursor: 'pointer',
            }}
          >
            <Info size={14} />
          </button>
        </span>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginTop: 9 }}>
        {CAP_KEYS.map((k) => (
          <CapChip key={k} label={k} on={Boolean(caps[k])} />
        ))}
      </div>
      <McpAttach runtimeId={info.id} />
    </div>
  )
}

export function RuntimesPanel() {
  const connStatus = useConnectionStore((s) => s.status)
  const gatewayUrl = useConnectionStore((s) => s.gatewayUrl)
  const [statuses, setStatuses] = useState<RuntimeStatus[]>([])
  const [loaded, setLoaded] = useState(false)
  const [diagId, setDiagId] = useState<string | null>(null)

  // OpenClaw (the host) + the non-OpenClaw coding-agent runtimes.
  const runtimeCount = 1 + RUNTIME_ORDER.length

  // Each 8s poll appends a sample to the per-runtime probe ring buffer so the
  // diagnostics drawer can render a "last N checks" timeline (no server store).
  const refresh = useCallback(async () => {
    const next = await fetchRuntimes()
    setStatuses(next)
    setLoaded(true)
    const record = useRuntimeProbeStore.getState().record
    const ts = Date.now()
    for (const s of next)
      record(s.id, { ts, ok: s.health?.ok ?? false, message: s.health?.message })
    const conn = useConnectionStore.getState().status
    record('openclaw', { ts, ok: conn === 'connected', message: conn })
  }, [])

  useEffect(() => {
    void refresh()
    const id = setInterval(() => void refresh(), 8000)
    return () => clearInterval(id)
  }, [refresh])

  const openclaw: OpenClawInfo = {
    id: 'openclaw',
    participantKind: 'agent',
    capabilities: {
      streaming: true,
      mcp: false,
      worktrees: false,
      resume: true,
      toolApproval: true,
      models: [],
    },
    health: { ok: connStatus === 'connected', message: connStatus },
  }

  // Build the normalized diagnostics target for whichever runtime is selected.
  // The depth badge is DERIVED from capabilities.runtimeClass (OpenClaw is the
  // synthesized connected-substrate row, not in /api/runtimes).
  function buildTarget(id: string): RuntimeDiagnosticsTarget | null {
    if (id === 'openclaw') {
      const ok = connStatus === 'connected'
      return {
        id: 'openclaw',
        name: 'OpenClaw',
        runtimeClass: 'connected-substrate',
        statusTone: ok ? 'success' : 'warning',
        statusLabel: ok ? 'Connected' : 'Offline',
        health: { ok, message: connStatus },
        caps: openclaw.capabilities,
        gatewayUrl,
        connectionStatus: connStatus,
        docsUrl: 'https://github.com/openclaw/openclaw',
      }
    }
    const entry = RUNTIME_CATALOG[id as RuntimeId]
    if (!entry) return null
    const status = statuses.find((s) => s.id === id)
    const caps = status?.capabilities
    const runtimeClass: RuntimeClass = caps?.runtimeClass ?? 'wrapped-oneshot'
    const pill = connStatePill(status?.connectionState)
    return {
      id,
      name: status?.name ?? entry.name,
      runtimeClass,
      statusTone: pill.tone,
      statusLabel: pill.label,
      health: { ok: status?.health?.ok ?? false, message: status?.health?.message },
      docsUrl: status?.docsUrl ?? entry.docsUrl,
      caps,
      connectionState: status?.connectionState,
      installed: status?.installed,
      binPath: status?.binPath,
      authKind: status?.authKind ?? entry.authKind,
      envVar: status?.envVar ?? entry.envVar ?? null,
      hasCredential: status?.hasCredential,
      loginCommand: entry.loginCommand,
      models: caps?.models,
      contextWindowTokens: caps?.contextWindowTokens,
      nativeHome: caps?.nativeHome,
      nativeMemory: caps?.nativeMemory,
      nativeSkills: caps?.nativeSkills,
    }
  }

  const diagTarget = diagId ? buildTarget(diagId) : null

  async function handleDrawerRecheck(): Promise<void> {
    if (diagId === 'openclaw') {
      await refresh()
      return
    }
    if (!diagId) return
    const s = await recheckRuntime(diagId as RuntimeId)
    if (s) {
      setStatuses((prev) => prev.map((x) => (x.id === s.id ? s : x)))
      useRuntimeProbeStore
        .getState()
        .record(s.id, { ts: Date.now(), ok: s.health?.ok ?? false, message: s.health?.message })
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div
        style={{
          height: 44,
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '0 12px',
          borderBottom: '1px solid rgb(var(--foreground-rgb) / 0.06)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Cpu size={15} style={{ color: 'var(--mint)' }} />
          <span
            style={{
              fontSize: 13,
              fontWeight: 600,
              fontFamily: 'var(--font-display)',
              letterSpacing: '-0.01em',
              color: 'var(--foreground)',
            }}
          >
            Runtimes
          </span>
          <span
            className="font-data"
            style={{
              fontSize: 10,
              color: 'var(--primary)',
              background: 'rgb(var(--primary-rgb) / 0.12)',
              borderRadius: 20,
              padding: '2px 8px',
            }}
          >
            {runtimeCount} runtimes
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <button
            type="button"
            onClick={() => void refresh()}
            aria-label="Refresh"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              height: 30,
              padding: '0 11px',
              borderRadius: 7,
              fontSize: 12,
              fontWeight: 500,
              color: muted(0.6),
              background: 'transparent',
              border: '1px solid rgb(var(--foreground-rgb) / 0.1)',
              cursor: 'pointer',
              transition:
                'background var(--motion-fast), border-color var(--motion-fast), color var(--motion-fast)',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = 'rgb(var(--foreground-rgb) / 0.05)'
              e.currentTarget.style.borderColor = 'rgb(var(--foreground-rgb) / 0.2)'
              e.currentTarget.style.color = 'var(--foreground)'
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'transparent'
              e.currentTarget.style.borderColor = 'rgb(var(--foreground-rgb) / 0.1)'
              e.currentTarget.style.color = muted(0.6)
            }}
          >
            <RefreshCw size={12} /> Refresh
          </button>
          <GitHubStarButton />
        </div>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '16px 18px' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14, maxWidth: 720 }}>
          <OpenClawRow info={openclaw} onDiagnostics={() => setDiagId('openclaw')} />

          <div>
            <p style={{ fontSize: 11, color: muted(0.45), marginBottom: 8, lineHeight: 1.6 }}>
              Coding-agent runtimes — install + connect them here. They run server-side and execute
              board tasks alongside OpenClaw.
            </p>
            <div
              style={{
                display: 'grid',
                gap: 12,
                gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))',
              }}
            >
              {!loaded
                ? RUNTIME_ORDER.map((id) => <Skeleton key={id} height={150} radius={12} />)
                : RUNTIME_ORDER.map((id) => {
                    const entry = RUNTIME_CATALOG[id]
                    const status = statuses.find((s) => s.id === id)
                    return (
                      <div key={id} data-testid={`runtime-row-${id}`}>
                        <RuntimeConnectionCard
                          entry={entry}
                          status={status}
                          variant="panel"
                          onChanged={() => void refresh()}
                          onDiagnostics={() => setDiagId(id)}
                        />
                      </div>
                    )
                  })}
            </div>
          </div>
        </div>
      </div>

      <AnimatePresence>
        {diagTarget && (
          <RuntimeDiagnosticsDrawer
            target={diagTarget}
            onClose={() => setDiagId(null)}
            onRecheck={handleDrawerRecheck}
          />
        )}
      </AnimatePresence>
    </div>
  )
}
