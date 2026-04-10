import { useState, useCallback, useEffect, useMemo } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { ArrowLeft, CheckCircle2, Info, Search, X } from 'lucide-react'
import { BooAvatar } from '@clawboo/ui'
import { useConnectionStore } from '@/stores/connection'
import { useTeamStore } from '@/stores/team'
import { useFleetStore } from '@/stores/fleet'
import { useToastStore } from '@/stores/toast'
import { resolveWorkspaceDir, createAgent, buildToolsMd } from '@/lib/createAgent'
import { computeDedupSuffix, rewriteAgentsMd, rewriteTemplateName } from '@/lib/deployDedup'
import { mergeSoulWithPersonality, type PersonalityValues } from '@/lib/soulPersonality'
import { hydrateTeams } from '@/lib/hydrateTeams'
import { useGraphStore } from '@/features/graph/store'
import type {
  TeamProfile,
  TeamTemplate,
  ProfileLike,
  TemplateSource,
  TemplateCategory,
} from './types'
import {
  BROWSABLE_TEAM_CATALOG,
  searchBrowsableCatalog,
  TEMPLATE_CATEGORIES,
  SOURCE_META,
} from '@/features/marketplace/teamCatalog'
import { TeamTemplateDetail } from '@/features/marketplace/TeamTemplateDetail'

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

// ─── Pick-step source filter entries (agency-agents first, clawboo last) ─────

const PICK_SOURCE_ENTRIES: { key: TemplateSource | 'all'; label: string; color: string }[] = [
  { key: 'all', label: 'All', color: '#E8E8E8' },
  {
    key: 'agency-agents',
    label: SOURCE_META['agency-agents'].label,
    color: SOURCE_META['agency-agents'].color,
  },
  {
    key: 'awesome-openclaw',
    label: SOURCE_META['awesome-openclaw'].label,
    color: SOURCE_META['awesome-openclaw'].color,
  },
  { key: 'clawboo', label: SOURCE_META.clawboo.label, color: SOURCE_META.clawboo.color },
]

// ─── Steps ───────────────────────────────────────────────────────────────────

type Step = 'pick' | 'customize' | 'deploy' | 'complete'

type DeployProgress = { current: number; total: number; label: string }

// ─── Props ───────────────────────────────────────────────────────────────────

interface CreateTeamModalProps {
  isOpen: boolean
  onClose: () => void
  onCreated: () => void
  /** When provided, skip the "pick" step and go directly to "customize" with this profile. */
  initialProfile?: ProfileLike | null
}

// ─── Component ───────────────────────────────────────────────────────────────

