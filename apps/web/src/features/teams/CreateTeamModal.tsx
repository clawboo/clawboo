import { useState, useCallback } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { ArrowLeft, CheckCircle2, X } from 'lucide-react'
import { BooAvatar } from '@clawboo/ui'
import { useConnectionStore } from '@/stores/connection'
import { useTeamStore } from '@/stores/team'
import { useFleetStore } from '@/stores/fleet'
import { useToastStore } from '@/stores/toast'
import { resolveWorkspaceDir, createAgent } from '@/lib/createAgent'
import type { TeamProfile } from './types'

import marketingRaw from './profiles/marketing.json'
import devRaw from './profiles/dev.json'
import researchRaw from './profiles/research.json'
import youtubeRaw from './profiles/youtube.json'
import studentRaw from './profiles/student.json'

// ─── Constants ───────────────────────────────────────────────────────────────

const PROFILES: TeamProfile[] = [marketingRaw, devRaw, researchRaw, youtubeRaw, studentRaw]

const PRESET_COLORS = [
  '#E94560',
  '#34D399',
  '#FBBF24',
  '#60A5FA',
  '#A78BFA',
  '#F472B6',
  '#38BDF8',
  '#FB923C',
] as const

function buildToolsMd(skills: string[]): string {
  if (!skills.length) return '# TOOLS\n'
  return `# TOOLS\n\n## Skills\n${skills.map((s) => `- ${s}`).join('\n')}\n`
}

// ─── Steps ───────────────────────────────────────────────────────────────────

type Step = 'pick' | 'customize' | 'deploy' | 'complete'

type DeployProgress = { current: number; total: number; label: string }

// ─── Props ───────────────────────────────────────────────────────────────────

interface CreateTeamModalProps {
  isOpen: boolean
  onClose: () => void
  onCreated: () => void
}

// ─── Component ───────────────────────────────────────────────────────────────

