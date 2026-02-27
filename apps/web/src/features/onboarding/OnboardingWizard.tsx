'use client'

/**
 * apps/web/src/features/onboarding/OnboardingWizard.tsx
 *
 * 4-step first-time onboarding wizard:
 *   Welcome → Connect → Team → Deploy → Done
 *
 * Only shown when localStorage('clawboo.onboarded') is absent.
 * Calls onComplete(client, url) when the user is ready to see the Ghost Graph.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { ArrowRight, Check, Eye, EyeOff, Loader2, X } from 'lucide-react'
import Image from 'next/image'
import {
  GatewayClient,
  formatGatewayError,
  isLocalGatewayUrl,
  resolveProxyGatewayUrl,
} from '@clawboo/gateway-client'
import { BooAvatar } from '@clawboo/ui'
import type { TeamProfile } from '@/features/teams/types'
import { resolveWorkspaceDir, createAgent } from '@/lib/createAgent'

import marketingRaw from '@/features/teams/profiles/marketing.json'
import devRaw from '@/features/teams/profiles/dev.json'
import researchRaw from '@/features/teams/profiles/research.json'
import youtubeRaw from '@/features/teams/profiles/youtube.json'
import studentRaw from '@/features/teams/profiles/student.json'

// ─── Profiles ─────────────────────────────────────────────────────────────────

const PROFILES: TeamProfile[] = [
  marketingRaw as TeamProfile,
  devRaw as TeamProfile,
  researchRaw as TeamProfile,
  youtubeRaw as TeamProfile,
  studentRaw as TeamProfile,
]

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildToolsMd(skills: string[]): string {
  if (!skills.length) return '# TOOLS\n'
  return `# TOOLS\n\n## Skills\n${skills.map((s) => `- ${s}`).join('\n')}\n`
}

// ─── Types ────────────────────────────────────────────────────────────────────

type WizardStep = 'welcome' | 'connect' | 'team' | 'deploy' | 'done'

const STEP_INDEX: Record<WizardStep, number> = {
  welcome: 0,
  connect: 1,
  team: 2,
  deploy: 3,
  done: 4,
}

export type OnboardingWizardProps = {
  onComplete: (client: GatewayClient, gatewayUrl: string) => void
}

// ─── Motion transition ────────────────────────────────────────────────────────

const stepTransition = { type: 'spring', stiffness: 320, damping: 30 } as const

// ─── Step indicator ───────────────────────────────────────────────────────────

type IndicatorId = 'connect' | 'team' | 'deploy'

const INDICATOR_STEPS: { id: IndicatorId; label: string }[] = [
  { id: 'connect', label: 'Connect' },
  { id: 'team', label: 'Team' },
  { id: 'deploy', label: 'Deploy' },
]

function StepIndicator({ current }: { current: IndicatorId }) {
  const currentIdx = INDICATOR_STEPS.findIndex((s) => s.id === current)

  return (
    <div className="flex items-start justify-center gap-0 mb-7">
      {INDICATOR_STEPS.map((s, i) => {
        const done = i < currentIdx
        const active = i === currentIdx

        return (
          <div key={s.id} className="flex items-center">
            <div className="flex flex-col items-center gap-1.5">
              <div
                className={[
                  'h-6 w-6 rounded-full flex items-center justify-center text-[10px] font-bold transition-all duration-300',
                  done
                    ? 'bg-mint text-background'
                    : active
                      ? 'bg-accent text-white ring-4 ring-accent/20'
                      : 'bg-white/10 text-secondary/50',
                ].join(' ')}
              >
                {done ? <Check className="h-3.5 w-3.5" strokeWidth={2.5} /> : i + 1}
              </div>
              <span
                className={[
                  'text-[9px] font-mono uppercase tracking-wider transition-colors duration-300',
                  active ? 'text-accent' : done ? 'text-mint' : 'text-secondary/30',
                ].join(' ')}
              >
                {s.label}
              </span>
            </div>
            {i < INDICATOR_STEPS.length - 1 && (
              <div
                className={[
                  'h-px w-14 mx-1 mb-5 transition-colors duration-500',
                  done ? 'bg-mint/35' : 'bg-white/8',
                ].join(' ')}
              />
            )}
          </div>
        )
      })}
    </div>
  )
}

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
        'w-full rounded-2xl border border-white/8 bg-surface',
        'shadow-[0_32px_80px_rgba(0,0,0,0.65)]',
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
    <div className="absolute inset-0 flex flex-col items-center justify-center bg-background overflow-hidden">
      {/* Radial glow */}
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_80%_60%_at_50%_40%,rgba(233,69,96,0.10)_0%,transparent_70%)]" />

      {/* Subtle grid */}
      <div
        className="pointer-events-none absolute inset-0 opacity-[0.03]"
        style={{
          backgroundImage:
            'linear-gradient(rgba(255,255,255,1) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,1) 1px, transparent 1px)',
          backgroundSize: '48px 48px',
        }}
      />

      <div className="relative z-10 flex flex-col items-center gap-7 px-6 text-center max-w-md">
        {/* Animated ghost */}
        <div className="relative">
          <motion.div
            className="pointer-events-none absolute inset-0 rounded-full blur-3xl"
            style={{ background: 'rgba(233,69,96,0.18)' }}
            animate={{ opacity: [0.5, 0.9, 0.5], scale: [0.9, 1.1, 0.9] }}
            transition={{ duration: 3.5, repeat: Infinity, ease: 'easeInOut' }}
          />
          <motion.div
            className="relative select-none"
            animate={{ y: [0, -14, 0] }}
            transition={{ duration: 3.2, repeat: Infinity, ease: 'easeInOut' }}
          >
            <Image src="/logo.svg" alt="Clawboo" width={84} height={77} priority />
          </motion.div>
        </div>

        {/* Wordmark */}
        <div className="flex flex-col items-center gap-2">
          <h1
            className="text-[54px] font-bold tracking-tight text-text leading-none"
            style={{ fontFamily: 'var(--font-display)' }}
          >
            Clawboo
          </h1>
          <p className="text-[21px] font-light tracking-wide text-secondary">
            Your AI agents, visible.
          </p>
          <p className="text-[13px] text-secondary/45 mt-1 leading-relaxed">
            Mission control for your OpenClaw agent fleet.
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
          className="flex items-center gap-2.5 h-[52px] px-9 rounded-xl bg-accent font-semibold text-[15px] text-white shadow-[0_0_36px_rgba(233,69,96,0.45)] transition hover:brightness-110 active:scale-[0.98]"
        >
          Get Started
          <ArrowRight className="h-4 w-4" strokeWidth={2.5} />
        </motion.button>

        <p className="text-[11px] text-secondary/25 font-mono -mt-2">Requires OpenClaw Gateway</p>
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
        <StepIndicator current="connect" />

        <h2
          className="text-[20px] font-bold text-text mb-1"
          style={{ fontFamily: 'var(--font-display)' }}
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
              className="h-10 rounded-lg border border-white/10 bg-background px-3 font-mono text-[13px] text-text outline-none transition placeholder:text-secondary/30 focus:border-white/20 focus:ring-1 focus:ring-ring/30 disabled:opacity-50"
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
                className="h-10 w-full rounded-lg border border-white/10 bg-background px-3 pr-10 font-mono text-[13px] text-text outline-none transition placeholder:text-secondary/30 focus:border-white/20 focus:ring-1 focus:ring-ring/30 disabled:opacity-50"
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
            className="mt-1 flex h-11 w-full items-center justify-center gap-2 rounded-lg bg-accent font-mono text-[13px] font-semibold tracking-wide text-white shadow-sm transition hover:brightness-110 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50"
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
  onPickTeam: (profile: TeamProfile) => void
  onSkip: () => void
}) {
  return (
    <div className="w-full max-w-4xl">
      <div className="rounded-2xl border border-white/8 bg-surface shadow-[0_32px_80px_rgba(0,0,0,0.65)] p-8">
        {/* Step indicator — centered */}
        <div className="flex justify-center mb-6">
          <StepIndicator current="team" />
        </div>

        <h2
          className="text-[20px] font-bold text-text text-center mb-1"
          style={{ fontFamily: 'var(--font-display)' }}
        >
          Choose your team
        </h2>
        <p className="text-[12px] text-secondary text-center mb-7">
          Deploy a ready-made crew of Boos — or skip to start with an empty fleet.
        </p>

        {/* Profile grid */}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {PROFILES.map((profile) => (
            <button
              key={profile.id}
              type="button"
              onClick={() => onPickTeam(profile)}
              className="group flex flex-col text-left rounded-xl border border-white/8 bg-background/50 p-4 transition-all duration-150 hover:border-white/16 hover:bg-background/80 hover:shadow-lg active:scale-[0.99]"
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
                  <div className="text-[11px] text-secondary">{profile.agents.length} Boos</div>
                </div>
              </div>

              {/* Description */}
              <p className="mb-3 text-[11.5px] leading-relaxed text-secondary/70">
                {profile.description}
              </p>

              {/* Agent avatars */}
              <div className="mb-3 flex gap-1.5 items-center">
                {profile.agents.slice(0, 3).map((agent) => (
                  <BooAvatar key={agent.name} seed={agent.name} size={20} />
                ))}
                <span className="ml-1 text-[10px] text-secondary/40 font-mono">
                  {profile.agents.map((a) => a.name.split(' ')[0]).join(', ')}
                </span>
              </div>

              {/* Skill tags */}
              <div className="mt-auto flex flex-wrap gap-1">
                {profile.skills.slice(0, 3).map((skill) => (
                  <span
                    key={skill}
                    className="rounded-full border border-white/8 bg-white/4 px-2 py-0.5 font-mono text-[9px] text-secondary/60"
                  >
                    {skill}
                  </span>
                ))}
                {profile.skills.length > 3 && (
                  <span className="rounded-full border border-white/8 bg-white/4 px-2 py-0.5 font-mono text-[9px] text-secondary/40">
                    +{profile.skills.length - 3}
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
          ))}
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
  profile: TeamProfile
  client: GatewayClient
  onComplete: () => void
}) {
  const [progress, setProgress] = useState(0)
  const [currentName, setCurrentName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const fired = useRef(false)

  useEffect(() => {
    if (fired.current) return
    fired.current = true

    const deploy = async () => {
      const tools = buildToolsMd(profile.skills)
      try {
        const workspaceDir = await resolveWorkspaceDir(client)
        for (let i = 0; i < profile.agents.length; i++) {
          const agent = profile.agents[i]!
          setCurrentName(agent.name)
          await createAgent(client, agent.name, workspaceDir, {
            soul: agent.soulTemplate,
            identity: agent.identityTemplate,
            tools,
          })
          setProgress(i + 1)
        }
        // brief pause to let "All Boos deployed!" read
        await new Promise<void>((r) => setTimeout(r, 700))
        onComplete()
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Deployment failed')
      }
    }

    void deploy()
  }, [profile, client, onComplete])

  const pct = profile.agents.length > 0 ? (progress / profile.agents.length) * 100 : 0
  const allDone = progress === profile.agents.length

  return (
    <WizardCard>
      <div className="p-8">
        <div className="flex justify-center mb-7">
          <StepIndicator current="deploy" />
        </div>

        <div className="flex flex-col items-center gap-5 text-center">
          {/* Ghost row — one ghost per agent, lights up as deployed */}
          <div className="flex gap-3 items-end">
            {profile.agents.map((agent, i) => (
              <motion.div
                key={agent.name}
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
              style={{ fontFamily: 'var(--font-display)' }}
            >
              {allDone ? (
                <>
                  {profile.emoji} {profile.name} deployed!
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
                  {allDone ? `All ${profile.agents.length} Boos ready` : `Creating ${currentName}…`}
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
          <div className="w-[220px] h-1.5 rounded-full bg-white/8 overflow-hidden">
            <motion.div
              className="h-full rounded-full bg-accent"
              animate={{ width: `${pct}%` }}
              transition={{ duration: 0.38, ease: 'easeOut' }}
            />
          </div>

          {/* Counter */}
          <p className="font-mono text-[10px] text-secondary/35">
            {progress} / {profile.agents.length} Boos created
          </p>

          {/* Error escape hatch */}
          {error && (
            <button
              type="button"
              onClick={onComplete}
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

// ─── Step 4: Done ─────────────────────────────────────────────────────────────

function DoneStep({
  profile,
  onViewGraph,
}: {
  profile: TeamProfile | null
  onViewGraph: () => void
}) {
  // Auto-advance so the user doesn't have to click
  useEffect(() => {
    const timer = setTimeout(onViewGraph, 1_600)
    return () => clearTimeout(timer)
  }, [onViewGraph])

  return (
    <WizardCard>
      <div className="p-8 flex flex-col items-center text-center gap-5">
        <motion.div
          initial={{ scale: 0.4, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ type: 'spring', stiffness: 380, damping: 22 }}
          className="text-[62px] leading-none select-none"
        >
          🎉
        </motion.div>

        <div>
          <h2
            className="text-[22px] font-bold text-text"
            style={{ fontFamily: 'var(--font-display)' }}
          >
            Your Ghost Graph is ready!
          </h2>
          <p className="mt-1.5 text-[13px] text-secondary/70">
            {profile
              ? `${profile.agents.length} Boo${profile.agents.length !== 1 ? 's' : ''} deployed and waiting for instructions.`
              : 'Your fleet is ready. Add Boos anytime from the sidebar.'}
          </p>
        </div>

        <motion.button
          type="button"
          onClick={onViewGraph}
          whileHover={{ scale: 1.03 }}
          whileTap={{ scale: 0.97 }}
          className="flex items-center gap-2 h-11 px-6 rounded-xl bg-accent font-semibold text-[14px] text-white transition hover:brightness-110"
        >
          View Ghost Graph
          <ArrowRight className="h-4 w-4" strokeWidth={2.5} />
        </motion.button>

        <p className="font-mono text-[10px] text-secondary/25">Opening automatically…</p>
      </div>
    </WizardCard>
  )
}

// ─── OnboardingWizard ─────────────────────────────────────────────────────────

export function OnboardingWizard({ onComplete }: OnboardingWizardProps) {
  const [step, setStep] = useState<WizardStep>('welcome')
  const [prevStep, setPrevStep] = useState<WizardStep>('welcome')
  const [client, setClient] = useState<GatewayClient | null>(null)
  const [gatewayUrl, setGatewayUrl] = useState('')
  const [selectedProfile, setSelectedProfile] = useState<TeamProfile | null>(null)

  const goTo = useCallback(
    (next: WizardStep) => {
      setPrevStep(step)
      setStep(next)
    },
    [step],
  )

  const handleConnected = useCallback(
    (newClient: GatewayClient, url: string) => {
      setClient(newClient)
      setGatewayUrl(url)
      goTo('team')
    },
    [goTo],
  )

  const handlePickTeam = useCallback(
    (profile: TeamProfile) => {
      setSelectedProfile(profile)
      goTo('deploy')
    },
    [goTo],
  )

  const handleSkipTeam = useCallback(() => {
    goTo('done')
  }, [goTo])

  const handleDeployComplete = useCallback(() => {
    goTo('done')
  }, [goTo])

  const handleViewGraph = useCallback(() => {
    if (client) onComplete(client, gatewayUrl)
  }, [client, gatewayUrl, onComplete])

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
            <WelcomeStep onContinue={() => goTo('connect')} />
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

        {step === 'done' && (
          <motion.div
            key="done"
            variants={directedVariants}
            initial="enter"
            animate="center"
            exit="exit"
            transition={stepTransition}
            className="w-full flex justify-center"
          >
            <DoneStep profile={selectedProfile} onViewGraph={handleViewGraph} />
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  )
}
