/**
 * apps/web/src/features/onboarding/OnboardingWizard.tsx
 *
 * First-time onboarding wizard. The first real choice is "How do you want your
 * agents to run?":
 *   Welcome → ChooseRuntime →
 *     · Native    → ConfigureNative → NativeReady  (paste a key, seed a team)
 *     · OpenClaw  → Detect → [Install → Configure → StartGateway] →
 *                   ConnectAgents → Team → Deploy
 *     · Claude Code / Hermes / Codex → ConnectAgents → … (the runtime connect flow)
 *
 * Only shown when localStorage('clawboo.onboarded') is absent.
 *
 * Calls onComplete(client, url, teamId, mode) when the chosen path finishes.
 * `mode` is 'gateway' (a live GatewayClient) or 'native' (Gateway-free; client
 * + url are null). `teamId` lands the user in that team's group chat.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { ArrowRight, Check, Eye, EyeOff, Loader2, X } from 'lucide-react'
import {
  GatewayClient,
  formatGatewayError,
  isLocalGatewayUrl,
  resolveProxyGatewayUrl,
} from '@clawboo/gateway-client'
import { BooAvatar } from '@clawboo/ui'
import type { ProfileLike, TeamProfile } from '@/features/teams/types'
import { createAgent } from '@/lib/createAgent'
import { computeDedupSuffix, rewriteAgentsMd, rewriteTemplateName } from '@/lib/deployDedup'
import { buildClawbooHelpDoc, buildTeamAgentsMd } from '@/lib/teamProtocol'
import { detectGenuineLeader, matchedLeadershipKeyword } from '@/lib/genuineLeader'
import { buildTeamBrief, type TeamBriefMember } from '@/lib/booZeroBrief'
import { useBooZeroStore } from '@/stores/booZero'
import { mergeSoulWithPersonality, type PersonalityValues } from '@/lib/soulPersonality'
import {
  DetectStep,
  InstallStep,
  ConfigureStep,
  StartGatewayStep,
  ConnectAgentsStep,
  ChooseRuntimeStep,
  ConfigureNativeStep,
  NativeReadyStep,
} from './steps'
import { setWizardRuntime, type WizardRuntime } from '@/lib/onboardingProgress'
import { StepIndicator } from './StepIndicator'
import { useFocusTrap } from './useFocusTrap'
import { SkyAtmosphere } from '@/features/atmosphere'
import { STARTER_TEMPLATES, resolveTeamAgents } from '@/features/marketplace/teamCatalog'
import { useFleetStore } from '@/stores/fleet'
import { useTeamStore } from '@/stores/team'

// ─── Profiles ─────────────────────────────────────────────────────────────────

const PROFILES: ProfileLike[] = STARTER_TEMPLATES

// ─── Types ────────────────────────────────────────────────────────────────────

export type WizardStep =
  | 'welcome'
  | 'chooseRuntime'
  | 'configureNative'
  | 'nativeReady'
  | 'detect'
  | 'install'
  | 'configure'
  | 'startGateway'
  | 'connectAgents'
  | 'connect'
  | 'team'
  | 'deploy'

const STEP_INDEX: Record<WizardStep, number> = {
  welcome: 0,
  // The first real choice: "How do you want your agents to run?"
  chooseRuntime: 1,
  // Native path — paste a provider key → seed a team → land in the dashboard.
  configureNative: 2,
  nativeReady: 3,
  // OpenClaw / coding-agent paths (the existing gateway flow + the runtime connect).
  detect: 4,
  install: 5,
  configure: 6,
  startGateway: 7,
  connectAgents: 8,
  connect: 9,
  team: 10,
  deploy: 11,
}

/**
 * Escape steps BACK to the prior step in the chosen path. Onboarding is a
 * mandatory first-run flow with no "empty app" to dismiss to, so Escape never
 * unmounts the wizard — it just retreats one step. Steps absent from this map
 * (welcome, chooseRuntime, and the nativeReady success landing) ignore Escape.
 */
const BACK_STEP: Partial<Record<WizardStep, WizardStep>> = {
  configureNative: 'chooseRuntime',
  detect: 'chooseRuntime',
  install: 'detect',
  configure: 'detect',
  startGateway: 'configure',
  connectAgents: 'chooseRuntime',
  connect: 'detect',
  team: 'connectAgents',
  deploy: 'team',
}

/** The runtime the user picked on the chooseRuntime step. */
export type SelectedRuntime = WizardRuntime

/** How the wizard finished: a connected OpenClaw Gateway, or a Gateway-free
 *  native install (no GatewayClient). */
export type OnboardingMode = 'gateway' | 'native'

export type OnboardingWizardProps = {
  /**
   * Called when the wizard finishes. `mode` distinguishes the two endings:
   *   - `gateway` — a connected OpenClaw Gateway; `client` is the live
   *     GatewayClient and `gatewayUrl` its URL.
   *   - `native` — a Gateway-free native install; `client` + `gatewayUrl` are
   *     null (native agents run server-side, no Gateway).
   * `teamId` is the id of the team the user just deployed / seeded (or null
   * when they skipped the team step). The host (`GatewayBootstrap`) uses it to
   * navigate into the team's group chat; otherwise the user lands on Atlas.
   */
  onComplete: (
    client: GatewayClient | null,
    gatewayUrl: string | null,
    teamId: string | null,
    mode: OnboardingMode,
  ) => void
  /**
   * Step to start at. Defaults to 'welcome' for a fresh run. The host passes a
   * later step when RESUMING a mid-onboarding refresh.
   */
  initialStep?: WizardStep
  /** Runtime the user had picked before a refresh (drives resume direction). */
  initialRuntime?: SelectedRuntime | null
}

// ─── Motion transition ────────────────────────────────────────────────────────