export function CreateTeamModal({ isOpen, onClose, onCreated }: CreateTeamModalProps) {
  const client = useConnectionStore((s) => s.client)

  const [step, setStep] = useState<Step>('pick')
  const [selectedProfile, setSelectedProfile] = useState<TeamProfile | null>(null)

  // Customize fields
  const [teamName, setTeamName] = useState('')
  const [teamIcon, setTeamIcon] = useState('')
  const [teamColor, setTeamColor] = useState<string>(PRESET_COLORS[0])

  // Deploy state
  const [progress, setProgress] = useState<DeployProgress | null>(null)
  const [error, setError] = useState<string | null>(null)

  const reset = useCallback(() => {
    setStep('pick')
    setSelectedProfile(null)
    setTeamName('')
    setTeamIcon('')
    setTeamColor(PRESET_COLORS[0])
    setProgress(null)
    setError(null)
  }, [])

  const handleClose = useCallback(() => {
    if (step === 'deploy') return // can't close while deploying
    reset()
    onClose()
  }, [step, reset, onClose])

  // Step A → Step B
  const handlePickProfile = useCallback((profile: TeamProfile) => {
    setSelectedProfile(profile)
    setTeamName(profile.name)
    setTeamIcon(profile.emoji)
    setTeamColor(profile.color)
    setStep('customize')
  }, [])

  const handlePickEmpty = useCallback(() => {
    setSelectedProfile(null)
    setTeamName('New Team')
    setTeamIcon('👻')
    setTeamColor(PRESET_COLORS[0])
    setStep('customize')
  }, [])

  // Step B → create (empty) or deploy (template)
  const handleConfirmCustomize = useCallback(async () => {
    if (!client) return
    const name = teamName.trim()
    if (!name) return

    setError(null)

    try {
      // Create the team via API
      const res = await fetch('/api/teams', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          icon: teamIcon,
          color: teamColor,
          templateId: selectedProfile?.id ?? null,
        }),
      })
      if (!res.ok) throw new Error('Failed to create team')
      const team = await res.json()

      // Add to store + select
      useTeamStore.getState().addTeam({
        id: team.id,
        name: team.name,
        icon: team.icon,
        color: team.color,
        templateId: team.templateId ?? null,
        agentCount: 0,
      })
      useTeamStore.getState().selectTeam(team.id)

      if (!selectedProfile) {
        // Empty team — done
        useToastStore.getState().addToast({ type: 'success', message: `Team "${name}" created` })
        reset()
        onClose()
        onCreated()
        return
      }

      // Template team → deploy agents
      setStep('deploy')
      const profile = selectedProfile
      const tools = buildToolsMd(profile.skills)

      const workspaceDir = await resolveWorkspaceDir(client)
      for (let i = 0; i < profile.agents.length; i++) {
        const agent = profile.agents[i]
        setProgress({ current: i, total: profile.agents.length, label: agent.name })

        const agentId = await createAgent(client, agent.name, workspaceDir, {
          soul: agent.soulTemplate,
          identity: agent.identityTemplate,
          tools,
        })

        // Assign agent to team (best-effort)
        try {
          await fetch(`/api/teams/${team.id}/agents`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ agentId }),
          })
        } catch {
          // assignment failure is non-fatal
        }
      }

      setProgress({
        current: profile.agents.length,
        total: profile.agents.length,
        label: 'Done!',
      })

      // Re-hydrate fleet from gateway to pick up new agents
      try {
        const result = await client.agents.list()
        const mainKey = result.mainKey?.trim() || 'main'
        useFleetStore.getState().hydrateAgents(
          result.agents.map((a) => ({
            id: a.id,
            name: a.identity?.name ?? a.name ?? a.id,
            status: 'idle' as const,
            sessionKey: `agent:${a.id}:${mainKey}`,
            model: null,
            createdAt: null,
            streamingText: null,
            runId: null,
            lastSeenAt: null,
            teamId: null,
          })),
        )
      } catch {
        // hydration failure is non-fatal
      }

      setStep('complete')
      useToastStore.getState().addToast({
        type: 'success',
        message: `Team "${name}" deployed with ${profile.agents.length} agents`,
      })
      setTimeout(() => {
        reset()
        onClose()
        onCreated()
      }, 800)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong')
      if (step === 'deploy') setStep('customize')
    }
  }, [client, teamName, teamIcon, teamColor, selectedProfile, reset, onClose, onCreated, step])

  if (!isOpen) return null

  return (
    <AnimatePresence>
      <motion.div
        key="create-team-backdrop"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
        onClick={handleClose}
      >
        <motion.div
          initial={{ opacity: 0, scale: 0.95, y: 8 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.95, y: 8 }}
          transition={{ type: 'spring', stiffness: 280, damping: 28 }}
          className="relative w-full max-w-lg rounded-2xl border border-white/8 bg-surface shadow-[0_16px_64px_rgba(0,0,0,0.6)]"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Close button */}
          {step !== 'deploy' && (
            <button
              type="button"
              onClick={handleClose}
              className="absolute right-3 top-3 rounded-lg p-1.5 text-secondary/40 transition-colors hover:text-text"
            >
              <X className="h-4 w-4" strokeWidth={2} />
            </button>
          )}

          {/* ─── Step: Pick Template ────────────────────────────── */}
          {step === 'pick' && (
            <div className="p-6">
              <h2
                className="mb-1 text-lg font-bold text-text"
                style={{ fontFamily: 'var(--font-display)' }}
              >
                Create a team
              </h2>
              <p className="mb-5 text-[12px] text-secondary">
                Pick a template or start with an empty team.
              </p>

              <div className="flex flex-col gap-2">
                {PROFILES.map((profile) => (
                  <button
                    key={profile.id}
                    type="button"
                    onClick={() => handlePickProfile(profile)}
                    className="flex items-center gap-3 rounded-xl border border-white/6 bg-white/[0.02] px-4 py-3 text-left transition-colors hover:bg-white/[0.05]"
                  >
                    <div
                      className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg text-lg"
                      style={{
                        backgroundColor: `${profile.color}22`,
                        border: `1px solid ${profile.color}33`,
                      }}
                    >
                      {profile.emoji}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="text-[13px] font-semibold text-text">{profile.name}</div>
                      <div className="truncate text-[11px] text-secondary/60">
                        {profile.agents.length} agents — {profile.description}
                      </div>
                    </div>
                  </button>
                ))}
              </div>

              <button
                type="button"
                onClick={handlePickEmpty}
                className="mt-3 flex w-full items-center justify-center gap-2 rounded-xl border border-dashed border-white/12 px-4 py-3 text-[12px] font-medium text-secondary/60 transition-colors hover:border-white/20 hover:text-secondary"
              >
                Start empty
              </button>
            </div>
          )}

          {/* ─── Step: Customize ────────────────────────────────── */}
          {step === 'customize' && (
            <div className="p-6">
              <div className="mb-5 flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setStep('pick')}
                  className="rounded p-1 text-secondary/40 transition-colors hover:text-text"
                >
                  <ArrowLeft className="h-4 w-4" strokeWidth={2} />
                </button>
                <h2
                  className="text-lg font-bold text-text"
                  style={{ fontFamily: 'var(--font-display)' }}
                >
                  Customize team
                </h2>
              </div>

              {/* Name */}
              <label className="mb-4 block">
                <span className="mb-1 block text-[11px] font-medium uppercase tracking-wider text-secondary">
                  Name
                </span>
                <input
                  type="text"
                  value={teamName}
                  onChange={(e) => setTeamName(e.target.value)}
                  className="w-full rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-[13px] text-text outline-none placeholder:text-secondary/40 focus:border-white/20 focus:ring-1 focus:ring-ring/30"
                  placeholder="Team name"
                />
              </label>

              {/* Icon */}
              <label className="mb-4 block">
                <span className="mb-1 block text-[11px] font-medium uppercase tracking-wider text-secondary">
                  Icon
                </span>
                <input
                  type="text"
                  value={teamIcon}
                  onChange={(e) => setTeamIcon(e.target.value)}
                  className="w-20 rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-center text-lg outline-none focus:border-white/20 focus:ring-1 focus:ring-ring/30"
                  maxLength={4}
                />
              </label>

              {/* Color */}
              <div className="mb-5">
                <span className="mb-2 block text-[11px] font-medium uppercase tracking-wider text-secondary">
                  Color
                </span>
                <div className="flex flex-wrap gap-2">
                  {PRESET_COLORS.map((color) => (
                    <button
                      key={color}
                      type="button"
                      onClick={() => setTeamColor(color)}
                      className="h-7 w-7 rounded-full transition-all"
                      style={{
                        backgroundColor: color,
                        boxShadow:
                          teamColor === color ? `0 0 0 2px #0A0E1A, 0 0 0 4px ${color}` : 'none',
                      }}
                    />
                  ))}
                </div>
              </div>

              {/* Preview */}
              <div className="mb-5 flex items-center gap-3 rounded-xl border border-white/6 bg-white/[0.02] px-4 py-3">
                <div
                  className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl text-xl"
                  style={{
                    backgroundColor: `${teamColor}22`,
                    border: `1px solid ${teamColor}33`,
                  }}
                >
                  {teamIcon}
                </div>
                <div>
                  <div className="text-[13px] font-semibold text-text">
                    {teamName || 'Untitled'}
                  </div>
                  <div className="text-[11px] text-secondary/60">
                    {selectedProfile
                      ? `${selectedProfile.agents.length} agents from template`
                      : 'Empty team'}
                  </div>
                </div>
              </div>

              {/* Template agent preview */}
              {selectedProfile && (
                <div className="mb-5">
                  <span className="mb-2 block text-[11px] font-medium uppercase tracking-wider text-secondary">
                    Agents
                  </span>
                  <div className="flex flex-col gap-1.5">
                    {selectedProfile.agents.map((agent) => (
                      <div key={agent.name} className="flex items-center gap-2">
                        <BooAvatar seed={agent.name} size={20} />
                        <span className="text-[12px] text-text/70">{agent.name}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {error && <p className="mb-3 text-[11px] text-destructive">{error}</p>}

              {/* Confirm */}
              <button
                type="button"
                onClick={() => void handleConfirmCustomize()}
                disabled={!teamName.trim()}
                className="flex h-10 w-full items-center justify-center gap-2 rounded-lg text-[13px] font-semibold text-white transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
                style={{ backgroundColor: teamColor }}
              >
                {selectedProfile ? 'Deploy team' : 'Create team'}
              </button>
            </div>
          )}

          {/* ─── Step: Deploy ───────────────────────────────────── */}
          {step === 'deploy' && progress && (
            <div className="flex flex-col items-center px-6 py-10">
              <motion.div
                animate={{ rotate: [0, 10, -10, 0] }}
                transition={{ duration: 2, repeat: Infinity, ease: 'easeInOut' }}
                className="mb-4 text-4xl"
              >
                {teamIcon}
              </motion.div>
              <h2
                className="mb-2 text-lg font-bold text-text"
                style={{ fontFamily: 'var(--font-display)' }}
              >
                Deploying {teamName}
              </h2>
              <p className="mb-6 text-[12px] text-secondary">Creating {progress.label}…</p>

              {/* Progress bar */}
              <div className="mb-2 h-1.5 w-full max-w-xs overflow-hidden rounded-full bg-white/10">
                <motion.div
                  className="h-full rounded-full"
                  style={{ backgroundColor: teamColor }}
                  initial={{ width: '0%' }}
                  animate={{
                    width: `${((progress.current + 1) / (progress.total + 1)) * 100}%`,
                  }}
                  transition={{ duration: 0.3, ease: 'easeOut' }}
                />
              </div>
              <p className="text-[11px] text-secondary/50">
                {progress.current}/{progress.total} agents
              </p>
            </div>
          )}

          {/* ─── Step: Complete ─────────────────────────────────── */}
          {step === 'complete' && (
            <div className="flex flex-col items-center px-6 py-10">
              <motion.div
                initial={{ scale: 0 }}
                animate={{ scale: 1 }}
                transition={{ type: 'spring', stiffness: 300, damping: 20 }}
              >
                <CheckCircle2
                  className="mb-3 h-12 w-12"
                  strokeWidth={1.5}
                  style={{ color: '#34D399' }}
                />
              </motion.div>
              <h2
                className="mb-1 text-lg font-bold text-text"
                style={{ fontFamily: 'var(--font-display)' }}
              >
                Team deployed!
              </h2>
              <p className="text-[12px] text-secondary">{teamName} is ready to go.</p>
            </div>
          )}
        </motion.div>
      </motion.div>
    </AnimatePresence>
  )
}
