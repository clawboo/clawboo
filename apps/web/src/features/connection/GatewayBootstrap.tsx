/**
 * apps/web/src/features/connection/GatewayBootstrap.tsx
 *
 * Top-level connection orchestrator. Determines which overlay to render:
 *
 *   First-time user (no 'clawboo.onboarded' in localStorage)
 *     → OnboardingWizard (welcome → detect → [install → configure →
 *       startGateway] → team → deploy). When the wizard finishes with a
 *       deployed team, we navigate the user into that team's group chat;
 *       otherwise the user lands on the default view.
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
import {
  GatewayClient,
  GatewayResponseError,
  resolveProxyGatewayUrl,
} from '@clawboo/gateway-client'
import { syncBooZeroSoulIdentity } from '@/lib/booZeroIdentitySync'
import { pushAgentSync, refreshFleetFromRegistry } from '@/lib/agentSourceClient'
import type { DbApprovalHistory } from '@clawboo/db'
import { GatewayConnectScreen } from './GatewayConnectScreen'
import {
  OnboardingWizard,
  type WizardStep,
  type OnboardingMode,
  type SelectedRuntime,
} from '@/features/onboarding/OnboardingWizard'
import { BooTip } from '@/features/onboarding/BooTip'
import {
  isWizardActive,
  markWizardActive,
  clearWizardActive,
  getWizardRuntime,
  decideOnboardingView,
  type WizardRuntime,
} from '@/lib/onboardingProgress'
import { useGatewayEvents } from './useGatewayEvents'
import { useConnectionStore } from '@/stores/connection'
import { useFleetStore } from '@/stores/fleet'
import { useApprovalsStore } from '@/stores/approvals'
import { fetchExecConfigMap } from '@/lib/execConfigMap'
import { useTeamStore } from '@/stores/team'
import { useViewStore } from '@/stores/view'
import { useBooZeroStore, identifyBooZero } from '@/stores/booZero'
import { hydrateTeams } from '@/lib/hydrateTeams'
import { DEFAULT_COLLECTION_ID } from '@/lib/teamPalettes'
import { TEAM_ACCENT_PRESETS } from '@/features/teams/TeamAccentPicker'
import { consumeSSE } from '@/lib/sseClient'
import { fetchAgentModelMap } from '@/lib/agentModelMap'
import type { SystemInfo } from '@/stores/system'

// ─── Helpers ──────────────────────────────────────────────────────────────────

// `clawboo.onboarded` is set after the user successfully reaches a
// connected dashboard. It's a hint, NOT a source of truth — the actual
// gate is whether OpenClaw is installed + configured on disk. Browser
// localStorage survives uninstalling the npm package and clearing
// ~/.openclaw/, so it can't be trusted alone. See the useEffect below.
const ONBOARDED_KEY = 'clawboo.onboarded'

function markOnboarded(): void {
  if (typeof window !== 'undefined') {
    localStorage.setItem(ONBOARDED_KEY, '1')
  }
}

/** True when the SQLite registry holds at least one clawboo-native agent — the
 *  signal that the user set up native (Gateway-free) and should land in the
 *  dashboard on reload rather than re-running the wizard. Best-effort (REST). */
async function hasNativeAgents(): Promise<boolean> {
  try {
    const res = await fetch('/api/agents')
    if (!res.ok) return false
    const body = (await res.json()) as {
      agents?: { id?: string; runtime?: string; sourceId?: string }[]
    }
    return (body.agents ?? []).some(
      (a) =>
        a.runtime === 'clawboo-native' ||
        a.sourceId === 'clawboo-native' ||
        (a.id ?? '').startsWith('native-'),
    )
  } catch {
    return false
  }
}

