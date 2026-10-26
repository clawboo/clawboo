/**
 * apps/web/src/features/onboarding/OnboardingWizard.tsx
 *
 * First-time onboarding wizard. Native-first: no up-front "pick a runtime"
 * choice. The user connects a provider, optionally adds more runtimes, then
 * picks and deploys a team. The spine:
 *   Welcome → ConfigureNative → AddRuntimes → SelectTeam → NativeReady
 *     · ConfigureNative connects a provider key (or Sign in with ChatGPT).
 *     · AddRuntimes (optional/skippable) connects Claude Code / Codex / Hermes,
 *       and sets up OpenClaw in place in its row (OpenClawInlineSetup).
 *     · SelectTeam picks a template from the marketplace and deploys it.
 *     · NativeReady lands the user in the deployed team's chat.
 *
 * Every path finishes with a deployed team; nothing depends on a live Gateway
 * `client` to complete (no strand). Only shown when localStorage('clawboo.
 * onboarded') is absent.
 *
 * Calls onComplete(client, url, teamId, mode) when the flow finishes. `mode` is
 * 'gateway' (a live GatewayClient, when the OpenClaw setup connected one) or
 * 'native' (Gateway-free; client + url are null). `teamId` lands the user in
 * that team's group chat.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { ArrowRight } from 'lucide-react'
import type { GatewayClient } from '@clawboo/gateway-client'
import { AddRuntimesStep, ConfigureNativeStep, NativeReadyStep, SelectTeamStep } from './steps'
import { isTopmostTrap, useFocusTrap } from '@/features/shared/useFocusTrap'
import { SkyAtmosphere } from '@/features/atmosphere'
import { preloadCreateTeamModal } from '@/features/teams/CreateTeamModalLazy'

// ─── Types ────────────────────────────────────────────────────────────────────

export type WizardStep =
  'welcome' | 'configureNative' | 'addRuntimes' | 'selectTeam' | 'nativeReady'

const STEP_INDEX: Record<WizardStep, number> = {
  welcome: 0,
  // The native-first spine: paste a key → add runtimes → pick + deploy a team → land.
  configureNative: 1,
  addRuntimes: 2,
  selectTeam: 3,
  nativeReady: 4,
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
  selectTeam: 'addRuntimes',
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
   * `teamId` is the id of the team the user just deployed (or null
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
            <img src="logo.svg" alt="Clawboo" width={84} height={77} />
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
          className="welcome-cta flex items-center gap-2.5 h-[52px] px-9 rounded-xl bg-primary-solid font-semibold text-[15px] text-primary-foreground shadow-[0_0_36px_rgb(var(--primary-rgb) / 0.45)] transition hover:brightness-110 active:scale-[0.98]"
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

// ─── OnboardingWizard ─────────────────────────────────────────────────────────

export function OnboardingWizard({ onComplete, initialStep = 'welcome' }: OnboardingWizardProps) {
  const [step, setStep] = useState<WizardStep>(initialStep)
  const [prevStep, setPrevStep] = useState<WizardStep>(initialStep)
  const [client, setClient] = useState<GatewayClient | null>(null)
  const [gatewayUrl, setGatewayUrl] = useState('')
  // The team the user deployed in the selectTeam step — shown on nativeReady and
  // used to land them in that team's chat.
  const [deployedTeamId, setDeployedTeamId] = useState<string | null>(null)
  // The PRIMARY runtime the connect step landed on: native (a provider key) or
  // codex (Sign in with ChatGPT). Steers the team deploy's per-agent default.
  const [primaryRuntime, setPrimaryRuntime] = useState<'clawboo-native' | 'codex'>('clawboo-native')

  const goTo = useCallback(
    (next: WizardStep) => {
      setPrevStep(step)
      setStep(next)
    },
    [step],
  )

  // `SelectTeamStep` opens the team marketplace the instant it mounts, and that modal
  // is lazy so its code stays off the SPA's entry chunk (issue #83).
  // Warm it here: the user spends several seconds on addRuntimes, so by the time they
  // continue the chunk is already in the module cache and the step renders instantly.
  useEffect(() => {
    if (step === 'addRuntimes') preloadCreateTeamModal()
  }, [step])

  // ── addRuntimes finished (Continue) — advance to team selection.
  const handleAddRuntimesDone = useCallback(() => {
    goTo('selectTeam')
  }, [goTo])

  // ── Native ready: the deployed team is shown; the user opens the dashboard.
  // If the OpenClaw setup connected a live client, hand it through ('gateway'
  // mode) rather than discarding it; otherwise the client-free 'native' landing
  // (the host enters native/REST mode). Either way the user lands in the chat of
  // the team they deployed.
  const handleNativeReady = useCallback(
    (teamId: string | null) => {
      if (client) onComplete(client, gatewayUrl || null, teamId, 'gateway')
      else onComplete(null, null, teamId, 'native')
    },
    [client, gatewayUrl, onComplete],
  )

  // ── A11y: dialog semantics + focus trap + Escape-as-back ───────────────────
  // The wizard is a mandatory full-screen modal. Trap + restore focus, and let
  // Escape retreat one step (never dismiss — there is no app behind it).
  const dialogRef = useRef<HTMLDivElement | null>(null)
  const trapToken = useFocusTrap(dialogRef, step)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      // A dialog opened ON TOP of the wizard (SelectTeamStep mounts
      // CreateTeamModal) owns Escape — otherwise one press would both close that
      // dialog and retreat a wizard step. stopPropagation can't arbitrate: both
      // listeners sit on `window` in the bubble phase.
      if (!isTopmostTrap(trapToken.current)) return
      const back = BACK_STEP[step]
      if (!back) return
      goTo(back)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [step, goTo, trapToken])

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
      // On the wizard ROOT, not a step: the clean-install smoke waits for this
      // to prove a fresh install actually reaches the onboarding surface, and
      // anchoring it here keeps that gate stable across step redesigns.
      data-testid="onboarding-wizard"
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
              onConnected={(provider) => {
                // 'codex' = the Sign in with ChatGPT path — the team deploy then
                // defaults every agent to codex; any provider key = native primary.
                setPrimaryRuntime(provider === 'codex' ? 'codex' : 'clawboo-native')
                goTo('addRuntimes')
              }}
              onBack={() => goTo('welcome')}
            />
          </motion.div>
        )}

        {step === 'selectTeam' && (
          <motion.div
            key="selectTeam"
            variants={directedVariants}
            initial="enter"
            animate="center"
            exit="exit"
            transition={stepTransition}
            className="w-full flex justify-center"
          >
            <SelectTeamStep
              onDeployed={(teamId) => {
                setDeployedTeamId(teamId)
                goTo('nativeReady')
              }}
              onBack={() => goTo('addRuntimes')}
              primaryRuntime={primaryRuntime}
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
              teamId={deployedTeamId}
              onOpenDashboard={() => handleNativeReady(deployedTeamId)}
            />
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
              onBack={() => goTo('configureNative')}
              onOpenClawConnected={(newClient, url) => {
                setClient(newClient)
                setGatewayUrl(url)
              }}
              openClawConnected={!!client}
            />
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  )
}