export function CreateTeamModal({
  isOpen,
  onClose,
  onCreated,
  initialProfile,
}: CreateTeamModalProps) {
  const client = useConnectionStore((s) => s.client)

  const [step, setStep] = useState<Step>('pick')

  // Jump to customize step when opened with a pre-filled profile
  useEffect(() => {
    if (isOpen && initialProfile) {
      setSelectedProfile(initialProfile)
      setTeamName(initialProfile.name)
      setTeamIcon(initialProfile.emoji)
      setTeamColor(initialProfile.color)
      setStep('customize')
    }
  }, [isOpen, initialProfile])
  const [selectedProfile, setSelectedProfile] = useState<ProfileLike | null>(null)

  // Customize fields
  const [teamName, setTeamName] = useState('')
  const [teamIcon, setTeamIcon] = useState('')
  const [teamColor, setTeamColor] = useState<string>(PRESET_COLORS[0])

  // Deploy state
  const [progress, setProgress] = useState<DeployProgress | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Pick-step filter state (local, not in Zustand)
  const [pickSearch, setPickSearch] = useState('')
  const [pickCategory, setPickCategory] = useState<TemplateCategory | 'all'>('all')
  const [pickSource, setPickSource] = useState<TemplateSource | 'all'>('all')
  const [detailTemplate, setDetailTemplate] = useState<TeamTemplate | null>(null)

  const filteredTemplates = useMemo(() => {
    let results = pickSearch ? searchBrowsableCatalog(pickSearch) : [...BROWSABLE_TEAM_CATALOG]
    if (pickCategory !== 'all') results = results.filter((t) => t.category === pickCategory)
    if (pickSource !== 'all') results = results.filter((t) => t.source === pickSource)
    return results
  }, [pickSearch, pickCategory, pickSource])

  const activeCategories = useMemo(() => {
    const catSet = new Set(BROWSABLE_TEAM_CATALOG.map((t) => t.category))
    return TEMPLATE_CATEGORIES.filter((c) => catSet.has(c.key))
  }, [])

  const reset = useCallback(() => {
    setStep('pick')
    setSelectedProfile(null)
    setTeamName('')
    setTeamIcon('')
    setTeamColor(PRESET_COLORS[0])
    setProgress(null)
    setError(null)
    setPickSearch('')
    setPickCategory('all')
    setPickSource('all')
    setDetailTemplate(null)
  }, [])

  const handleClose = useCallback(() => {
    if (step === 'deploy') return // can't close while deploying
    reset()
    onClose()
  }, [step, reset, onClose])

  // Step A → Step B
  const handlePickProfile = useCallback((profile: ProfileLike) => {
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
      // ── Dedup: auto-suffix if agent/team names collide with existing ones ──
      const existingAgentNames = useFleetStore.getState().agents.map((a) => a.name)
      const existingTeamNames = useTeamStore.getState().teams.map((t) => t.name)
      const desiredAgentNames = selectedProfile ? selectedProfile.agents.map((a) => a.name) : []
      const dedupPlan = computeDedupSuffix(
        desiredAgentNames,
        existingAgentNames,
        name,
        existingTeamNames,
      )
      const finalTeamName = dedupPlan.teamName

      // Create the team via API
      const res = await fetch('/api/teams', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: finalTeamName,
          icon: teamIcon,
          color: teamColor,
          templateId: selectedProfile?.id ?? null,
        }),
      })
      if (!res.ok) throw new Error('Failed to create team')
      const { team } = (await res.json()) as {
        team: { id: string; name: string; icon: string; color: string; templateId: string | null }
      }

      // Add to store + select
      useTeamStore.getState().addTeam({
        id: team.id,
        name: team.name,
        icon: team.icon,
        color: team.color,
        templateId: team.templateId ?? null,
        leaderAgentId: null,
        isArchived: false,
        agentCount: 0,
      })
      useTeamStore.getState().selectTeam(team.id)

      if (!selectedProfile) {
        // Empty team — done
        useToastStore
          .getState()
          .addToast({ type: 'success', message: `Team "${finalTeamName}" created` })
        reset()
        onClose()
        onCreated()
        return
      }

      // Template team → deploy agents
      setStep('deploy')
      const profile = selectedProfile
      const isNewFormat = 'toolsTemplate' in (profile.agents[0] ?? {})
      const legacyTools =
        !isNewFormat && 'skills' in profile
          ? buildToolsMd((profile as TeamProfile).skills)
          : '# TOOLS\n'

      const workspaceDir = await resolveWorkspaceDir(client)
      let firstAgentId: string | null = null
      for (let i = 0; i < profile.agents.length; i++) {
        const agent = profile.agents[i]
        const finalAgentName = dedupPlan.agentNameMap.get(agent.name) ?? agent.name
        setProgress({ current: i, total: profile.agents.length, label: finalAgentName })

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

        const agentId = await createAgent(client, finalAgentName, workspaceDir, {
          soul: soulWithPersonality,
          identity: rewriteTemplateName(agent.identityTemplate, agent.name, finalAgentName),
          tools: isNewFormat
            ? (agent as TeamTemplate['agents'][number]).toolsTemplate
            : legacyTools,
          agents: isNewFormat
            ? rewriteAgentsMd(
                (agent as TeamTemplate['agents'][number]).agentsTemplate,
                dedupPlan.agentNameMap,
              )
            : undefined,
        })

        // Persist default personality to SQLite so sliders load correctly
        void fetch('/api/personality', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ agentId, values: defaultPersonality }),
        }).catch(() => {})

        if (i === 0) firstAgentId = agentId

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

      // Set first agent as team leader (best-effort)
      if (firstAgentId && team.id) {
        try {
          await fetch(`/api/teams/${team.id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ leaderAgentId: firstAgentId }),
          })
          useTeamStore.getState().updateTeam(team.id, { leaderAgentId: firstAgentId })
        } catch {
          // leader assignment is non-fatal
        }
      }

      setProgress({
        current: profile.agents.length,
        total: profile.agents.length,
        label: 'Done!',
      })

      // Auto-enable agent-to-agent coordination if any agent has routing
      const hasRouting = profile.agents.some((a) => {
        const agentsMd =
          'agentsTemplate' in a ? (a as TeamTemplate['agents'][number]).agentsTemplate : undefined
        return agentsMd && /@[\w"']/.test(agentsMd)
      })
      if (hasRouting) {
        try {
          await fetch('/api/system/openclaw-config', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ agentToAgent: { enabled: true } }),
          })
        } catch {
          // config patch failure is non-fatal — user can enable manually in System panel
        }
      }

      // Re-hydrate fleet from gateway to pick up new agents
      try {
        const result = await client.agents.list()
        const mainKey = result.mainKey?.trim() || 'main'
        // Preserve existing teamId + execConfig assignments — Gateway doesn't know about these
        const existing = useFleetStore.getState().agents
        const existingTeamIds = new Map(existing.map((a) => [a.id, a.teamId]))
        const existingExecConfigs = new Map(existing.map((a) => [a.id, a.execConfig]))
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
            teamId: existingTeamIds.get(a.id) ?? null,
            execConfig: existingExecConfigs.get(a.id) ?? null,
          })),
        )
      } catch {
        // hydration failure is non-fatal
      }

      // Re-hydrate teams from SQLite to patch fleet store with correct assignments
      await hydrateTeams()
      useGraphStore.getState().triggerRefresh()

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
      setStep('customize')
    }
  }, [client, teamName, teamIcon, teamColor, selectedProfile, reset, onClose, onCreated])

  if (!isOpen) return null

  return (
    <>
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
            className={`relative w-full ${step === 'pick' ? 'max-w-2xl' : 'max-w-lg'} rounded-2xl border border-white/8 bg-surface shadow-[0_16px_64px_rgba(0,0,0,0.6)] transition-all duration-200`}
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
                <p className="mb-4 text-[12px] text-secondary">
                  {filteredTemplates.length} template{filteredTemplates.length !== 1 ? 's' : ''}{' '}
                  available — pick one or start empty.
                </p>

                {/* Search input */}
                <div className="relative mb-3">
                  <Search
                    className="absolute left-3 top-1/2 -translate-y-1/2 text-secondary/40"
                    style={{ width: 14, height: 14 }}
                    strokeWidth={2}
                  />
                  <input
                    type="text"
                    value={pickSearch}
                    onChange={(e) => setPickSearch(e.target.value)}
                    placeholder="Search templates..."
                    className="w-full rounded-lg border border-white/8 bg-white/[0.03] py-2 pl-8 pr-3 text-[12px] text-text outline-none transition placeholder:text-secondary/35 focus:border-white/15"
                    style={{ fontFamily: 'var(--font-body)' }}
                  />
                </div>

                {/* Category pills */}
                <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 6 }}>
                  <button
                    type="button"
                    onClick={() => setPickCategory('all')}
                    style={{
                      background: pickCategory === 'all' ? 'rgba(232,232,232,0.12)' : 'transparent',
                      border:
                        pickCategory === 'all'
                          ? '1px solid rgba(232,232,232,0.3)'
                          : '1px solid rgba(255,255,255,0.06)',
                      color: pickCategory === 'all' ? '#E8E8E8' : 'rgba(232,232,232,0.45)',
                      borderRadius: 12,
                      padding: '2px 8px',
                      fontSize: 10,
                      fontWeight: 500,
                      cursor: 'pointer',
                      transition: 'all 0.15s',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    All
                  </button>
                  {activeCategories.map((cat) => {
                    const isActive = pickCategory === cat.key
                    return (
                      <button
                        key={cat.key}
                        type="button"
                        onClick={() => setPickCategory(cat.key)}
                        style={{
                          background: isActive ? `${cat.color}20` : 'transparent',
                          border: isActive
                            ? `1px solid ${cat.color}55`
                            : '1px solid rgba(255,255,255,0.06)',
                          color: isActive ? cat.color : 'rgba(232,232,232,0.45)',
                          borderRadius: 12,
                          padding: '2px 8px',
                          fontSize: 10,
                          fontWeight: 500,
                          cursor: 'pointer',
                          transition: 'all 0.15s',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {cat.label}
                      </button>
                    )
                  })}
                </div>

                {/* Source pills */}
                <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 10 }}>
                  {PICK_SOURCE_ENTRIES.map((src) => {
                    const isActive = pickSource === src.key
                    return (
                      <button
                        key={src.key}
                        type="button"
                        onClick={() => setPickSource(src.key)}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 5,
                          background: isActive ? `${src.color}20` : 'transparent',
                          border: isActive
                            ? `1px solid ${src.color}55`
                            : '1px solid rgba(255,255,255,0.06)',
                          color: isActive ? src.color : 'rgba(232,232,232,0.45)',
                          borderRadius: 12,
                          padding: '2px 8px',
                          fontSize: 10,
                          fontWeight: 500,
                          cursor: 'pointer',
                          transition: 'all 0.15s',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {src.key !== 'all' && (
                          <div
                            style={{
                              width: 5,
                              height: 5,
                              borderRadius: '50%',
                              background: src.color,
                              flexShrink: 0,
                            }}
                          />
                        )}
                        {src.label}
                      </button>
                    )
                  })}
                </div>

                {/* Scrollable template list */}
                <div
                  style={{
                    maxHeight: 380,
                    overflowY: 'auto',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 4,
                  }}
                >
                  {filteredTemplates.length === 0 && (
                    <div className="flex items-center justify-center py-10 text-[12px] text-secondary/40">
                      No templates match your search.
                    </div>
                  )}
                  {filteredTemplates.map((profile) => {
                    const srcMeta = SOURCE_META[profile.source]
                    return (
                      <button
                        key={profile.id}
                        type="button"
                        onClick={() => handlePickProfile(profile)}
                        className="flex items-center gap-3 rounded-xl border border-white/6 bg-white/[0.02] px-3 py-2.5 text-left transition-colors hover:bg-white/[0.05]"
                      >
                        <div
                          className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg text-base"
                          style={{
                            backgroundColor: `${profile.color}22`,
                            border: `1px solid ${profile.color}33`,
                          }}
                        >
                          {profile.emoji}
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="text-[12px] font-semibold text-text">
                              {profile.name}
                            </span>
                            <span className="text-[10px] text-secondary/40">
                              {profile.agents.length} agents
                            </span>
                            <span
                              style={{
                                color: srcMeta.color,
                                background: `${srcMeta.color}18`,
                                border: `1px solid ${srcMeta.color}35`,
                                borderRadius: 4,
                                padding: '0px 4px',
                                fontSize: 9,
                                fontWeight: 600,
                                letterSpacing: '0.02em',
                                whiteSpace: 'nowrap',
                              }}
                            >
                              {srcMeta.label}
                            </span>
                          </div>
                          <div className="mt-0.5 truncate text-[10px] leading-snug text-secondary/45">
                            {profile.description}
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation()
                            setDetailTemplate(profile)
                          }}
                          className="flex-shrink-0 rounded p-1 text-secondary/25 transition-colors hover:text-secondary/60"
                        >
                          <Info style={{ width: 14, height: 14 }} strokeWidth={2} />
                        </button>
                      </button>
                    )
                  })}
                </div>

                {/* Start empty */}
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

                {/* Safety-net error display (catch should reset to customize, but just in case) */}
                {error && (
                  <div className="mt-4 flex w-full max-w-xs flex-col items-center gap-2">
                    <p className="text-center text-[11px] text-destructive">{error}</p>
                    <button
                      type="button"
                      onClick={() => setStep('customize')}
                      className="rounded-lg border border-white/10 px-4 py-1.5 text-[12px] font-medium text-secondary transition-colors hover:text-text"
                    >
                      Back
                    </button>
                  </div>
                )}
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

      {/* Template detail overlay */}
      {detailTemplate && (
        <TeamTemplateDetail
          template={detailTemplate}
          onClose={() => setDetailTemplate(null)}
          onDeploy={(t) => {
            setDetailTemplate(null)
            handlePickProfile(t)
          }}
        />
      )}
    </>
  )
}