/** True when a non-OpenClaw runtime (Claude Code / Codex / Hermes / native) has a
 *  VAULT-stored credential — the durable on-disk proof that a user DELIBERATELY
 *  connected during the coding-agent onboarding path (which seeds no native agent and
 *  no team). It reads `hasVaultCredential`, NOT `hasCredential`: the latter also counts
 *  an ambient `process.env` shell var, so a bare exported provider key + a stale
 *  `onboarded` flag would otherwise skip the wizard into native mode on a fresh box.
 *  `/api/runtimes` only lists non-OpenClaw runtimes, so OpenClaw is excluded by
 *  construction. Best-effort (REST). */
async function hasConnectedRuntime(): Promise<boolean> {
  try {
    const res = await fetch('/api/runtimes')
    if (!res.ok) return false
    const body = (await res.json()) as { runtimes?: { hasVaultCredential?: boolean }[] }
    return (body.runtimes ?? []).some((r) => r.hasVaultCredential === true)
  } catch {
    return false
  }
}

/** True when at least one team exists — the robust "returning user" signal
 *  (onboarding always deploys a team, so a completed user has ≥1). Used to
 *  rescue a returning user from a STALE `wizard.active` marker that a transient
 *  not-configured reading may have left set. */
async function hasAnyTeam(): Promise<boolean> {
  try {
    const res = await fetch('/api/teams')
    if (!res.ok) return false
    const body = (await res.json()) as { teams?: unknown[] } | unknown[]
    const teams = Array.isArray(body) ? body : (body.teams ?? [])
    return teams.length > 0
  } catch {
    return false
  }
}

/** The wizard step a mid-onboarding refresh resumes at, given the runtime the
 *  user had picked (persisted in localStorage). */
function resumeStepForRuntime(rt: WizardRuntime | null): WizardStep {
  if (rt === 'openclaw') return 'detect'
  if (rt === 'clawboo-native') return 'configureNative'
  if (rt === 'claude-code' || rt === 'hermes' || rt === 'codex') return 'connectAgents'
  return 'chooseRuntime'
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

  const activeTeam = storeTeams.find((t) => !t.isArchived)

  if (activeTeam) {
    // Case B: active team exists — assign unassigned agents to it
    targetTeamId = activeTeam.id
  } else {
    // Case A: no active teams (either empty or all archived) — create "Default" team
    try {
      const res = await fetch('/api/teams', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Default',
          icon: '👻',
          // Hex, never a CSS var — team.color is hex-alpha concatenated app-wide.
          color: TEAM_ACCENT_PRESETS[0],
          colorCollectionId: DEFAULT_COLLECTION_ID,
        }),
      })
      if (!res.ok) return
      const { team } = (await res.json()) as {
        team: { id: string; name: string; icon: string; color: string }
      }
      targetTeamId = team.id

      useTeamStore.getState().addTeam({
        id: team.id,
        name: team.name,
        icon: team.icon,
        color: team.color,
        colorCollectionId: DEFAULT_COLLECTION_ID,
        templateId: null,
        leaderAgentId: null,
        isArchived: false,
        agentCount: 0,
      })
      useTeamStore.getState().selectTeam(team.id)
    } catch {
      return
    }
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

/**
 * Enter the dashboard in NATIVE MODE — no OpenClaw Gateway. The native runtime
 * runs server-side and the registry-of-record is SQLite, so we mark the app
 * "connected" with a null client and hydrate everything over REST. Used by both
 * the native onboarding completion AND the reload path (a returning native user
 * must land in the dashboard, not the wizard / connect screen).
 *
 * Resolves `{ ok }`: `ok: false` means the registry hydrate failed (a transient
 * 5xx) and the app was NOT flipped to 'connected' — the caller surfaces a retry.
 * Exported for the unit test that drives the real `/api/agents` failure path.
 */