const stepTransition = { type: 'spring', stiffness: 320, damping: 30 } as const

// ─── Card wrapper (for modal steps) ───────────────────────────────────────────

function WizardCard({
  children,
  wide = false,
  className = '',
}: {
  children: React.ReactNode
  wide?: boolean
  className?: string
}) {
  return (
    <div
      className={[
        'surface-overlay-tier w-full rounded-2xl',
        wide ? 'max-w-4xl' : 'max-w-[420px]',
        className,
      ].join(' ')}
    >
      {children}
    </div>
  )
}

// ─── Step 0: Welcome ──────────────────────────────────────────────────────────

function WelcomeStep({ onContinue }: { onContinue: () => void }) {
  return (
    <div
      className="absolute inset-0 flex flex-col items-center justify-center overflow-hidden"
      style={{ background: '#8fb9ee' }}
    >
      {/* Calm Day sky with drifting clouds. Theme-independent — the welcome is
          always the bright Day sky regardless of the app's light/dark
          preference (one consistent, calm entry screen). */}
      <SkyAtmosphere />

      <div className="relative z-10 flex flex-col items-center gap-7 px-6 text-center max-w-md">
        {/* Animated ghost */}
        <div className="relative">
          <motion.div
            className="pointer-events-none absolute inset-0 rounded-full blur-3xl"
            style={{ background: 'rgb(var(--primary-rgb) / 0.18)' }}
            animate={{ opacity: [0.5, 0.9, 0.5], scale: [0.9, 1.1, 0.9] }}
            transition={{ duration: 3.5, repeat: Infinity, ease: 'easeInOut' }}
          />
          <motion.div
            className="relative select-none"
            animate={{ y: [0, -14, 0] }}
            transition={{ duration: 3.2, repeat: Infinity, ease: 'easeInOut' }}
          >
            <img src="/logo.svg" alt="Clawboo" width={84} height={77} />
          </motion.div>
        </div>

        {/* Wordmark */}
        <div className="flex flex-col items-center gap-2">
          <h1
            className="text-[54px] font-bold tracking-tight leading-none"
            style={{
              fontFamily: 'var(--font-display)',
              // Pinned dark — the Day sky is always light, so the wordmark stays
              // dark regardless of the app theme; white halo lifts it off clouds.
              color: 'rgb(30,37,64)',
              textShadow: '0 2px 30px rgba(255,255,255,0.7), 0 1px 2px rgba(255,255,255,0.8)',
            }}
          >
            Clawboo
          </h1>
          <p
            className="text-[21px] font-light tracking-wide"
            style={{ color: 'rgba(30,37,64,0.8)', textShadow: '0 1px 14px rgba(255,255,255,0.7)' }}
          >
            Your AI agents, visible.
          </p>
          <p
            className="text-[13px] mt-1 leading-relaxed"
            style={{
              color: 'rgba(30,37,64,0.68)',
              textShadow: '0 1px 12px rgba(255,255,255,0.65)',
            }}
          >
            Deploy and orchestrate your AI agent teams.
            <br />
            Set up in under 90 seconds.
          </p>
        </div>

        {/* CTA */}
        <motion.button
          type="button"
          onClick={onContinue}
          whileHover={{ scale: 1.04 }}
          whileTap={{ scale: 0.97 }}
          className="flex items-center gap-2.5 h-[52px] px-9 rounded-xl bg-accent font-semibold text-[15px] text-primary-foreground shadow-[0_0_36px_rgb(var(--primary-rgb) / 0.45)] transition hover:brightness-110 active:scale-[0.98]"
        >
          Get Started
          <ArrowRight className="h-4 w-4" strokeWidth={2.5} />
        </motion.button>

        <p
          className="text-[11px] font-mono -mt-2"
          style={{ color: 'rgba(30,37,64,0.62)', textShadow: '0 1px 10px rgba(255,255,255,0.65)' }}
        >
          Paste an API key, or bring your own runtime
        </p>
      </div>
    </div>
  )
}

// ─── Step 1: Connect ──────────────────────────────────────────────────────────

const DEFAULT_GATEWAY_URL = 'ws://localhost:18789'

