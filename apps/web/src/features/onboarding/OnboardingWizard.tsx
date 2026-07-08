/**
 * apps/web/src/features/onboarding/OnboardingWizard.tsx
 *
 * First-time onboarding wizard. Native-first: no up-front "pick a runtime"
 * choice — the user pastes a provider key and gets a working native team, then
 * optionally adds more runtimes. The spine:
 *   Welcome → ConfigureNative → AddRuntimes → NativeReady
 *     · ConfigureNative seeds a native team (leader + specialist) server-side.
 *     · AddRuntimes (optional/skippable) connects Claude Code / Codex / Hermes,
 *       and offers an "advanced" OpenClaw detour (Detect → [Install → Configure
 *       → StartGateway] / Connect) that RETURNS to AddRuntimes.
 *     · NativeReady lands the user in their seeded team's chat.
 *
 * Every path finishes with a seeded team — nothing depends on a live Gateway
 * `client` to complete (no strand). Only shown when localStorage('clawboo.
 * onboarded') is absent.
 *
 * Calls onComplete(client, url, teamId, mode) when the flow finishes. `mode` is
 * 'gateway' (a live GatewayClient, when the OpenClaw detour connected one) or
 * 'native' (Gateway-free; client + url are null). `teamId` lands the user in
 * that team's group chat.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { ArrowRight, Eye, EyeOff, Loader2 } from 'lucide-react'
import {
  GatewayClient,
  formatGatewayError,
  isLocalGatewayUrl,
  resolveProxyGatewayUrl,
} from '@clawboo/gateway-client'
import {
  DetectStep,
  InstallStep,
  ConfigureStep,
  StartGatewayStep,
  AddRuntimesStep,
  ConfigureNativeStep,
  NativeReadyStep,
} from './steps'
import { NATIVE_STEPS } from './StepIndicator'
import { OnboardingPrimary, OnboardingScreen } from './OnboardingScreen'
import { useFocusTrap } from './useFocusTrap'
import { SkyAtmosphere } from '@/features/atmosphere'
import { connectGatewayFromSettings } from '@/lib/gatewayConnect'

// ─── Types ────────────────────────────────────────────────────────────────────

export type WizardStep =
  | 'welcome'
  | 'configureNative'
  | 'addRuntimes'
  | 'nativeReady'
  // The OpenClaw setup detour — reachable only from addRuntimes (returns there).
  | 'detect'
  | 'install'
  | 'configure'
  | 'startGateway'
  | 'connect'

const STEP_INDEX: Record<WizardStep, number> = {
  welcome: 0,
  // The native-first spine: paste a key → seed a team → add runtimes → land.
  configureNative: 1,
  addRuntimes: 2,
  nativeReady: 3,
  // The OpenClaw setup detour (a drill-in of addRuntimes; higher indices so
  // entering it animates forward and returning animates backward).
  detect: 4,
  install: 5,
  configure: 6,
  startGateway: 7,
  connect: 8,
}

/**
 * Escape steps BACK to the prior step. Onboarding is a mandatory first-run flow
 * with no "empty app" to dismiss to, so Escape never unmounts the wizard — it
 * just retreats one step. Steps absent from this map (welcome + the nativeReady
 * success landing) ignore Escape.
 */
const BACK_STEP: Partial<Record<WizardStep, WizardStep>> = {
  configureNative: 'welcome',
  addRuntimes: 'configureNative',
  // The OpenClaw detour: retreating out of detect abandons it back to addRuntimes.
  detect: 'addRuntimes',
  install: 'detect',
  configure: 'detect',
  startGateway: 'configure',
  connect: 'detect',
}

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
}

// ─── Motion transition ────────────────────────────────────────────────────────

const stepTransition = { type: 'spring', stiffness: 320, damping: 30 } as const

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
    <OnboardingScreen
      step="runtimes"
      steps={NATIVE_STEPS}
      title="Connect to a Gateway"
      subtitle="Point Clawboo at your running OpenClaw Gateway."
      footer={
        <OnboardingPrimary
          onClick={() => void handleConnect()}
          disabled={connecting || !url.trim()}
          className="w-full"
        >
          {connecting ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" strokeWidth={2.5} /> Connecting…
            </>
          ) : (
            <>
              Connect <ArrowRight className="h-4 w-4" strokeWidth={2.5} />
            </>
          )}
        </OnboardingPrimary>
      }
    >
      <div
        className="flex flex-col gap-5"
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !connecting) {
            e.preventDefault()
            void handleConnect()
          }
        }}
        role="group"
      >
        {/* URL */}
        <div className="flex flex-col gap-2">
          <label
            className="font-mono text-[11px] uppercase tracking-[0.14em]"
            style={{ color: 'rgb(var(--foreground-rgb) / 0.5)' }}
          >
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
            className="w-full rounded-xl border border-border bg-surface px-4 py-3 font-mono text-[13px] text-foreground outline-none transition placeholder:text-foreground/30 focus:border-primary focus:ring-4 focus:ring-primary/15 disabled:opacity-50"
          />
          <AnimatePresence initial={false}>
            {isLocal && (
              <motion.p
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                exit={{ opacity: 0, height: 0 }}
                className="font-mono text-[11px]"
                style={{ color: 'rgb(var(--mint-rgb) / 0.7)' }}
              >
                Local gateway detected
              </motion.p>
            )}
          </AnimatePresence>
        </div>

        {/* Token */}
        <div className="flex flex-col gap-2">
          <label
            className="font-mono text-[11px] uppercase tracking-[0.14em]"
            style={{ color: 'rgb(var(--foreground-rgb) / 0.5)' }}
          >
            Token{' '}
            <span
              className="tracking-normal normal-case"
              style={{ color: 'rgb(var(--foreground-rgb) / 0.35)' }}
            >
              (optional)
            </span>
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
              className="w-full rounded-xl border border-border bg-surface px-4 py-3 pr-11 font-mono text-[13px] text-foreground outline-none transition placeholder:text-foreground/30 focus:border-primary focus:ring-4 focus:ring-primary/15 disabled:opacity-50"
            />
            <button
              type="button"
              tabIndex={-1}
              onClick={() => setShowToken((v) => !v)}
              aria-label={showToken ? 'Hide token' : 'Show token'}
              className="absolute inset-y-0 right-3 flex items-center text-foreground/40 transition-colors hover:text-foreground/70"
            >
              {showToken ? (
                <EyeOff className="h-4 w-4" strokeWidth={1.75} />
              ) : (
                <Eye className="h-4 w-4" strokeWidth={1.75} />
              )}
            </button>
          </div>
          <p className="text-[12px]" style={{ color: 'rgb(var(--foreground-rgb) / 0.45)' }}>
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
                className="rounded-xl border border-destructive/20 bg-destructive/8 px-4 py-3 text-[13px] leading-snug text-destructive"
              >
                {error}
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Default hint */}
        <p className="text-center text-[12px]" style={{ color: 'rgb(var(--foreground-rgb) / 0.35)' }}>
          Default:{' '}
          <button
            type="button"
            tabIndex={-1}
            onClick={() => setUrl(DEFAULT_GATEWAY_URL)}
            className="underline underline-offset-2 transition-colors hover:text-foreground/60"
            style={{ color: 'rgb(var(--foreground-rgb) / 0.5)' }}
          >
            {DEFAULT_GATEWAY_URL}
          </button>
        </p>
      </div>
    </OnboardingScreen>
  )
}

