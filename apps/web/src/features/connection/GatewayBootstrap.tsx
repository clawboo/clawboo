/**
 * apps/web/src/features/connection/GatewayBootstrap.tsx
 *
 * Top-level connection orchestrator. Determines which overlay to render:
 *
 *   First-time user (no 'clawboo.onboarded' in localStorage)
 *     → OnboardingWizard (welcome → connect → team → deploy → done)
 *
 *   Returning user (key present), not connected
 *     → Auto-connect attempt using saved settings.
 *     → On failure → GatewayConnectScreen (quick reconnect modal)
 *
 *   After first-time onboarding completes
 *     → BooTip (floating "Click a Boo to start chatting" hint)
 *
 *   On connect: identifies Boo Zero, auto-migrates teamless agents.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { Loader2, RotateCcw } from 'lucide-react'
import { GatewayClient, resolveProxyGatewayUrl } from '@clawboo/gateway-client'
import type { DbApprovalHistory } from '@clawboo/db'
import { GatewayConnectScreen } from './GatewayConnectScreen'
import { OnboardingWizard } from '@/features/onboarding/OnboardingWizard'
import { BooTip } from '@/features/onboarding/BooTip'
import { useGatewayEvents } from './useGatewayEvents'
import { useConnectionStore } from '@/stores/connection'
import { useFleetStore } from '@/stores/fleet'
import { useApprovalsStore } from '@/stores/approvals'
import { useTeamStore } from '@/stores/team'
import { useBooZeroStore, identifyBooZero } from '@/stores/booZero'
import { hydrateTeams } from '@/lib/hydrateTeams'
import { consumeSSE } from '@/lib/sseClient'
import { fetchAgentModelMap } from '@/lib/agentModelMap'
import type { SystemInfo } from '@/stores/system'

// ─── Helpers ──────────────────────────────────────────────────────────────────

const ONBOARDED_KEY = 'clawboo.onboarded'

function isFirstTimeUser(): boolean {
  if (typeof window === 'undefined') return false
  return !localStorage.getItem(ONBOARDED_KEY)
}

function markOnboarded(): void {
  if (typeof window !== 'undefined') {
    localStorage.setItem(ONBOARDED_KEY, '1')
  }
}

/**
 * Auto-migrate teamless agents.
 * Case A: No teams exist → create "Default" team and assign all agents.
 * Case B: Teams exist but some agents have no team → assign them to the first team.
 */
async function autoMigrateTeamlessAgents(): Promise<void> {
  const storeTeams = useTeamStore.getState().teams
  const agents = useFleetStore.getState().agents
  if (agents.length === 0) return

  let targetTeamId: string

  if (storeTeams.length === 0) {
    // Case A: create a default team
    try {
      const res = await fetch('/api/teams', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Default', icon: '👻', color: '#E94560' }),
      })
      if (!res.ok) return
      const team = await res.json()
      targetTeamId = team.id

      useTeamStore.getState().addTeam({
        id: team.id,
        name: team.name,
        icon: team.icon,
        color: team.color,
        templateId: null,
        leaderAgentId: null,
        isArchived: false,
        agentCount: 0,
      })
      useTeamStore.getState().selectTeam(team.id)
    } catch {
      return
    }
  } else {
    const activeTeam = storeTeams.find((t) => !t.isArchived)
    if (!activeTeam) return // no active teams to assign to
    targetTeamId = activeTeam.id
  }

  // Exclude Boo Zero from team assignment — it should never belong to any team
  const booZeroId = useBooZeroStore.getState().booZeroAgentId

  // Cleanup: if Boo Zero was previously assigned to a team, remove it
  if (booZeroId) {
    const booZero = agents.find((a) => a.id === booZeroId)
    if (booZero?.teamId) {
      await fetch(`/api/teams/${booZero.teamId}/agents/${booZeroId}`, { method: 'DELETE' }).catch(
        () => {},
      )
      useFleetStore.setState((s) => ({
        agents: s.agents.map((a) => (a.id === booZeroId ? { ...a, teamId: null } : a)),
      }))
    }
  }

  // Find agents without a team assignment (excluding Boo Zero)
  const unassigned = agents.filter((a) => !a.teamId && a.id !== booZeroId)
  if (unassigned.length === 0) return

  // Assign each unassigned agent to the target team (upserts SQLite row)
  for (const agent of unassigned) {
    try {
      await fetch(`/api/teams/${targetTeamId}/agents`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId: agent.id, agentName: agent.name }),
      })
    } catch {
      // assignment failure is non-fatal
    }
  }

  // Patch fleet store with teamId for all unassigned agents
  const unassignedIds = new Set(unassigned.map((a) => a.id))
  useFleetStore.setState((s) => ({
    agents: s.agents.map((a) => (unassignedIds.has(a.id) ? { ...a, teamId: targetTeamId } : a)),
  }))

  // Update team agent count in team store
  useTeamStore.getState().updateTeam(targetTeamId, {
    agentCount: agents.filter((a) => a.teamId === targetTeamId || unassignedIds.has(a.id)).length,
  })
}