function ConnectStep({
  onConnected,
}: {
  onConnected: (client: GatewayClient, url: string) => void
}) {
  const [url, setUrl] = useState(DEFAULT_GATEWAY_URL)
  const [token, setToken] = useState('')
  const [showToken, setShowToken] = useState(false)
  const [connecting, setConnecting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const clientRef = useRef<GatewayClient | null>(null)

  // Pre-fill from persisted settings (in case user ran npx clawboo first)
  useEffect(() => {
    fetch('/api/settings')
      .then((r) => r.json() as Promise<{ gatewayUrl?: string; hasToken?: boolean }>)
      .then((data) => {
        if (data.gatewayUrl?.trim()) setUrl(data.gatewayUrl.trim())
        if (data.hasToken) setToken('••••••••')
      })
      .catch(() => {})
  }, [])

  const handleConnect = useCallback(async () => {
    const trimmedUrl = url.trim()
    if (!trimmedUrl || connecting) return

    const trimmedToken = token === '••••••••' ? '' : token.trim()

    setConnecting(true)
    setError(null)

    if (clientRef.current) {
      try {
        clientRef.current.disconnect()
      } catch {
        /* ignore */
      }
      clientRef.current = null
    }

    const client = new GatewayClient()
    clientRef.current = client

    try {
      // Persist gateway URL + token to disk BEFORE connecting so the proxy
      // can read them when it receives the first WebSocket message.
      // If the user left the placeholder dots, omit gatewayToken so we don't
      // overwrite a previously saved real token with an empty string.
      const tokenChanged = token !== '••••••••'
      await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          gatewayUrl: trimmedUrl,
          ...(tokenChanged ? { gatewayToken: trimmedToken } : {}),
        }),
      })

      // Connect via the same-origin proxy (/api/gateway/ws) rather than
      // directly to the Gateway URL — upholds Architecture Invariant #2.
      // The proxy injects the auth token server-side from saved settings.
      await client.connect(resolveProxyGatewayUrl(), {
        clientName: 'openclaw-control-ui',
        clientVersion: '0.1.0',
        disableDeviceAuth: true,
      })

      onConnected(client, trimmedUrl)
    } catch (err) {
      setError(formatGatewayError(err))
      setConnecting(false)
      clientRef.current = null
    }
  }, [url, token, connecting, onConnected])

  const isLocal = isLocalGatewayUrl(url)

  return (
    <WizardCard>
      <div className="p-8">
        <StepIndicator current="setup" />

        <h2
          className="text-[20px] font-bold text-text mb-1"
          style={{ fontFamily: 'var(--font-display)', letterSpacing: '-0.01em' }}
        >
          Connect to Gateway
        </h2>
        <p className="text-[12px] text-secondary mb-6">
          Point Clawboo at your OpenClaw Gateway instance.
        </p>

        <div
          className="flex flex-col gap-4"
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !connecting) {
              e.preventDefault()
              void handleConnect()
            }
          }}
          role="group"
        >
          {/* URL */}
          <div className="flex flex-col gap-1.5">
            <label className="font-mono text-[10px] font-semibold uppercase tracking-widest text-secondary">
              Gateway URL
            </label>
            <input
              type="text"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder={DEFAULT_GATEWAY_URL}
              spellCheck={false}
              autoComplete="off"
              disabled={connecting}
              className="h-10 rounded-lg border border-border bg-background px-3 font-mono text-[13px] text-text outline-none transition placeholder:text-secondary/30 focus:border-foreground/20 focus:ring-1 focus:ring-ring/30 disabled:opacity-50"
            />
            <AnimatePresence initial={false}>
              {isLocal && (
                <motion.p
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: 'auto' }}
                  exit={{ opacity: 0, height: 0 }}
                  className="font-mono text-[10px] text-mint/60"
                >
                  Local gateway detected
                </motion.p>
              )}
            </AnimatePresence>
          </div>

          {/* Token */}
          <div className="flex flex-col gap-1.5">
            <label className="font-mono text-[10px] font-semibold uppercase tracking-widest text-secondary">
              Token <span className="normal-case font-normal text-secondary/40">(optional)</span>
            </label>
            <div className="relative">
              <input
                type={showToken ? 'text' : 'password'}
                value={token}
                onChange={(e) => setToken(e.target.value)}
                onFocus={() => {
                  if (token === '••••••••') setToken('')
                }}
                placeholder="gateway-token"
                spellCheck={false}
                autoComplete="current-password"
                disabled={connecting}
                className="h-10 w-full rounded-lg border border-border bg-background px-3 pr-10 font-mono text-[13px] text-text outline-none transition placeholder:text-secondary/30 focus:border-foreground/20 focus:ring-1 focus:ring-ring/30 disabled:opacity-50"
              />
              <button
                type="button"
                tabIndex={-1}
                onClick={() => setShowToken((v) => !v)}
                aria-label={showToken ? 'Hide token' : 'Show token'}
                className="absolute inset-y-0 right-2 flex items-center text-secondary/40 transition hover:text-secondary"
              >
                {showToken ? (
                  <EyeOff className="h-4 w-4" strokeWidth={1.75} />
                ) : (
                  <Eye className="h-4 w-4" strokeWidth={1.75} />
                )}
              </button>
            </div>
            <p className="font-mono text-[10px] text-secondary/30">
              Leave blank for unauthenticated local gateways.
            </p>
          </div>

          {/* Error */}
          <AnimatePresence initial={false}>
            {error && (
              <motion.div
                key="error"
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                exit={{ opacity: 0, height: 0 }}
                transition={{ duration: 0.15 }}
                className="overflow-hidden"
              >
                <div
                  role="alert"
                  className="rounded-lg border border-destructive/20 bg-destructive/8 px-3 py-2 text-[12px] leading-snug text-destructive"
                >
                  {error}
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Connect button */}
          <button
            type="button"
            onClick={() => void handleConnect()}
            disabled={connecting || !url.trim()}
            className="mt-1 flex h-11 w-full items-center justify-center gap-2 rounded-lg bg-accent font-mono text-[13px] font-semibold tracking-wide text-primary-foreground shadow-sm transition hover:brightness-110 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {connecting ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" strokeWidth={2.5} />
                Connecting…
              </>
            ) : (
              <>
                Connect
                <ArrowRight className="h-4 w-4" strokeWidth={2.5} />
              </>
            )}
          </button>
        </div>

        {/* Default hint */}
        <p className="mt-5 text-center font-mono text-[10px] text-secondary/25">
          Default:{' '}
          <button
            type="button"
            tabIndex={-1}
            onClick={() => setUrl(DEFAULT_GATEWAY_URL)}
            className="text-secondary/40 underline underline-offset-2 transition hover:text-secondary"
          >
            {DEFAULT_GATEWAY_URL}
          </button>
        </p>
      </div>
    </WizardCard>
  )
}

// ─── Step 2: Team pick ────────────────────────────────────────────────────────

