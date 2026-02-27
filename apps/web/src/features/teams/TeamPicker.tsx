'use client'

import { useState, useCallback } from 'react'
import { motion } from 'framer-motion'
import { CheckCircle2, Loader2 } from 'lucide-react'
import type { GatewayClient } from '@clawboo/gateway-client'
import { BooAvatar } from '@clawboo/ui'
import type { TeamProfile } from './types'
import { resolveWorkspaceDir, createAgent } from '@/lib/createAgent'

import marketingRaw from './profiles/marketing.json'
import devRaw from './profiles/dev.json'
import researchRaw from './profiles/research.json'
import youtubeRaw from './profiles/youtube.json'
import studentRaw from './profiles/student.json'

// ─── Profiles ────────────────────────────────────────────────────────────────

const PROFILES: TeamProfile[] = [marketingRaw, devRaw, researchRaw, youtubeRaw, studentRaw]

// ─── Helpers ─────────────────────────────────────────────────────────────────

function buildToolsMd(skills: string[]): string {
  if (!skills.length) return '# TOOLS\n'
  return `# TOOLS\n\n## Skills\n${skills.map((s) => `- ${s}`).join('\n')}\n`
}

// ─── Deploy state ─────────────────────────────────────────────────────────────

type DeployState =
  | { kind: 'idle' }
  | { kind: 'deploying'; progress: number; total: number }
  | { kind: 'done' }
  | { kind: 'error'; message: string }

// ─── Types ────────────────────────────────────────────────────────────────────

export type TeamPickerProps = {
  client: GatewayClient
  onDeployed: () => void
  onSkip: () => void
}

// ─── Component ───────────────────────────────────────────────────────────────

export function TeamPicker({ client, onDeployed, onSkip }: TeamPickerProps) {
  const [deployingId, setDeployingId] = useState<string | null>(null)
  const [deployStates, setDeployStates] = useState<Record<string, DeployState>>({})

  const getState = (id: string): DeployState => deployStates[id] ?? { kind: 'idle' }

  const handleDeploy = useCallback(
    async (profile: TeamProfile) => {
      if (deployingId) return

      setDeployingId(profile.id)
      setDeployStates((prev) => ({
        ...prev,
        [profile.id]: { kind: 'deploying', progress: 0, total: profile.agents.length },
      }))

      const tools = buildToolsMd(profile.skills)

      try {
        const workspaceDir = await resolveWorkspaceDir(client)
        for (let i = 0; i < profile.agents.length; i++) {
          const agent = profile.agents[i]
          await createAgent(client, agent.name, workspaceDir, {
            soul: agent.soulTemplate,
            identity: agent.identityTemplate,
            tools,
          })
          setDeployStates((prev) => ({
            ...prev,
            [profile.id]: { kind: 'deploying', progress: i + 1, total: profile.agents.length },
          }))
        }

        setDeployStates((prev) => ({ ...prev, [profile.id]: { kind: 'done' } }))
        setTimeout(onDeployed, 800)
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Deployment failed'
        setDeployStates((prev) => ({ ...prev, [profile.id]: { kind: 'error', message } }))
        setDeployingId(null)
      }
    },
    [client, deployingId, onDeployed],
  )

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.2 }}
      className="fixed inset-0 z-50 flex flex-col items-center justify-start overflow-y-auto bg-background/95 px-6 py-12 backdrop-blur-sm"
    >
      {/* Header */}
      <motion.div
        initial={{ opacity: 0, y: -10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.05, type: 'spring', stiffness: 280, damping: 28 }}
        className="mb-8 text-center"
      >
        <h1
          className="text-2xl font-bold tracking-tight text-text"
          style={{ fontFamily: 'var(--font-display)' }}
        >
          Choose your team
        </h1>
        <p className="mt-1.5 text-[13px] text-secondary">
          Deploy a ready-made crew of Boos — or skip to start with an empty fleet.
        </p>
      </motion.div>

      {/* Profile cards */}
      <div className="grid w-full max-w-5xl grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {PROFILES.map((profile, i) => {
          const state = getState(profile.id)
          const isDeploying = state.kind === 'deploying'
          const isDone = state.kind === 'done'
          const isDisabled = deployingId !== null && deployingId !== profile.id

          return (
            <motion.div
              key={profile.id}
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.08 + i * 0.05, type: 'spring', stiffness: 280, damping: 28 }}
              className="flex flex-col rounded-2xl border border-white/8 bg-surface p-5 shadow-[0_8px_32px_rgba(0,0,0,0.4)] transition-opacity"
              style={{ opacity: isDisabled ? 0.4 : 1 }}
            >
              {/* Emoji + name */}
              <div className="mb-3 flex items-center gap-3">
                <div
                  className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl text-xl"
                  style={{
                    backgroundColor: `${profile.color}22`,
                    color: profile.color,
                    border: `1px solid ${profile.color}33`,
                  }}
                >
                  {profile.emoji}
                </div>
                <div>
                  <div
                    className="text-[15px] font-semibold text-text"
                    style={{ fontFamily: 'var(--font-display)' }}
                  >
                    {profile.name}
                  </div>
                  <div className="text-[11px] text-secondary">{profile.agents.length} Boos</div>
                </div>
              </div>

              {/* Description */}
              <p className="mb-4 text-[12px] leading-relaxed text-secondary/80">
                {profile.description}
              </p>

              {/* Agent list */}
              <div className="mb-4 flex flex-col gap-2">
                {profile.agents.map((agent) => (
                  <div key={agent.name} className="flex items-center gap-2">
                    <BooAvatar seed={agent.name} size={20} />
                    <span className="text-[12px] text-text/70">{agent.name}</span>
                  </div>
                ))}
              </div>

              {/* Skill tags */}
              <div className="mb-5 flex flex-wrap gap-1.5">
                {profile.skills.map((skill) => (
                  <span
                    key={skill}
                    className="rounded-full border border-white/8 bg-white/4 px-2 py-0.5 font-mono text-[10px] text-secondary"
                  >
                    {skill}
                  </span>
                ))}
              </div>

              {/* Deploy button */}
              <div className="mt-auto">
                {state.kind === 'error' && (
                  <p className="mb-2 text-[11px] text-destructive">{state.message}</p>
                )}
                <button
                  type="button"
                  onClick={() => void handleDeploy(profile)}
                  disabled={isDeploying || isDone || isDisabled}
                  className="flex h-9 w-full items-center justify-center gap-2 rounded-lg font-mono text-[12px] font-semibold tracking-wide text-white transition hover:brightness-110 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-60"
                  style={{ backgroundColor: isDone ? '#34D399' : profile.color }}
                >
                  {isDone ? (
                    <>
                      <CheckCircle2 className="h-3.5 w-3.5" strokeWidth={2.5} />
                      Deployed!
                    </>
                  ) : isDeploying ? (
                    <>
                      <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={2.5} />
                      {state.progress}/{state.total} Boos…
                    </>
                  ) : (
                    'Deploy this team'
                  )}
                </button>
              </div>
            </motion.div>
          )
        })}
      </div>

      {/* Skip link */}
      <motion.button
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.4 }}
        type="button"
        onClick={onSkip}
        disabled={deployingId !== null}
        className="mt-10 font-mono text-[11px] text-secondary/40 underline underline-offset-2 transition hover:text-secondary/70 disabled:pointer-events-none disabled:opacity-20"
      >
        Skip — start with an empty fleet
      </motion.button>
    </motion.div>
  )
}
