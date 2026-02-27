'use client'

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
 *   Connected, fleet is empty (returning user only)
 *     → TeamPicker (deploy a team without going through full onboarding)
 *
 *   After first-time onboarding completes
 *     → BooTip (floating "Click a Boo to start chatting" hint)
 */

import { useCallback, useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { Loader2 } from 'lucide-react'
import { GatewayClient, resolveProxyGatewayUrl } from '@clawboo/gateway-client'
import type { DbApprovalHistory } from '@clawboo/db'
import { GatewayConnectScreen } from './GatewayConnectScreen'
import { OnboardingWizard } from '@/features/onboarding/OnboardingWizard'
import { BooTip } from '@/features/onboarding/BooTip'
import { useGatewayEvents } from './useGatewayEvents'
import { useConnectionStore } from '@/stores/connection'
import { useFleetStore } from '@/stores/fleet'
import { useApprovalsStore } from '@/stores/approvals'
import { TeamPicker } from '@/features/teams/TeamPicker'

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
    setShowWizard(isFirstTimeUser())
  }, [])

  // Post-onboarding Boo tip (only for first-time flow)
  const [showBooTip, setShowBooTip] = useState(false)

  // Returning-user empty-fleet picker
  const [showTeamPicker, setShowTeamPicker] = useState(false)

  // Auto-connecting spinner for returning users
  const [autoConnecting, setAutoConnecting] = useState(false)

  // Wire gateway events → Zustand stores
  useGatewayEvents(client)

  // ── Fleet hydration ────────────────────────────────────────────────────────

  const hydrateFleet = useCallback(
    async (liveClient: GatewayClient): Promise<number> => {
      try {
        const result = await liveClient.agents.list()
        const mainKey = result.mainKey?.trim() || 'main'
        hydrateAgents(
          result.agents.map((a) => ({
            id: a.id,
            name: a.identity?.name ?? a.name ?? a.id,
            status: 'idle' as const,
            sessionKey: `agent:${a.id}:${mainKey}`,
            model: null,
            createdAt: null,
            streamingText: null,
            runId: null,
          })),
        )
        return result.agents.length
      } catch {
        // Fleet will populate via presence/heartbeat events
        return 0
      }
    },
    [hydrateAgents],
  )

  // ── Returning-user connect handler (GatewayConnectScreen) ─────────────────

  const handleConnected = useCallback(
    async (newClient: GatewayClient) => {
      setClient(newClient)
      const agentCount = await hydrateFleet(newClient)
      if (agentCount === 0) {
        setShowTeamPicker(true)
      }
      // Pre-populate approval history from SQLite (best-effort)
      preloadApprovalHistory()
    },
    [setClient, hydrateFleet],
  )

  // ── Auto-connect for returning users ───────────────────────────────────────
  // Fires once when showWizard is determined to be false (returning user).
  // On success: skips the connect form entirely.
  // On failure: falls through to GatewayConnectScreen.

  useEffect(() => {
    if (showWizard !== false) return

    const tryAutoConnect = async () => {
      setAutoConnecting(true)
      try {
        const resp = await fetch('/api/settings')
        if (!resp.ok) return

        const data = (await resp.json()) as { gatewayUrl?: string; gatewayToken?: string }
        if (!data.gatewayUrl?.trim()) return

        const autoClient = new GatewayClient()
        await autoClient.connect(resolveProxyGatewayUrl(), {
          clientName: 'openclaw-control-ui',
          clientVersion: '0.0.0',
          token: data.gatewayToken?.trim() || undefined,
          authScopeKey: data.gatewayUrl.trim(),
        })

        setStatus('connected')
        setGatewayUrl(data.gatewayUrl.trim())
        setClient(autoClient)

        const agentCount = await hydrateFleet(autoClient)
        if (agentCount === 0) setShowTeamPicker(true)

        // Pre-populate approval history from SQLite (best-effort)
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

  // ── First-time onboarding complete handler ─────────────────────────────────

  const handleOnboardingComplete = useCallback(
    async (newClient: GatewayClient, url: string) => {
      markOnboarded()

      // Surface the client to the rest of the app
      setStatus('connected')
      setGatewayUrl(url)
      setClient(newClient)

      // Hydrate fleet (agents were just created by the wizard)
      await hydrateFleet(newClient)

      // Show the "Click a Boo" tip after the wizard exits
      setShowBooTip(true)
    },
    [setStatus, setGatewayUrl, setClient, hydrateFleet],
  )

  // ── Returning-user team picker handlers ────────────────────────────────────

  const handleTeamDeployed = useCallback(async () => {
    setShowTeamPicker(false)
    if (client) await hydrateFleet(client)
  }, [client, hydrateFleet])

  const handleSkipTeamPicker = useCallback(() => {
    setShowTeamPicker(false)
  }, [])

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

        {/* Returning-user quick reconnect modal — only shown when auto-connect is not in progress */}
        {!isConnected && showWizard === false && !autoConnecting && (
          <GatewayConnectScreen key="reconnect" onConnected={handleConnected} />
        )}

        {/* Empty-fleet team picker (returning users only) */}
        {isConnected && showTeamPicker && client && (
          <TeamPicker
            key="team-picker"
            client={client}
            onDeployed={() => void handleTeamDeployed()}
            onSkip={handleSkipTeamPicker}
          />
        )}
      </AnimatePresence>

      {/* Post-onboarding "Click a Boo" tip — separate from the wizard stack */}
      <AnimatePresence>
        {showBooTip && <BooTip key="boo-tip" onDismiss={() => setShowBooTip(false)} />}
      </AnimatePresence>
    </>
  )
}