function TeamStep({
  onPickTeam,
  onSkip,
}: {
  onPickTeam: (profile: ProfileLike) => void
  onSkip: () => void
}) {
  return (
    <div className="w-full max-w-4xl">
      <div className="surface-overlay-tier rounded-2xl p-8">
        {/* Step indicator — centered */}
        <div className="flex justify-center mb-6">
          <StepIndicator current="team" />
        </div>

        <h2
          className="text-[20px] font-bold text-text text-center mb-1"
          style={{ fontFamily: 'var(--font-display)', letterSpacing: '-0.01em' }}
        >
          Choose your team
        </h2>
        <p className="text-[12px] text-secondary text-center mb-7">
          Deploy a ready-made crew of Boos — or skip to start with an empty fleet.
        </p>

        {/* Profile grid */}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {PROFILES.map((profile) => {
            const agents = resolveTeamAgents(profile)
            return (
              <button
                key={profile.id}
                type="button"
                onClick={() => onPickTeam(profile)}
                className="group flex flex-col text-left rounded-xl border border-border bg-background/50 p-4 transition-all duration-150 hover:border-foreground/15 hover:bg-background/80 hover:shadow-lg active:scale-[0.99]"
              >
                {/* Header */}
                <div className="mb-2.5 flex items-center gap-3">
                  <div
                    className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-[17px]"
                    style={{
                      background: `${profile.color}20`,
                      border: `1px solid ${profile.color}30`,
                    }}
                  >
                    {profile.emoji}
                  </div>
                  <div>
                    <div
                      className="text-[14px] font-semibold text-text leading-tight"
                      style={{ fontFamily: 'var(--font-display)' }}
                    >
                      {profile.name}
                    </div>
                    <div className="text-[11px] text-secondary">{agents.length} Boos</div>
                  </div>
                </div>

                {/* Description */}
                <p className="mb-3 text-[11.5px] leading-relaxed text-secondary/70">
                  {profile.description}
                </p>

                {/* Agent avatars */}
                <div className="mb-3 flex gap-1.5 items-center">
                  {agents.slice(0, 3).map((agent) => (
                    <BooAvatar key={agent.id} seed={agent.name} size={20} />
                  ))}
                  <span className="ml-1 text-[10px] text-secondary/40 font-mono">
                    {agents.map((a) => a.name.split(' ')[0]).join(', ')}
                  </span>
                </div>

                {/* Tags */}
                <div className="mt-auto flex flex-wrap gap-1">
                  {('tags' in profile ? profile.tags : (profile as TeamProfile).skills)
                    .slice(0, 3)
                    .map((tag) => (
                      <span
                        key={tag}
                        className="rounded-full border border-border bg-foreground/[0.04] px-2 py-0.5 font-mono text-[9px] text-secondary/60"
                      >
                        {tag}
                      </span>
                    ))}
                  {('tags' in profile ? profile.tags : (profile as TeamProfile).skills).length >
                    3 && (
                    <span className="rounded-full border border-border bg-foreground/[0.04] px-2 py-0.5 font-mono text-[9px] text-secondary/40">
                      +
                      {('tags' in profile ? profile.tags : (profile as TeamProfile).skills).length -
                        3}
                    </span>
                  )}
                </div>

                {/* Hover deploy label */}
                <div
                  className="mt-3 flex items-center gap-1 text-[11px] font-mono font-semibold opacity-0 transition-opacity duration-150 group-hover:opacity-100"
                  style={{ color: profile.color }}
                >
                  Deploy this team
                  <ArrowRight className="h-3 w-3" strokeWidth={2.5} />
                </div>
              </button>
            )
          })}
        </div>

        {/* Skip */}
        <div className="mt-7 flex justify-center">
          <button
            type="button"
            onClick={onSkip}
            className="flex items-center gap-1.5 font-mono text-[11px] text-secondary/35 underline underline-offset-2 transition hover:text-secondary/60"
          >
            <X className="h-3 w-3" strokeWidth={2} />
            Skip — start with an empty fleet
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Step 3: Deploy ───────────────────────────────────────────────────────────

function DeployStep({
  profile,
  client,
  onComplete,
}: {
  profile: ProfileLike
  client: GatewayClient
  // Receives the id of the newly-deployed team (or null if team creation
  // failed before any agents were assigned). Threaded up to the wizard so
  // the post-onboarding navigation can land in the team's group chat.
  onComplete: (teamId: string | null) => void
}) {
  const resolved = useMemo(() => resolveTeamAgents(profile), [profile])
  const [progress, setProgress] = useState(0)
  const [currentName, setCurrentName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const fired = useRef(false)
  // Tracks the teamId across the async deploy flow so the "Continue anyway"
  // error-escape button can pass it to onComplete even when an agent-level
  // failure interrupts the happy path. Updated as soon as POST /api/teams
  // returns ok — every later step (agent assign / brief / leader patch) is
  // best-effort, so the team exists and is usable even on partial failure.
  const teamIdRef = useRef<string | null>(null)

  useEffect(() => {
    if (fired.current) return
    fired.current = true

    const deploy = async () => {
      try {
        // ── Dedup: auto-suffix if agent/team names collide with existing ones ──
        const existingAgentNames = useFleetStore.getState().agents.map((a) => a.name)
        const existingTeamNames = useTeamStore.getState().teams.map((t) => t.name)
        const desiredAgentNames = resolved.map((a) => a.name)
        const dedupPlan = computeDedupSuffix(
          desiredAgentNames,
          existingAgentNames,
          profile.name,
          existingTeamNames,
        )
        const finalTeamName = dedupPlan.teamName

        // Create the team first
        let teamId: string | null = null
        try {
          const teamRes = await fetch('/api/teams', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              name: finalTeamName,
              icon: profile.emoji,
              color: profile.color,
              templateId: profile.id,
            }),
          })
          if (teamRes.ok) {
            const { team } = (await teamRes.json()) as { team: { id: string } }
            teamId = team.id
            // Capture in the ref so the "Continue anyway" error-escape
            // button can pass it to onComplete even if a later step throws.
            teamIdRef.current = team.id
          }
        } catch {
          // team creation failure is non-fatal — agents will be teamless
        }

        // Genuine-leader detection: find the first catalog agent whose
        // name/role matches a leadership archetype. Boo Zero is the universal
        // leader; this column is now reserved for genuine team-internal
        // leads (CTO, Team Lead, etc.).
        const genuineLeaderCatalogAgent =
          resolved.find((a) => detectGenuineLeader({ name: a.name, role: a.role })) ?? null
        const genuineLeaderFinalName = genuineLeaderCatalogAgent
          ? (dedupPlan.agentNameMap.get(genuineLeaderCatalogAgent.name) ??
            genuineLeaderCatalogAgent.name)
          : null

        // Resolve Boo Zero name (universal leader) to thread through file gen.
        const booZeroAgentId = useBooZeroStore.getState().booZeroAgentId
        const booZeroAgent = booZeroAgentId
          ? (useFleetStore.getState().agents.find((a) => a.id === booZeroAgentId) ?? null)
          : null
        const universalLeaderName = booZeroAgent?.name ?? null

        let genuineLeaderAgentId: string | null = null
        for (let i = 0; i < resolved.length; i++) {
          const agent = resolved[i]!
          const finalAgentName = dedupPlan.agentNameMap.get(agent.name) ?? agent.name
          setCurrentName(finalAgentName)
          const defaultPersonality: PersonalityValues = {
            verbosity: 50,
            humor: 50,
            caution: 50,
            speed_cost: 50,
            formality: 50,
          }
          const baseSoul =
            rewriteTemplateName(agent.soulTemplate, agent.name, finalAgentName) || '# SOUL\n'
          const soulWithPersonality = mergeSoulWithPersonality(baseSoul, defaultPersonality)

          const rawRouting = rewriteAgentsMd(agent.agentsTemplate, dedupPlan.agentNameMap) ?? ''
          const teammatesForProtocol = resolved
            .filter((a) => a.name !== agent.name)
            .map((a) => ({
              name: dedupPlan.agentNameMap.get(a.name) ?? a.name,
              role: a.role,
            }))
          const enhancedAgentsMd = buildTeamAgentsMd({
            agentName: finalAgentName,
            teamName: finalTeamName,
            teammates: teammatesForProtocol,
            routingRules: rawRouting,
            universalLeaderName,
            teamInternalLeadName: genuineLeaderFinalName,
          })
          // CLAWBOO.md — workspace-resident operating reference. See
          // `lib/teamProtocol.ts` (`buildClawbooHelpDoc`).
          const clawbooHelpDoc = buildClawbooHelpDoc({
            agentName: finalAgentName,
            teamName: finalTeamName,
            teammates: teammatesForProtocol,
            universalLeaderName,
          })

          const agentId = await createAgent(finalAgentName, {
            soul: soulWithPersonality,
            identity: rewriteTemplateName(agent.identityTemplate, agent.name, finalAgentName),
            tools: agent.toolsTemplate,
            agents: enhancedAgentsMd,
            clawboo: clawbooHelpDoc,
          })

          // Persist default personality to SQLite so sliders load correctly
          void fetch('/api/personality', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ agentId, values: defaultPersonality }),
          }).catch(() => {})

          if (genuineLeaderCatalogAgent && agent.name === genuineLeaderCatalogAgent.name) {
            genuineLeaderAgentId = agentId
          }
          setProgress(i + 1)

          // Assign agent to team (best-effort)
          if (teamId) {
            try {
              await fetch(`/api/teams/${teamId}/agents`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ agentId }),
              })
            } catch {
              // assignment failure is non-fatal
            }
          }
        }

        // Set the team-internal lead (only when detected). Boo Zero is the
        // universal leader; this column is reserved for genuine leads now.
        if (teamId) {
          try {
            await fetch(`/api/teams/${teamId}`, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ leaderAgentId: genuineLeaderAgentId }),
            })
            useTeamStore.getState().updateTeam(teamId, { leaderAgentId: genuineLeaderAgentId })
          } catch {
            // leader assignment is non-fatal
          }
        }

        // Generate Boo Zero's per-team brief (best-effort).
        if (teamId) {
          const extractSkillsFromToolsMd = (md: string | undefined): string[] => {
            if (!md) return []
            const skillsMatch = md.match(/##\s+Skills\s*\n([\s\S]*?)(?=\n##\s|$)/i)
            const body = skillsMatch?.[1] ?? ''
            return body
              .split('\n')
              .map((l) => l.trim())
              .filter((l) => l.startsWith('- '))
              .map((l) => l.slice(2).trim())
              .filter(Boolean)
          }
          const briefMembers: TeamBriefMember[] = resolved.map((a) => ({
            name: dedupPlan.agentNameMap.get(a.name) ?? a.name,
            role: a.role,
            tools: extractSkillsFromToolsMd(a.toolsTemplate),
          }))
          const internalLeadKeyword = genuineLeaderCatalogAgent
            ? matchedLeadershipKeyword({
                name: genuineLeaderCatalogAgent.name,
                role: genuineLeaderCatalogAgent.role,
              })
            : null
          const briefMarkdown = buildTeamBrief({
            team: {
              name: finalTeamName,
              icon: profile.emoji,
              templateId: profile.id ?? null,
              description: profile.description ?? '',
            },
            members: briefMembers,
            internalLead:
              genuineLeaderFinalName && internalLeadKeyword
                ? { agentName: genuineLeaderFinalName, matchedKeyword: internalLeadKeyword }
                : null,
          })
          try {
            await fetch(`/api/boo-zero/team-briefs/${encodeURIComponent(teamId)}`, {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ content: briefMarkdown }),
            })
          } catch {
            // brief gen is non-fatal
          }
        }

        // Auto-enable agent-to-agent coordination if any agent has routing
        const hasRouting = resolved.some(
          (a) => a.agentsTemplate && /@[\w"']/.test(a.agentsTemplate),
        )
        if (hasRouting) {
          try {
            await fetch('/api/system/openclaw-config', {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ agentToAgent: { enabled: true } }),
            })
          } catch {
            // config patch failure is non-fatal
          }
        }

        // Brief pause to let the "All Boos ready" copy read before the
        // wizard exits — the previous DoneStep popup that asked the user
        // to "View Ghost Graph" is gone; this is the only confirmation
        // beat the user gets before landing in their new team's group
        // chat.
        await new Promise<void>((r) => setTimeout(r, 700))
        onComplete(teamId)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Deployment failed')
      }
    }

    void deploy()
  }, [profile, client, onComplete, resolved])

  const pct = resolved.length > 0 ? (progress / resolved.length) * 100 : 0
  const allDone = progress === resolved.length

  return (
    <WizardCard>
      <div className="p-8">
        <div className="flex justify-center mb-7">
          <StepIndicator current="deploy" />
        </div>

        <div className="flex flex-col items-center gap-5 text-center">
          {/* Ghost row — one ghost per agent, lights up as deployed */}
          <div className="flex gap-3 items-end">
            {resolved.map((agent, i) => (
              <motion.div
                key={agent.id}
                animate={progress > i ? { scale: [1, 1.18, 1], opacity: 1 } : { opacity: 0.25 }}
                transition={{ duration: 0.45, ease: 'easeOut' }}
                className="flex flex-col items-center gap-1.5"
              >
                <BooAvatar seed={agent.name} size={36} />
                {progress > i && (
                  <motion.div
                    initial={{ scale: 0 }}
                    animate={{ scale: 1 }}
                    className="h-4 w-4 rounded-full bg-mint flex items-center justify-center"
                  >
                    <Check className="h-2.5 w-2.5 text-background" strokeWidth={3} />
                  </motion.div>
                )}
                {progress <= i && <div className="h-4 w-4" />}
              </motion.div>
            ))}
          </div>

          {/* Status text */}
          <div>
            <h2
              className="text-[18px] font-bold text-text"
              style={{ fontFamily: 'var(--font-display)', letterSpacing: '-0.01em' }}
            >
              {allDone ? (
                <>
                  {profile.emoji} {profile.name} deployed
                </>
              ) : (
                <>
                  Deploying {profile.emoji} {profile.name}…
                </>
              )}
            </h2>
            <AnimatePresence mode="wait">
              {!error && (
                <motion.p
                  key={allDone ? 'done' : currentName}
                  initial={{ opacity: 0, y: 4 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -4 }}
                  transition={{ duration: 0.2 }}
                  className="mt-1.5 text-[12px] text-secondary/70"
                >
                  {allDone ? `All ${resolved.length} Boos ready` : `Creating ${currentName}…`}
                </motion.p>
              )}
              {error && (
                <motion.p
                  key="error"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  className="mt-1.5 text-[12px] text-destructive"
                >
                  {error}
                </motion.p>
              )}
            </AnimatePresence>
          </div>

          {/* Progress bar */}
          <div className="w-[220px] h-1.5 rounded-full bg-foreground/[0.08] overflow-hidden">
            <motion.div
              className="h-full rounded-full bg-accent"
              animate={{ width: `${pct}%` }}
              // 200 ms / standard easing — matches `--motion-base` token so
              // the progress reads with the same rhythm as state-change
              // transitions elsewhere in the app.
              transition={{ duration: 0.2, ease: [0.4, 0, 0.2, 1] }}
            />
          </div>

          {/* Counter */}
          <p className="font-mono text-[10px] text-secondary/35">
            {progress} / {resolved.length} Boos created
          </p>

          {/* Error escape hatch — passes whatever teamId we captured
              before the error (may be null if team creation itself failed
              or set if the team was created but an agent step threw). */}
          {error && (
            <button
              type="button"
              onClick={() => onComplete(teamIdRef.current)}
              className="font-mono text-[11px] text-secondary/45 underline underline-offset-2 transition hover:text-secondary/70"
            >
              Continue anyway →
            </button>
          )}
        </div>
      </div>
    </WizardCard>
  )
}