/** Fire-and-forget: pre-populate approval history from SQLite on connect. */
function preloadApprovalHistory(): void {
  fetch('/api/approvals')
    .then((r) => r.json())
    .then(({ records }: { records?: DbApprovalHistory[] }) => {
      if (records?.length) {
        useApprovalsStore.getState().hydrateHistory(records)
      }
    })
    .catch(() => {})
}

// ─── GatewayBootstrap ─────────────────────────────────────────────────────────

export function GatewayBootstrap() {
  const status = useConnectionStore((s) => s.status)
  const client = useConnectionStore((s) => s.client)
  const setClient = useConnectionStore((s) => s.setClient)
  const setStatus = useConnectionStore((s) => s.setStatus)
  const setGatewayUrl = useConnectionStore((s) => s.setGatewayUrl)
  const hydrateAgents = useFleetStore((s) => s.hydrateAgents)

  // null = not yet determined (avoids SSR/client localStorage mismatch)
  const [showWizard, setShowWizard] = useState<boolean | null>(null)

  useEffect(() => {
    // Fast path: localStorage says we're onboarded
    if (!isFirstTimeUser()) {
      setShowWizard(false)
      return
    }
    // Slow path: localStorage missing — check if system is already configured
    void (async () => {
      try {
        const resp = await fetch('/api/system/status')
        if (resp.ok) {
          const info = (await resp.json()) as SystemInfo
          if (info.openclaw.installed && info.openclaw.configExists && info.openclaw.envExists) {
            // System is fully configured — treat as returning user
            markOnboarded()
            setShowWizard(false)
            return
          }
        }
      } catch {
        // Status check failed — fall through to wizard
      }
      setShowWizard(true)
    })()
  }, [])

  // Post-onboarding Boo tip (only for first-time flow)
  const [showBooTip, setShowBooTip] = useState(false)

  // Fleet hydration error
  const [fleetError, setFleetError] = useState<string | null>(null)

  // Auto-connecting spinner for returning users
  const [autoConnecting, setAutoConnecting] = useState(false)

  // Gateway offline — OpenClaw installed & configured but Gateway not running
  const [gatewayOffline, setGatewayOffline] = useState(false)
  const [startingGateway, setStartingGateway] = useState(false)
  const [startGatewayError, setStartGatewayError] = useState<string | null>(null)
  const sseControllerRef = useRef<AbortController | null>(null)

  // Wire gateway events → Zustand stores
  useGatewayEvents(client)

  // ── Fleet hydration ────────────────────────────────────────────────────────

  const hydrateFleet = useCallback(
    async (liveClient: GatewayClient): Promise<number> => {
      setFleetError(null)
      try {
        const result = await liveClient.agents.list()
        const mainKey = result.mainKey?.trim() || 'main'
        // Preserve existing teamId assignments — Gateway doesn't know about teams
        const existingTeamIds = new Map(
          useFleetStore.getState().agents.map((a) => [a.id, a.teamId]),
        )
        // Load per-agent model overrides from openclaw.json
        const agentModels = await fetchAgentModelMap()
        const mapped = result.agents.map((a) => ({
          id: a.id,
          name: a.identity?.name ?? a.name ?? a.id,
          status: 'idle' as const,
          sessionKey: `agent:${a.id}:${mainKey}`,
          model: agentModels.get(a.id) ?? null,
          createdAt: null,
          streamingText: null,
          runId: null,
          lastSeenAt: null,
          teamId: existingTeamIds.get(a.id) ?? null,
        }))
        hydrateAgents(mapped)

        // Identify Boo Zero
        useBooZeroStore.getState().setBooZeroAgentId(identifyBooZero(mapped, result.defaultId))

        return result.agents.length
      } catch {
        setFleetError('Could not load your agent fleet. The Gateway may have restarted.')
        return -1
      }
    },
    [hydrateAgents],
  )

  // ── Returning-user connect handler (GatewayConnectScreen) ─────────────────

  const handleConnected = useCallback(
    async (newClient: GatewayClient) => {
      // Disconnect old client before replacing to avoid leaked WS listeners
      const prev = useConnectionStore.getState().client
      if (prev && prev !== newClient) prev.disconnect()

      setClient(newClient)
      await hydrateFleet(newClient)
      await hydrateTeams()
      await autoMigrateTeamlessAgents()
      preloadApprovalHistory()
    },
    [setClient, hydrateFleet],
  )

  // ── Auto-connect for returning users ───────────────────────────────────────
  // Fires once when showWizard is determined to be false (returning user).
  // System-aware: checks Gateway status before attempting WS connection.
  // On success: skips the connect form entirely.
  // On failure: falls through to GatewayConnectScreen or GatewayOffline overlay.

  useEffect(() => {
    if (showWizard !== false) return

    const tryAutoConnect = async () => {
      setAutoConnecting(true)
      try {
        // 1. Check system status first
        let gatewayRunning = true // optimistic default if status check fails
        try {
          const statusResp = await fetch('/api/system/status')
          if (statusResp.ok) {
            const systemInfo = (await statusResp.json()) as SystemInfo
            gatewayRunning = systemInfo.gateway.running

            // Gateway not running but OpenClaw is installed & configured
            // → show lightweight "Gateway Offline" overlay instead of full connect screen
            if (
              !gatewayRunning &&
              systemInfo.openclaw.installed &&
              systemInfo.openclaw.configExists
            ) {
              setGatewayOffline(true)
              return
            }
          }
        } catch {
          // Status check failed — proceed with optimistic auto-connect
        }

        // 2. If Gateway is running (or status unknown), try normal auto-connect
        const resp = await fetch('/api/settings')
        if (!resp.ok) return

        const data = (await resp.json()) as { gatewayUrl?: string; gatewayToken?: string }
        if (!data.gatewayUrl?.trim()) return

        // Disconnect old client before replacing to avoid leaked WS listeners
        const prev = useConnectionStore.getState().client
        if (prev) prev.disconnect()

        const autoClient = new GatewayClient()
        await autoClient.connect(resolveProxyGatewayUrl(), {
          clientName: 'openclaw-control-ui',
          clientVersion: '0.1.0',
          token: data.gatewayToken?.trim() || undefined,
          authScopeKey: data.gatewayUrl.trim(),
          disableDeviceAuth: true,
        })

        setStatus('connected')
        setGatewayUrl(data.gatewayUrl.trim())
        setClient(autoClient)

        await hydrateFleet(autoClient)
        await hydrateTeams()
        await autoMigrateTeamlessAgents()
        preloadApprovalHistory()
      } catch {
        // Auto-connect failed — GatewayConnectScreen renders as fallback
      } finally {
        setAutoConnecting(false)
      }
    }

    void tryAutoConnect()
    // showWizard is the only trigger; store setters are stable Zustand refs
  }, [showWizard])

  // ── Start Gateway from offline overlay ─────────────────────────────────────

  const handleStartGateway = useCallback(() => {
    setStartingGateway(true)
    setStartGatewayError(null)

    sseControllerRef.current?.abort()
    sseControllerRef.current = consumeSSE(
      '/api/system/gateway',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'start' }),
      },
      {
        onProgress() {},
        onOutput() {},
        async onComplete(event) {
          if (!event.success) {
            setStartingGateway(false)
            setStartGatewayError('Gateway started but reported failure')
            return
          }

          // Gateway is up — now auto-connect
          try {
            const resp = await fetch('/api/settings')
            const data = resp.ok
              ? ((await resp.json()) as { gatewayUrl?: string; gatewayToken?: string })
              : { gatewayUrl: 'ws://localhost:18789' }
            const url = data.gatewayUrl?.trim() || 'ws://localhost:18789'

            const prev = useConnectionStore.getState().client
            if (prev) prev.disconnect()

            const autoClient = new GatewayClient()
            await autoClient.connect(resolveProxyGatewayUrl(), {
              clientName: 'openclaw-control-ui',
              clientVersion: '0.1.0',
              disableDeviceAuth: true,
            })

            setStatus('connected')
            setGatewayUrl(url)
            setClient(autoClient)
            setGatewayOffline(false)
            setStartingGateway(false)

            await hydrateFleet(autoClient)
            await hydrateTeams()
            await autoMigrateTeamlessAgents()
            preloadApprovalHistory()
          } catch (err) {
            setStartingGateway(false)
            setStartGatewayError(
              err instanceof Error ? err.message : 'Failed to connect after starting Gateway',
            )
          }
        },
        onError(event) {
          setStartingGateway(false)
          setStartGatewayError((event.message as string) ?? 'Failed to start Gateway')
        },
      },
    )
  }, [setStatus, setGatewayUrl, setClient, hydrateFleet])

  // ── First-time onboarding complete handler ─────────────────────────────────

  const handleOnboardingComplete = useCallback(
    async (newClient: GatewayClient, url: string) => {
      markOnboarded()

      // Disconnect old client before replacing to avoid leaked WS listeners
      const prev = useConnectionStore.getState().client
      if (prev && prev !== newClient) prev.disconnect()

      // Surface the client to the rest of the app
      setStatus('connected')
      setGatewayUrl(url)
      setClient(newClient)

      // Hydrate fleet + teams (agents were just created by the wizard)
      await hydrateFleet(newClient)
      await hydrateTeams()

      // Show the "Click a Boo" tip after the wizard exits
      setShowBooTip(true)
    },
    [setStatus, setGatewayUrl, setClient, hydrateFleet],
  )

  const isConnected = status === 'connected'

  return (
    <>
      <AnimatePresence>
        {/* First-time onboarding wizard */}
        {!isConnected && showWizard === true && (
          <OnboardingWizard key="onboarding" onComplete={handleOnboardingComplete} />
        )}

        {/* Auto-connecting spinner — shown while we attempt a silent reconnect */}
        {!isConnected && showWizard === false && autoConnecting && (
          <motion.div
            key="auto-connecting"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="fixed inset-0 z-50 flex items-center justify-center bg-background/95 backdrop-blur-sm"
          >
            <div className="flex flex-col items-center gap-3">
              <Loader2 className="h-7 w-7 animate-spin text-accent" />
              <p className="font-mono text-[11px] text-secondary/50">Reconnecting…</p>
            </div>
          </motion.div>
        )}

        {/* Gateway offline — can auto-start */}
        {!isConnected && showWizard === false && !autoConnecting && gatewayOffline && (
          <motion.div
            key="gateway-offline"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="fixed inset-0 z-50 flex items-center justify-center bg-background/95 backdrop-blur-sm"
          >
            <motion.div
              initial={{ opacity: 0, y: 20, scale: 0.96 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              transition={{ type: 'spring', stiffness: 320, damping: 30 }}
              className="w-full max-w-[340px] rounded-2xl border border-white/8 bg-surface p-8 shadow-[0_24px_80px_rgba(0,0,0,0.6)]"
            >
              <div className="flex flex-col items-center gap-4 text-center">
                <img src="/logo.svg" alt="Clawboo" width={48} height={44} className="opacity-40" />
                <div>
                  <h2
                    className="text-[20px] font-bold text-text"
                    style={{ fontFamily: 'var(--font-display)' }}
                  >
                    Gateway Offline
                  </h2>
                  <p className="mt-1 text-[12px] text-secondary">
                    OpenClaw Gateway is not running. Start it to continue.
                  </p>
                </div>

                {/* Error */}
                <AnimatePresence initial={false}>
                  {startGatewayError && (
                    <motion.div
                      key="start-error"
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: 'auto' }}
                      exit={{ opacity: 0, height: 0 }}
                      transition={{ duration: 0.15 }}
                      className="w-full overflow-hidden"
                    >
                      <div
                        role="alert"
                        className="rounded-lg border border-destructive/20 bg-destructive/8 px-3 py-2 text-[12px] leading-snug text-destructive"
                      >
                        {startGatewayError}
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>

                <button
                  type="button"
                  onClick={handleStartGateway}
                  disabled={startingGateway}
                  className="flex h-11 w-full items-center justify-center gap-2 rounded-lg bg-accent font-mono text-[13px] font-semibold tracking-wide text-white shadow-sm transition hover:brightness-110 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {startingGateway ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" strokeWidth={2.5} />
                      Starting…
                    </>
                  ) : startGatewayError ? (
                    <>
                      <RotateCcw className="h-3.5 w-3.5" strokeWidth={2.5} />
                      Retry
                    </>
                  ) : (
                    'Start Gateway'
                  )}
                </button>

                <button
                  type="button"
                  onClick={() => setGatewayOffline(false)}
                  className="font-mono text-[11px] text-secondary/35 underline underline-offset-2 transition hover:text-secondary"
                >
                  Connect manually
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}

        {/* Returning-user quick reconnect modal — only shown when auto-connect is not in progress */}
        {!isConnected && showWizard === false && !autoConnecting && !gatewayOffline && (
          <GatewayConnectScreen key="reconnect" onConnected={handleConnected} />
        )}
      </AnimatePresence>

      {/* Fleet hydration error overlay */}
      <AnimatePresence>
        {isConnected && fleetError && (
          <motion.div
            key="fleet-error"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center bg-background/95 backdrop-blur-sm"
          >
            <div className="w-full max-w-[360px] rounded-2xl border border-white/8 bg-surface p-8 text-center shadow-[0_24px_80px_rgba(0,0,0,0.6)]">
              <p className="mb-4 text-[14px] font-medium text-destructive">{fleetError}</p>
              <div className="flex justify-center gap-3">
                <button
                  type="button"
                  onClick={() => {
                    setFleetError(null)
                    if (client) void hydrateFleet(client)
                  }}
                  className="rounded-lg bg-accent px-4 py-2 text-[13px] font-medium text-white"
                >
                  Retry
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setFleetError(null)
                    client?.disconnect()
                    setStatus('disconnected')
                  }}
                  className="rounded-lg border border-white/10 px-4 py-2 text-[13px] text-secondary"
                >
                  Reconnect
                </button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Post-onboarding "Click a Boo" tip — separate from the wizard stack */}
      <AnimatePresence>
        {showBooTip && <BooTip key="boo-tip" onDismiss={() => setShowBooTip(false)} />}
      </AnimatePresence>
    </>
  )
}