// ─── OnboardingWizard ─────────────────────────────────────────────────────────

export function OnboardingWizard({
  onComplete,
  initialStep = 'welcome',
}: OnboardingWizardProps) {
  const [step, setStep] = useState<WizardStep>(initialStep)
  const [prevStep, setPrevStep] = useState<WizardStep>(initialStep)
  const [client, setClient] = useState<GatewayClient | null>(null)
  const [gatewayUrl, setGatewayUrl] = useState('')
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

  // Tear down a GatewayClient established earlier in this wizard run. Entering
  // (or Escaping out of) the OpenClaw detour starts clean, so a lingering client
  // from a half-finished attempt doesn't leak its WebSocket or make nativeReady
  // wrongly complete in 'gateway' mode. Idempotent — a no-op when there's no client.
  const resetGatewayClient = useCallback(() => {
    if (client) {
      client.disconnect()
      setClient(null)
      setGatewayUrl('')
    }
  }, [client])

  // ── Enter the OpenClaw setup detour (from addRuntimes). Start clean so a prior
  // half-finished attempt's client doesn't linger; the detour returns to
  // addRuntimes on success (handleAllGood / handleGatewayStarted / handleConnected).
  const handleSetupOpenClaw = useCallback(() => {
    resetGatewayClient()
    goTo('detect')
  }, [resetGatewayClient, goTo])

  // ── addRuntimes finished (Continue OR Skip) — advance to the ready landing.
  const handleAddRuntimesDone = useCallback(() => {
    goTo('nativeReady')
  }, [goTo])

  // ── Native ready: the seeded team is shown; the user opens the dashboard.
  // If the OpenClaw detour connected a live client, hand it through ('gateway'
  // mode) rather than discarding it; otherwise the client-free 'native' landing
  // (the host enters native/REST mode). Either way the user lands in their
  // seeded native team's chat.
  const handleNativeReady = useCallback(
    (teamId: string | null) => {
      if (client) onComplete(client, gatewayUrl || null, teamId, 'gateway')
      else onComplete(null, null, teamId, 'native')
    },
    [client, gatewayUrl, onComplete],
  )

  // ── DetectStep: everything is green — auto-connect via proxy ──────────────
  // Shares the connect-from-settings logic with the dashboard's OpenClawSetupFlow
  // (lib/gatewayConnect.ts) so the two never diverge. Any failure (no settings /
  // no url / connect error, incl. NOT_PAIRED) falls back to the manual ConnectStep.
  const handleAllGood = useCallback(async () => {
    try {
      const { client: newClient, gatewayUrl: url } = await connectGatewayFromSettings()
      setClient(newClient)
      setGatewayUrl(url)
      goTo('addRuntimes')
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
      goTo('addRuntimes')
    },
    [goTo, systemConnectUrl],
  )

  const handleConnected = useCallback(
    (newClient: GatewayClient, url: string) => {
      setClient(newClient)
      setGatewayUrl(url)
      goTo('addRuntimes')
    },
    [goTo],
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
      // Retreating out of the OpenClaw detour (back to addRuntimes) abandons it —
      // tear down any half-open client so the WS doesn't linger.
      if (back === 'addRuntimes') resetGatewayClient()
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
        step === 'welcome' ? '' : 'overflow-y-auto bg-background',
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
            <WelcomeStep onContinue={() => goTo('configureNative')} />
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
                goTo('addRuntimes')
              }}
              onBack={() => goTo('welcome')}
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

        {step === 'addRuntimes' && (
          <motion.div
            key="addRuntimes"
            variants={directedVariants}
            initial="enter"
            animate="center"
            exit="exit"
            transition={stepTransition}
            className="w-full flex justify-center"
          >
            <AddRuntimesStep
              onContinue={handleAddRuntimesDone}
              onSkip={handleAddRuntimesDone}
              onSetupOpenClaw={handleSetupOpenClaw}
              openClawConnected={!!client}
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

      </AnimatePresence>
    </motion.div>
  )
}