// Note: there is no longer a "Done" / "Your Ghost Graph is ready" step.
// DeployStep already shows "All N Boos ready" with a 700 ms beat before
// firing onComplete, and the host (`GatewayBootstrap`) routes the user
// straight into the new team's group chat — the extra modal was friction
// without information.

// ─── OnboardingWizard ─────────────────────────────────────────────────────────

export function OnboardingWizard({
  onComplete,
  initialStep = 'welcome',
  initialRuntime = null,
}: OnboardingWizardProps) {
  const [step, setStep] = useState<WizardStep>(initialStep)
  const [prevStep, setPrevStep] = useState<WizardStep>(initialStep)
  const [client, setClient] = useState<GatewayClient | null>(null)
  const [gatewayUrl, setGatewayUrl] = useState('')
  const [selectedProfile, setSelectedProfile] = useState<ProfileLike | null>(null)
  const [selectedRuntime, setSelectedRuntime] = useState<SelectedRuntime | null>(initialRuntime)
  // The team minted by ConfigureNativeStep's seed call — shown on nativeReady.
  const [seededTeamId, setSeededTeamId] = useState<string | null>(null)

  // Gateway URL from ConfigureStep — used by StartGatewayStep completion handler
  const [systemConnectUrl, setSystemConnectUrl] = useState('')

  const goTo = useCallback(
    (next: WizardStep) => {
      setPrevStep(step)
      setStep(next)
    },
    [step],
  )

  // Tear down a GatewayClient established earlier in this wizard run. Retreating
  // to/past `chooseRuntime` abandons the OpenClaw path, so a lingering client
  // would (a) leak its WebSocket and (b) make a subsequent coding-agent pick
  // wrongly route into the Gateway team→deploy flow (handleConnectAgentsDone
  // branches on `client` being set). Idempotent — a no-op when there's no client.
  const resetGatewayClient = useCallback(() => {
    if (client) {
      client.disconnect()
      setClient(null)
      setGatewayUrl('')
    }
  }, [client])

  // ── chooseRuntime: the user picked how their agents will run ───────────────
  // Native → paste a key + seed a team. OpenClaw → the existing gateway flow
  // (entered at `detect`, which routes install/configure/startGateway for a
  // fresh box). Claude Code / Hermes / Codex → the runtime connect step.
  const handleChooseRuntime = useCallback(
    (runtime: SelectedRuntime) => {
      // A re-pick starts clean — drop any client from a prior OpenClaw attempt.
      resetGatewayClient()
      setSelectedRuntime(runtime)
      setWizardRuntime(runtime)
      if (runtime === 'clawboo-native') goTo('configureNative')
      else if (runtime === 'openclaw') goTo('detect')
      else goTo('connectAgents')
    },
    [goTo, resetGatewayClient],
  )

  // ── Native ready: the seeded team is shown; the user opens the dashboard.
  // No GatewayClient — native runs server-side. The host enters "native mode".
  const handleNativeReady = useCallback(
    (teamId: string | null) => {
      onComplete(null, null, teamId, 'native')
    },
    [onComplete],
  )

  // ── DetectStep: everything is green — auto-connect via proxy ──────────────
  const handleAllGood = useCallback(async () => {
    try {
      const resp = await fetch('/api/settings')
      if (!resp.ok) {
        goTo('connect')
        return
      }
      const data = (await resp.json()) as { gatewayUrl?: string }
      if (!data.gatewayUrl?.trim()) {
        goTo('connect')
        return
      }

      const newClient = new GatewayClient()
      await newClient.connect(resolveProxyGatewayUrl(), {
        clientName: 'openclaw-control-ui',
        clientVersion: '0.1.0',
        disableDeviceAuth: true,
      })
      setClient(newClient)
      setGatewayUrl(data.gatewayUrl.trim())
      goTo('connectAgents')
    } catch {
      goTo('connect')
    }
  }, [goTo])

  // ── ConfigureStep completed ───────────────────────────────────────────────
  const handleConfigured = useCallback(
    (data: { gatewayUrl: string }) => {
      setSystemConnectUrl(data.gatewayUrl)
      goTo('startGateway')
    },
    [goTo],
  )

  // ── StartGatewayStep completed — client is live ───────────────────────────
  const handleGatewayStarted = useCallback(
    (newClient: GatewayClient) => {
      setClient(newClient)
      // Use the URL from configure step, or fall back to default
      setGatewayUrl(systemConnectUrl || 'ws://localhost:18789')
      goTo('connectAgents')
    },
    [goTo, systemConnectUrl],
  )

  const handleConnected = useCallback(
    (newClient: GatewayClient, url: string) => {
      setClient(newClient)
      setGatewayUrl(url)
      goTo('connectAgents')
    },
    [goTo],
  )

  // "Connect coding agents" step — Continue and Skip both finish it. The OpenClaw
  // path reaches here with a live `client` and continues into team → deploy. A
  // coding-agent (Claude Code / Hermes / Codex) FIRST choice has NO client — the
  // team → deploy flow would create Gateway agents it can never finish, so we
  // complete onboarding directly. The user lands in the dashboard with the
  // runtime connected and adds a team from Capabilities later. `mode: 'native'`
  // is the existing client-free landing (the host enters native/REST mode).
  const handleConnectAgentsDone = useCallback(() => {
    if (client) goTo('team')
    else onComplete(null, null, null, 'native')
  }, [client, goTo, onComplete])

  const handlePickTeam = useCallback(
    (profile: ProfileLike) => {
      setSelectedProfile(profile)
      goTo('deploy')
    },
    [goTo],
  )

  // User chose to skip team setup. No team to land in — pass null so the host
  // falls through to its default post-onboarding view. Complete unconditionally
  // (a null client = the client-free 'native' landing) so the button is never a
  // dead no-op.
  const handleSkipTeam = useCallback(() => {
    onComplete(client, gatewayUrl, null, client ? 'gateway' : 'native')
  }, [client, gatewayUrl, onComplete])

  // Deploy succeeded (or partially succeeded — error escape hatch also
  // routes through here with the captured teamId). The host uses teamId to
  // navigate the user into the new team's group chat.
  const handleDeployComplete = useCallback(
    (teamId: string | null) => {
      if (client) onComplete(client, gatewayUrl, teamId, 'gateway')
    },
    [client, gatewayUrl, onComplete],
  )

  // ── A11y: dialog semantics + focus trap + Escape-as-back ───────────────────
  // The wizard is a mandatory full-screen modal. Trap + restore focus, and let
  // Escape retreat one step (never dismiss — there is no app behind it).
  const dialogRef = useRef<HTMLDivElement | null>(null)
  useFocusTrap(dialogRef, step)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      const back = BACK_STEP[step]
      if (!back) return
      // Retreating to the runtime picker abandons any OpenClaw path — tear down
      // its client so the WS doesn't linger and a re-pick starts clean.
      if (back === 'chooseRuntime') resetGatewayClient()
      goTo(back)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [step, goTo, resetGatewayClient])

  // Animate direction based on step progression
  const isForward = STEP_INDEX[step] >= STEP_INDEX[prevStep]
  const xEnter = isForward ? 24 : -24
  const xExit = isForward ? -16 : 16

  const directedVariants = {
    enter: { opacity: 0, x: xEnter },
    center: { opacity: 1, x: 0 },
    exit: { opacity: 0, x: xExit },
  }

  return (
    <motion.div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label="Set up Clawboo"
      // Focusable so the focus-trap's root fallback can land focus inside the
      // dialog on a control-less step (an element without tabindex isn't a
      // valid focus target → focus would stay on <body>).
      tabIndex={-1}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.2 }}
      className={[
        'fixed inset-0 z-50',
        step === 'welcome'
          ? ''
          : 'flex items-center justify-center bg-background/95 backdrop-blur-sm px-4 py-8 overflow-y-auto',
      ].join(' ')}
    >
      <AnimatePresence mode="wait">
        {step === 'welcome' && (
          <motion.div
            key="welcome"
            variants={directedVariants}
            initial="enter"
            animate="center"
            exit="exit"
            transition={stepTransition}
            className="absolute inset-0"
          >
            <WelcomeStep onContinue={() => goTo('chooseRuntime')} />
          </motion.div>
        )}

        {step === 'chooseRuntime' && (
          <motion.div
            key="chooseRuntime"
            variants={directedVariants}
            initial="enter"
            animate="center"
            exit="exit"
            transition={stepTransition}
            className="w-full flex justify-center"
          >
            <ChooseRuntimeStep onPick={handleChooseRuntime} />
          </motion.div>
        )}

        {step === 'configureNative' && (
          <motion.div
            key="configureNative"
            variants={directedVariants}
            initial="enter"
            animate="center"
            exit="exit"
            transition={stepTransition}
            className="w-full flex justify-center"
          >
            <ConfigureNativeStep
              onSeeded={(teamId) => {
                setSeededTeamId(teamId)
                goTo('nativeReady')
              }}
              onBack={() => goTo('chooseRuntime')}
            />
          </motion.div>
        )}

        {step === 'nativeReady' && (
          <motion.div
            key="nativeReady"
            variants={directedVariants}
            initial="enter"
            animate="center"
            exit="exit"
            transition={stepTransition}
            className="w-full flex justify-center"
          >
            <NativeReadyStep
              teamId={seededTeamId}
              onOpenDashboard={() => handleNativeReady(seededTeamId)}
              // Capabilities path passes teamId=null so the host skips the
              // group-chat redirect, leaving the Capabilities view in place.
              onOpenCapabilities={() => handleNativeReady(null)}
            />
          </motion.div>
        )}

        {step === 'detect' && (
          <motion.div
            key="detect"
            variants={directedVariants}
            initial="enter"
            animate="center"
            exit="exit"
            transition={stepTransition}
            className="w-full flex justify-center"
          >
            <DetectStep
              onAllGood={() => void handleAllGood()}
              onNeedInstall={() => goTo('install')}
              onNeedConfigure={() => goTo('configure')}
              onNeedGateway={() => goTo('startGateway')}
              onAdvancedConnect={() => goTo('connect')}
            />
          </motion.div>
        )}

        {step === 'install' && (
          <motion.div
            key="install"
            variants={directedVariants}
            initial="enter"
            animate="center"
            exit="exit"
            transition={stepTransition}
            className="w-full flex justify-center"
          >
            <InstallStep
              onInstalled={(_version) => goTo('configure')}
              onBack={() => goTo('detect')}
            />
          </motion.div>
        )}

        {step === 'configure' && (
          <motion.div
            key="configure"
            variants={directedVariants}
            initial="enter"
            animate="center"
            exit="exit"
            transition={stepTransition}
            className="w-full flex justify-center"
          >
            <ConfigureStep onConfigured={handleConfigured} onBack={() => goTo('detect')} />
          </motion.div>
        )}

        {step === 'startGateway' && (
          <motion.div
            key="startGateway"
            variants={directedVariants}
            initial="enter"
            animate="center"
            exit="exit"
            transition={stepTransition}
            className="w-full flex justify-center"
          >
            <StartGatewayStep onStarted={handleGatewayStarted} onBack={() => goTo('configure')} />
          </motion.div>
        )}

        {step === 'connectAgents' && (
          <motion.div
            key="connectAgents"
            variants={directedVariants}
            initial="enter"
            animate="center"
            exit="exit"
            transition={stepTransition}
            className="w-full flex justify-center"
          >
            <ConnectAgentsStep
              onContinue={handleConnectAgentsDone}
              onSkip={handleConnectAgentsDone}
              focusRuntime={selectedRuntime}
              // OpenClaw reaches this step with a live client and continues into
              // team → deploy; a coding-agent first choice has no client and
              // completes onboarding here (the terminal path).
              continuesToTeam={!!client}
            />
          </motion.div>
        )}

        {step === 'connect' && (
          <motion.div
            key="connect"
            variants={directedVariants}
            initial="enter"
            animate="center"
            exit="exit"
            transition={stepTransition}
            className="w-full flex justify-center"
          >
            <ConnectStep onConnected={handleConnected} />
          </motion.div>
        )}

        {step === 'team' && (
          <motion.div
            key="team"
            variants={directedVariants}
            initial="enter"
            animate="center"
            exit="exit"
            transition={stepTransition}
            className="w-full flex justify-center"
          >
            <TeamStep onPickTeam={handlePickTeam} onSkip={handleSkipTeam} />
          </motion.div>
        )}

        {step === 'deploy' && client && selectedProfile && (
          <motion.div
            key="deploy"
            variants={directedVariants}
            initial="enter"
            animate="center"
            exit="exit"
            transition={stepTransition}
            className="w-full flex justify-center"
          >
            <DeployStep
              profile={selectedProfile}
              client={client}
              onComplete={handleDeployComplete}
            />
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  )
}