export async function enterNativeMode(teamId: string | null): Promise<{ ok: boolean }> {
  markOnboarded()
  clearWizardActive()

  const conn = useConnectionStore.getState()
  // Drop any stale Gateway client; native has none.
  const prev = conn.client
  if (prev) prev.disconnect()
  conn.setClient(null)
  conn.setGatewayUrl('')

  // Guarded REST hydrate BEFORE flipping to 'connected'. SQLite is the registry
  // of record so this normally succeeds, but a transient 5xx (the server
  // mid-restart) must not strand the user in a broken 'connected'-but-empty
  // state or escape as an unhandled rejection — `listAgents` throws on non-2xx.
  // We surface a retry instead (see the `nativeError` overlay).
  let ok = true
  try {
    await refreshFleetFromRegistry()
  } catch {
    ok = false
  }
  await hydrateTeams() // already best-effort (swallows)
  preloadApprovalHistory()

  if (!ok) {
    conn.setStatus('error')
    return { ok: false }
  }
  conn.setStatus('connected')

  // Land in the seeded team's group chat when we have one.
  if (teamId) {
    const exists = useTeamStore.getState().teams.some((t) => t.id === teamId)
    if (exists) {
      useTeamStore.getState().selectTeam(teamId)
      useViewStore.getState().openGroupChat(teamId)
    }
  }
  return { ok: true }
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
  // Native-mode hydration error (client-free). Declared before the reload
  // effect that sets it. Distinct from `fleetError`, whose Retry re-runs
  // `hydrateFleet(client)` — a no-op for native's null client. Set when
  // `enterNativeMode` resolves `{ ok: false }`.
  const [nativeError, setNativeError] = useState<string | null>(null)
  // Step the wizard re-enters at. 'welcome' for a fresh run; a later step when
  // resuming a mid-onboarding refresh (see the resume branch below).
  const [wizardInitialStep, setWizardInitialStep] = useState<WizardStep>('welcome')
  // Runtime the user had picked before a refresh (drives resume direction).
  const [wizardInitialRuntime, setWizardInitialRuntime] = useState<SelectedRuntime | null>(null)

  useEffect(() => {
    // ALWAYS verify system state. The previous "fast path" trusted the
    // `clawboo.onboarded` localStorage flag alone — but localStorage
    // persists by origin (localhost:18790), not by npm-package version.
    // A user who onboarded with an earlier clawboo + then uninstalled
    // OpenClaw would still have the flag set on next launch, and the
    // wizard would be skipped even though there's no OpenClaw to
    // connect to. That dumped users straight to "Connect to an OpenClaw
    // Gateway" with no way forward besides `Gateway closed (1011):
    // upstream error`.
    //
    // New rule: the on-disk system state is the source of truth. If
    // OpenClaw is installed AND configured, mark as onboarded (idempotent)
    // and skip the wizard. Otherwise clear the stale flag and show the
    // wizard so the user can re-install + reconfigure.
    void (async () => {
      const onboarded = typeof window !== 'undefined' && localStorage.getItem(ONBOARDED_KEY) === '1'
      const wizardActive = isWizardActive()

      // On-disk system state is the source of truth, so fetch it FIRST. A
      // TRANSIENT failure (e.g. the API mid-restart, a slow cold start) must NOT
      // be mistaken for "OpenClaw not configured" — that path used to clear
      // `onboarded` + arm `wizard.active`, and a fully-configured returning user
      // then got trapped in the wizard forever. `info === null` ⇒ transient.
      let info: SystemInfo | null = null
      try {
        const resp = await fetch('/api/system/status')
        if (resp.ok) info = (await resp.json()) as SystemInfo
      } catch {
        // Transient — `info` stays null; the decision preserves existing flags.
      }
      const statusKnown = info !== null
      const configured =
        !!info && info.openclaw.installed && info.openclaw.configExists && info.openclaw.envExists

      // Resolve the remaining inputs only where they matter (one extra GET, not
      // two): teams disambiguate a returning user from a genuine mid-onboarding
      // run; a native agent marks a returning Gateway-free user.
      const hasTeam = configured ? await hasAnyTeam() : false
      const hasNative = statusKnown && !configured ? await hasNativeAgents() : false
      // Only the "maybe-completed-coding-agent" case needs this extra GET: a
      // user who finished the wizard (`onboarded`) with no OpenClaw and no
      // native agent. A connected non-OpenClaw runtime credential confirms it.
      const hasConnected =
        onboarded && statusKnown && !configured && !hasNative ? await hasConnectedRuntime() : false

      const resumeWizard = (): void => {
        markWizardActive() // idempotent — keep the marker through the resume
        const runtime = getWizardRuntime()
        setWizardInitialRuntime(runtime)
        setWizardInitialStep(resumeStepForRuntime(runtime))
        setShowWizard(true)
      }

      switch (
        decideOnboardingView({
          onboarded,
          configured,
          statusKnown,
          wizardActive,
          hasTeam,
          hasNative,
          hasConnectedRuntime: hasConnected,
        })
      ) {
        case 'dashboard':
          markOnboarded()
          clearWizardActive() // returning user — no wizard run in flight
          setShowWizard(false)
          return
        case 'dashboard-transient':
          // Returning user + transient status failure — preserve flags; the
          // auto-connect effect / Gateway-offline overlay handles reconnection.
          setShowWizard(false)
          return
        case 'native': {
          const r = await enterNativeMode(null)
          setShowWizard(false)
          if (!r.ok) setNativeError('Could not load your workspace. The server may be restarting.')
          return
        }
        case 'wizard-fresh':
          // Definitively not configured — clear the stale flag + arm a fresh run.
          if (typeof window !== 'undefined') localStorage.removeItem(ONBOARDED_KEY)
          markWizardActive()
          setShowWizard(true)
          return
        case 'wizard-resume':
          resumeWizard()
          return
        case 'wizard-transient':
          // Transient + nothing known — show the wizard WITHOUT arming the
          // marker, so the next good load re-decides cleanly.
          setShowWizard(true)
          return
      }
    })().catch(() => {
      // Defense-in-depth: the branches above are individually guarded, so a
      // throw here is unexpected — never leave it as an unhandled rejection.
      setShowWizard(true)
    })
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
        // Browser-fallback sync driver: this is the ONE intentional direct
        // Gateway agent read left in the SPA. The registry-of-record is SQLite
        // (served by /api/agents), but on connect the browser warms it from its
        // own (proxy-approved) Gateway connection so a fresh install hydrates
        // even before the server's own connection syncs. See pushAgentSync below.
        const result = await liveClient.agents.list()
        const mainKey = result.mainKey?.trim() || 'main'
        // Preserve existing teamId assignments — Gateway doesn't know about teams
        const existingTeamIds = new Map(
          useFleetStore.getState().agents.map((a) => [a.id, a.teamId]),
        )
        // Load per-agent model overrides + exec configs in parallel
        const [agentModels, execConfigs] = await Promise.all([
          fetchAgentModelMap(),
          fetchExecConfigMap(),
        ])
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
          execConfig: execConfigs.get(a.id) ?? null,
        }))

        // Identify Boo Zero before applying the display-name override so
        // we know which agent's name to overlay.
        const booZeroId = identifyBooZero(mapped, result.defaultId)
        useBooZeroStore.getState().setBooZeroAgentId(booZeroId)

        // Clawboo-side display-name override for Boo Zero. The user's
        // Gateway agent name might be the literal slug "main" or a custom
        // name picked in OpenClaw onboarding. Clawboo's policy: lock the display name to
        // "Boo Zero" by default; user can change it anytime in the System
        // panel ("Boo Zero" section). The override lives in SQLite —
        // Gateway-side identity is never touched.
        //
        // First-connect behavior: if no override exists yet, we write
        // "Boo Zero" as the default so the chat header / identity anchor
        // / briefs all read consistently. Subsequent connects respect
        // whatever the user has saved.
        if (booZeroId) {
          let override = ''
          try {
            const res = await fetch(`/api/boo-zero/display-name/${encodeURIComponent(booZeroId)}`)
            if (res.ok) {
              const body = (await res.json()) as { name?: string | null }
              override = (body.name ?? '').trim()
            }
          } catch {
            // Best-effort.
          }
          // No override yet → seed with the Clawboo default "Boo Zero".
          // Skipped silently on fetch failure (the user can still see the
          // Gateway-side name; the next successful connect will seed).
          if (override.length === 0) {
            try {
              const seed = await fetch(
                `/api/boo-zero/display-name/${encodeURIComponent(booZeroId)}`,
                {
                  method: 'PUT',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ name: 'Boo Zero' }),
                },
              )
              if (seed.ok) override = 'Boo Zero'
            } catch {
              // Best-effort.
            }
          }
          if (override.length > 0) {
            for (const a of mapped) {
              if (a.id === booZeroId) a.name = override
            }
            // Auto-sync the display name into Boo Zero's SOUL.md. Idempotent
            // (no-op when the SOUL.md heading already matches). Best-effort —
            // the per-turn rules block in `lib/booZeroRules.ts` is the
            // authoritative anchor regardless of whether the sync sticks.
            // Fire-and-forget so a slow Gateway doesn't delay fleet hydration.
            void syncBooZeroSoulIdentity({
              agentId: booZeroId,
              displayName: override,
            })
          }
        }

        hydrateAgents(mapped)

        // Browser-fallback sync: push the freshly-fetched Gateway list to the
        // server so SQLite (the registry-of-record) stays warm even if the
        // server's OWN Gateway connection is degraded (e.g. NOT_PAIRED on a
        // fresh install while the browser's proxy connection is approved). The
        // server upserts Gateway-owned columns + archives absent agents, so this
        // also subsumes the old `cleanup-ghosts` sweep.
        if (result.agents.length > 0) {
          void pushAgentSync({
            defaultId: result.defaultId ?? '',
            mainKey,
            scope: result.scope ?? '',
            agents: result.agents as Array<{
              id: string
              name?: string
              identity?: Record<string, unknown>
            }>,
          })
        }

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
      // Native mode (or any path that already connected) needs no Gateway — the
      // reload native branch sets status='connected' with a null client.
      if (useConnectionStore.getState().status === 'connected') return
      // A native-mode hydrate FAILURE sets status='error' (+ surfaces the nativeError
      // retry overlay). Don't kick off a pointless Gateway auto-connect round-trip,
      // which would also flash the 'Reconnecting…' spinner on top of the error — the
      // retry overlay owns recovery from here.
      if (useConnectionStore.getState().status === 'error') return
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

        const data = (await resp.json()) as { gatewayUrl?: string }
        if (!data.gatewayUrl?.trim()) return

        // Disconnect old client before replacing to avoid leaked WS listeners
        const prev = useConnectionStore.getState().client
        if (prev) prev.disconnect()

        // No token here: the same-origin proxy injects the upstream token server-side,
        // so the browser never holds it (GET /api/settings returns only `hasToken`).
        const autoClient = new GatewayClient()
        await autoClient.connect(resolveProxyGatewayUrl(), {
          clientName: 'openclaw-control-ui',
          clientVersion: '0.1.0',
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
              ? ((await resp.json()) as { gatewayUrl?: string })
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
            // OpenClaw 2026.5+ rejects unapproved devices with NOT_PAIRED.
            // The GatewayConnectScreen has an in-product pairing flow — close
            // this overlay so the user lands there. Otherwise they see a raw
            // gateway error and have no obvious next action.
            if (err instanceof GatewayResponseError && err.code === 'NOT_PAIRED') {
              setGatewayOffline(false)
              setStartGatewayError(null)
              return
            }
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
    async (
      newClient: GatewayClient | null,
      url: string | null,
      teamId: string | null,
      mode: OnboardingMode,
    ) => {
      // Native path — no Gateway. Enter native mode (guarded REST hydrate, then
      // status=connected, null client) and land in the seeded team.
      if (mode === 'native' || !newClient) {
        const r = await enterNativeMode(teamId)
        setShowWizard(false)
        if (r.ok) setShowBooTip(true)
        else setNativeError('Could not load your workspace. The server may be restarting.')
        return
      }

      markOnboarded()
      // Wizard run finished — drop the in-progress marker so future refreshes
      // take the returning-user fast path instead of resuming the wizard.
      clearWizardActive()

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

      // Post-onboarding landing surface.
      //
      // When the user deployed a team, drop them straight into that team's
      // group chat — that's where their work starts (chat with the new
      // boos, walk through the onboarding gate). The default view store
      // initializes to `{ type: 'nav', view: 'graph' }` (Atlas), and
      // without this redirect a fresh-install user would land on an empty
      // Atlas wondering what to do next.
      //
      // We also select the team in the team store so the sidebar
      // highlights it and AgentListColumn shows its boos. If the team
      // doesn't appear in the hydrated list (rare — race between the
      // wizard's POST /api/teams and `hydrateTeams`), the welcome view
      // takes over and the user can pick the team manually.
      if (teamId) {
        const exists = useTeamStore.getState().teams.some((t) => t.id === teamId)
        if (exists) {
          useTeamStore.getState().selectTeam(teamId)
          useViewStore.getState().openGroupChat(teamId)
        }
      }

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
          <OnboardingWizard
            key="onboarding"
            onComplete={handleOnboardingComplete}
            initialStep={wizardInitialStep}
            initialRuntime={wizardInitialRuntime}
          />
        )}

        {/* Auto-connecting spinner — shown while we attempt a silent reconnect.
            Suppressed during a native-mode error so it never overlays the retry. */}
        {!isConnected && showWizard === false && autoConnecting && !nativeError && (
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
              className="surface-overlay-tier w-full max-w-[340px] rounded-2xl p-8"
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
                  className="flex h-11 w-full items-center justify-center gap-2 rounded-lg bg-accent font-mono text-[13px] font-semibold tracking-wide text-primary-foreground shadow-sm transition hover:brightness-110 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50"
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
        {!isConnected &&
          showWizard === false &&
          !autoConnecting &&
          !gatewayOffline &&
          !nativeError && <GatewayConnectScreen key="reconnect" onConnected={handleConnected} />}
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
            <div className="surface-overlay-tier w-full max-w-[360px] rounded-2xl p-8 text-center">
              <p className="mb-4 text-[14px] font-medium text-destructive">{fleetError}</p>
              <div className="flex justify-center gap-3">
                <button
                  type="button"
                  onClick={() => {
                    setFleetError(null)
                    if (client) void hydrateFleet(client)
                  }}
                  className="rounded-lg bg-accent px-4 py-2 text-[13px] font-medium text-primary-foreground"
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
                  className="rounded-lg border border-border px-4 py-2 text-[13px] text-secondary"
                >
                  Reconnect
                </button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Native-mode hydration error overlay — client-free Retry (re-runs
          `enterNativeMode`), distinct from the Gateway `fleetError` overlay. */}
      <AnimatePresence>
        {nativeError && (
          <motion.div
            key="native-error"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center bg-background/95 backdrop-blur-sm"
            data-testid="native-error"
          >
            <div className="surface-overlay-tier w-full max-w-[360px] rounded-2xl p-8 text-center">
              <p className="mb-4 text-[14px] font-medium text-destructive">{nativeError}</p>
              <button
                type="button"
                onClick={() => {
                  setNativeError(null)
                  void enterNativeMode(null).then((r) => {
                    if (!r.ok)
                      setNativeError('Could not load your workspace. The server may be restarting.')
                  })
                }}
                className="rounded-lg bg-accent px-4 py-2 text-[13px] font-medium text-primary-foreground"
              >
                Retry
              </button>
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
