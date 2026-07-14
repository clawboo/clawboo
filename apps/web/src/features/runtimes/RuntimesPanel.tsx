import { useEffect, useState, useCallback } from 'react'
import { AnimatePresence } from 'framer-motion'
import { Cpu, RefreshCw, ChevronDown } from 'lucide-react'

import { useConnectionStore } from '@/stores/connection'
import { useSettingsModalStore } from '@/stores/settingsModal'
import { GitHubStarButton } from '@/features/promo/GitHubStarButton'
import { Button } from '@/features/shared/Button'
import { PanelHeader } from '@/features/shared/PanelHeader'
import { type StatusTone } from '@/features/shared/StatusPill'
import {
  fetchRegistryHealth,
  fetchRuntimes,
  recheckRuntime,
  type ConnectionState,
  type RuntimeClass,
  type RuntimeStatus,
} from '@clawboo/control-client'

import { RuntimeConnectList } from './RuntimeConnectList'
import { OpenClawInlineSetup } from './OpenClawInlineSetup'
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

interface Capabilities {
  streaming?: boolean
  mcp?: boolean
  worktrees?: boolean
  resume?: boolean
  toolApproval?: boolean
  models?: string[]
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
        aria-expanded={open}
        aria-controls={`mcp-attach-${runtimeId}`}
        className="text-foreground/50 transition-colors hover:text-foreground hover:bg-foreground/[0.05]"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          fontSize: 10.5,
          fontWeight: 500,
          background: 'transparent',
          border: 'none',
          cursor: 'pointer',
          padding: '2px 4px',
          marginLeft: -4,
          borderRadius: 6,
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
          id={`mcp-attach-${runtimeId}`}
          className="font-mono"
          style={{
            marginTop: 6,
            fontSize: 12,
            lineHeight: 1.6,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            background: 'var(--terminal-bg)',
            borderRadius: 12,
            padding: '12px 14px',
            color: 'rgb(201 209 217 / 0.85)',
            maxHeight: 220,
            overflowY: 'auto',
          }}
        >
          {snippet ?? 'Loading…'}
        </div>
      )}
    </div>
  )
}

export function RuntimesPanel() {
  const connStatus = useConnectionStore((s) => s.status)
  const gatewayUrl = useConnectionStore((s) => s.gatewayUrl)
  // The app is "connected" in NATIVE mode too (status='connected', client=null),
  // but OpenClaw itself is only connected when a live Gateway client is present.
  // Gate the OpenClaw tab's health + the "Set up OpenClaw" CTA on the client, not
  // the app status — otherwise a native-first user (the P7 target) would see the
  // OpenClaw tab as "Healthy" with no way to add OpenClaw.
  const client = useConnectionStore((s) => s.client)
  // Thin-client parity: a client pointed at a remote server has no browser Gateway
  // WS, so `client` is null even when OpenClaw is set up and the server's operator
  // connection is live. OR the browser signal with the server's registry health
  // (its `.source` IS the OpenClawAgentSource) so a thin client reads OpenClaw's
  // real reachability. Additive — the current web app (client present) is unchanged.
  const [serverOpenclawConnected, setServerOpenclawConnected] = useState(false)
  const openclawConnected =
    (connStatus === 'connected' && client !== null) || serverOpenclawConnected
  const openclawMessage = openclawConnected
    ? 'connected'
    : connStatus === 'connected'
      ? 'not connected'
      : connStatus
  const [statuses, setStatuses] = useState<RuntimeStatus[]>([])
  const [loaded, setLoaded] = useState(false)
  const [diagId, setDiagId] = useState<string | null>(null)
  // The standalone OpenClaw setup flow (detect → install → configure → start),
  // launched from the OpenClaw tab's "Set up OpenClaw" CTA when not connected.
  const [setupOpen, setSetupOpen] = useState(false)

  // A one-shot intent from elsewhere (a disabled OpenClaw option in CreateTeamModal)
  // lands the user here directly in the OpenClaw Gateway setup flow.
  const runtimeIntent = useSettingsModalStore((s) => s.runtimeIntent)
  const clearRuntimeIntent = useSettingsModalStore((s) => s.clearRuntimeIntent)
  useEffect(() => {
    if (runtimeIntent === 'connect-openclaw') {
      setSetupOpen(true)
      clearRuntimeIntent()
    }
  }, [runtimeIntent, clearRuntimeIntent])

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
    // The server's OpenClaw operator connection — the thin-client signal (no
    // browser Gateway WS needed). Defensive: disconnected on any error.
    const health = await fetchRegistryHealth()
    const srvConn = health.connection === 'connected'
    setServerOpenclawConnected(srvConn)
    const conn = useConnectionStore.getState()
    const ocOk = (conn.status === 'connected' && conn.client !== null) || srvConn
    record('openclaw', {
      ts,
      ok: ocOk,
      message: ocOk ? 'connected' : conn.status === 'connected' ? 'not connected' : conn.status,
    })
  }, [])

  useEffect(() => {
    void refresh()
    const id = setInterval(() => void refresh(), 8000)
    return () => clearInterval(id)
  }, [refresh])

  const openclawCaps: Capabilities = {
    streaming: true,
    mcp: false,
    worktrees: false,
    resume: true,
    toolApproval: true,
    models: [],
  }

  // Build the normalized diagnostics target for whichever runtime is selected.
  // The depth badge is DERIVED from capabilities.runtimeClass (OpenClaw is the
  // synthesized connected-substrate tab, not in /api/runtimes).
  function buildTarget(id: string): RuntimeDiagnosticsTarget | null {
    if (id === 'openclaw') {
      const ok = openclawConnected
      return {
        id: 'openclaw',
        name: 'OpenClaw',
        runtimeClass: 'connected-substrate',
        statusTone: ok ? 'success' : 'warning',
        statusLabel: ok ? 'Connected' : 'Offline',
        health: { ok, message: openclawMessage },
        caps: openclawCaps,
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
      <PanelHeader
        title="Runtimes"
        subtitle={`${runtimeCount} runtimes · OpenClaw + coding agents`}
        icon={Cpu}
        border
        actions={
          <>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void refresh()}
              aria-label="Refresh"
            >
              <RefreshCw size={14} strokeWidth={2} /> Refresh
            </Button>
            <GitHubStarButton />
          </>
        }
      />

      <div style={{ flex: 1, overflowY: 'auto' }} className="px-6 py-5">
        <div style={{ maxWidth: 720 }}>
          {/* One connect LIST (shared with onboarding). Each row carries a
              diagnostics button; OpenClaw setup runs IN-PLACE in its row. */}
          <RuntimeConnectList
            runtimeIds={RUNTIME_ORDER}
            statuses={statuses}
            loaded={loaded}
            variant="panel"
            onChanged={refresh}
            onDiagnostics={(id) => setDiagId(id)}
            openclaw={{
              connected: openclawConnected,
              statusLabel: openclawConnected ? 'Healthy' : (openclawMessage || 'Unavailable'),
              onSetup: () => setSetupOpen(true),
              setupTestId: 'runtime-openclaw-setup',
              onDiagnostics: () => setDiagId('openclaw'),
              extra: <McpAttach runtimeId="openclaw" />,
              setupOpen,
              setupContent: (
                <OpenClawInlineSetup
                  onFinish={() => {
                    setSetupOpen(false)
                    void refresh()
                  }}
                  onCancel={() => setSetupOpen(false)}
                />
              ),
            }}
          />
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
