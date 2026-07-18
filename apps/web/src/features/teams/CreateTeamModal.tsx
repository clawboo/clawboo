import { useState, useCallback, useEffect, useMemo } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { ArrowLeft, CheckCircle2, X } from 'lucide-react'
import { BooAvatar } from '@clawboo/ui'
import { Button, IconButton } from '@/features/shared/Button'
import { Chip } from '@/features/shared/Chip'
import { SearchInput } from '@/features/shared/SearchInput'
import { FormattedAlert } from '@/features/shared/FormattedAlert'
import { useConnectionStore } from '@/stores/connection'
import { useTeamStore } from '@/stores/team'
import { useFleetStore } from '@/stores/fleet'
import { useToastStore } from '@/stores/toast'
import { useBooZeroStore } from '@/stores/booZero'
import { useSettingsModalStore } from '@/stores/settingsModal'
import { createAgent } from '@/lib/createAgent'
import { refreshFleetFromRegistry } from '@/lib/agentSourceClient'
import { fetchRegistryHealth, fetchRuntimes, type RuntimeStatus } from '@clawboo/control-client'
import {
  agentRuntimeOptions,
  resolveDefaultRuntime,
  suggestedRuntimeFor,
  type RuntimeAvailability,
  type SelectableSourceId,
} from './runtimeSelection'
import {
  NATIVE_LEADER_PROMPT,
  NATIVE_SPECIALIST_PROMPT,
  NATIVE_TEAM_TOOLS,
} from './nativeTeamPrompts'
import { RuntimeSelect } from './RuntimeSelect'
import { nativeModelExec } from '@/lib/nativeModelCatalog'
import { hermesModelExec } from '@/lib/hermesModelCatalog'
import {
  useHermesModelGroups,
  useNativeModelGroups,
  useOpenClawModelGroups,
} from '@/lib/useOpenRouterModels'
import { MODEL_GROUPS, type ModelGroup } from '@/lib/modelCatalog'
import { Select } from '@/features/shared/Select'
import { computeDedupSuffix, rewriteAgentsMd, rewriteTemplateName } from '@/lib/deployDedup'
import { buildClawbooHelpDoc, buildTeamAgentsMd } from '@/lib/teamProtocol'
import { mergeSoulWithPersonality, type PersonalityValues } from '@/lib/soulPersonality'
import { hydrateTeams } from '@/lib/hydrateTeams'
import { detectGenuineLeader, matchedLeadershipKeyword } from '@/lib/genuineLeader'
import { buildTeamBrief, type TeamBriefMember } from '@/lib/booZeroBrief'
import { useGraphStore } from '@/features/graph/store'
import type { TeamTemplate, ProfileLike, TemplateSource, TemplateCategory } from './types'
import { resolveTeamAgents, getAgent } from '@/features/marketplace/teamCatalog'
import { TeamTemplateDetail } from '@/features/marketplace/TeamTemplateDetail'
import { CollapsiblePillRow } from '@/features/marketplace/CollapsiblePillRow'
import {
  TeamShowcaseGrid,
  teamCategoryOptions,
  filterTeams,
  TEAM_SOURCE_ENTRIES,
} from '@/features/marketplace/TeamShowcaseGrid'
import { TeamColorCollectionPicker } from './TeamColorCollectionPicker'
import { TeamAccentPicker, TEAM_ACCENT_PRESETS } from './TeamAccentPicker'
import { TeamIconPicker } from './TeamIconPicker'
import { DEFAULT_COLLECTION_ID, type CollectionId } from '@/lib/teamPalettes'
import { paletteFor } from '@/lib/resolveTeamBooColor'
import { useTheme } from '@/features/theme/useTheme'

// ─── Per-agent model picker ──────────────────────────────────────────────────
// A per-agent model is supported by native (AgentConfig.primaryModel, applied via
// execConfig at create), OpenClaw (a per-agent override in openclaw.json's
// agents.list[], applied via a config PATCH after create), AND Hermes (a
// `{ provider, model }` execConfig the server threads into `hermes chat -m …
// --provider …`). Codex / Claude Code run the delegated task on their own
// account / SDK default — model-inert as team members — so they get no picker.
function runtimeHasModelPicker(sourceId: SelectableSourceId): boolean {
  return sourceId === 'clawboo-native' || sourceId === 'openclaw' || sourceId === 'hermes'
}

/** The model dropdown options for a runtime — its OWN catalog (native uses the
 *  provider-native ids; OpenClaw uses the routing ids; Hermes its own
 *  provider+model ids), led by an empty "Recommended" that leaves the model unset
 *  (native → tier auto-resolve; OpenClaw → the global default; Hermes → the
 *  key-derived default). The provider suffix disambiguates same-named models across
 *  providers (e.g. GPT-4o under both OpenAI and OpenRouter). */
function modelOptionsFor(
  sourceId: SelectableSourceId,
  nativeGroups: ModelGroup[],
  openclawGroups: ModelGroup[],
  hermesGroups: ModelGroup[],
): { value: string; label: string }[] {
  const groups =
    sourceId === 'clawboo-native'
      ? nativeGroups
      : sourceId === 'hermes'
        ? hermesGroups
        : openclawGroups
  return [
    { value: '', label: 'Recommended' },
    ...groups.flatMap((g) =>
      g.models.map((m) => ({ value: m.id, label: `${m.label} · ${g.provider}` })),
    ),
  ]
}

// ─── Steps ───────────────────────────────────────────────────────────────────

type Step = 'pick' | 'customize' | 'deploy' | 'complete'

type DeployProgress = { current: number; total: number; label: string }

// ─── Props ───────────────────────────────────────────────────────────────────

interface CreateTeamModalProps {
  isOpen: boolean
  onClose: () => void
  /** Called after the team is created; carries the new team's id (onboarding
   *  uses it to land the user in that team). */
  onCreated: (teamId?: string) => void
  /** When provided, skip the "pick" step and go directly to "customize" with this profile. */
  initialProfile?: ProfileLike | null
  /** When true (and no `initialProfile`), skip the pick step and open directly on a
   *  blank "start from scratch" customize step. */
  startBlank?: boolean
  /** Onboarding: mark the gate's "meet your team" phase already seen, because the
   *  wizard's own `NativeReadyStep` IS that beat (same card) — so the user isn't
   *  shown two identical welcomes back to back. The gate then opens straight on the
   *  user's self-introduction, which is NOT skipped: `userIntroText` is the source of
   *  truth the server injects into every team turn's context preamble, so blanking it
   *  would permanently deprive the first team of knowing who the user is.
   *  Off by default (normal team creation runs the full gate). */
  presatisfyOnboardingGate?: boolean
  /** Whether the pick step offers "Start from scratch". Defaults to true;
   *  onboarding disables it (a blank team would strand the first-run user). */
  allowStartFromScratch?: boolean
  /** Onboarding: default EVERY agent to Clawboo Native regardless of the catalog's
   *  source rule (which suggests OpenClaw for a marketplace team). The wizard is the
   *  native-first spine and the provider key just entered is its only guaranteed
   *  runtime; without this, a first-run user with a reachable Gateway silently
   *  deploys their first team onto OpenClaw. The per-agent picker still offers every
   *  connected runtime, so this is a default, not a lock. */
  preferNativeRuntime?: boolean
}

// ─── Component ───────────────────────────────────────────────────────────────

export function CreateTeamModal({
  isOpen,
  onClose,
  onCreated,
  initialProfile,
  startBlank,
  presatisfyOnboardingGate = false,
  allowStartFromScratch = true,
  preferNativeRuntime = false,
}: CreateTeamModalProps) {
  const client = useConnectionStore((s) => s.client)
  const connStatus = useConnectionStore((s) => s.status)
  // OpenClaw's SERVER-side operator connection (registry health) — the thin-client
  // signal. OpenClaw team deploy + run happen server-side (the OpenClawAgentSource
  // create + the server orchestrator run over the operator connection), so a live
  // browser Gateway client is NOT required; this is what actually gates OpenClaw.
  // Fetched on open.
  const [serverOpenclawConnected, setServerOpenclawConnected] = useState(false)
  // Native groups with the OpenRouter list fetched live — feeds the per-agent model picker.
  const nativeModelGroups = useNativeModelGroups()
  // OpenClaw groups with the same live OpenRouter list (routing-id format).
  const openclawModelGroups = useOpenClawModelGroups(MODEL_GROUPS)
  const hermesModelGroups = useHermesModelGroups()
  // "OpenClaw available" = a live browser Gateway client OR the server's operator
  // connection (mirrors the Runtimes panel). A bare status check is wrong — native mode
  // sets status='connected' with client=null and no Gateway — so the registry-health
  // signal is the accurate "OpenClaw is reachable" test, and it's what lets OpenClaw be
  // picked in thin-client / degraded-gateway mode (browser client null, server operator
  // connection live). When NEITHER is connected, marketplace rows degrade to Native so a
  // deploy still succeeds Gateway-free.
  const openclawConnected =
    (connStatus === 'connected' && client !== null) || serverOpenclawConnected
  const openSettings = useSettingsModalStore((s) => s.openSettings)
  const { resolvedTheme } = useTheme()

  const [step, setStep] = useState<Step>('pick')

  // Jump to customize step when opened with a pre-filled profile
  useEffect(() => {
    if (isOpen && initialProfile) {
      setSelectedProfile(initialProfile)
      setTeamName(initialProfile.name)
      setTeamIcon(initialProfile.emoji)
      setTeamColor(initialProfile.color)
      setColorCollectionId(DEFAULT_COLLECTION_ID)
      setStep('customize')
    }
  }, [isOpen, initialProfile])

  // "Start from scratch" (from the Marketplace) → open directly on the blank
  // customize step, bypassing the pick showcase. Mirrors `handlePickEmpty`.
  useEffect(() => {
    if (isOpen && startBlank && !initialProfile) {
      setSelectedProfile(null)
      setTeamName('New Team')
      setTeamIcon('👻')
      setTeamColor(TEAM_ACCENT_PRESETS[0])
      setColorCollectionId(DEFAULT_COLLECTION_ID)
      setStep('customize')
    }
  }, [isOpen, startBlank, initialProfile])
  const [selectedProfile, setSelectedProfile] = useState<ProfileLike | null>(null)

  // Customize fields
  const [teamName, setTeamName] = useState('')
  const [teamIcon, setTeamIcon] = useState('')
  // Team accent (icon / halo) and the Boo color collection are independent.
  const [teamColor, setTeamColor] = useState<string>(TEAM_ACCENT_PRESETS[0])
  const [colorCollectionId, setColorCollectionId] = useState<CollectionId>(DEFAULT_COLLECTION_ID)
  // The team id is minted on the CLIENT so the customize-step preview can seed
  // the Boo palette with the SAME id the deployed team will use (per-team hue
  // rotation) — the preview then matches what the team actually looks like.
  // Regenerated in `reset()` so each created team gets a fresh, unique id.
  const [pendingTeamId, setPendingTeamId] = useState<string>(() => crypto.randomUUID())

  // ── Runtime selection (PER-AGENT) ───────────────────────────────────────────
  // There is no single "team runtime": every agent picks its own runtime, defaulting
  // to the catalog "chef's suggestion" (a marketplace team → OpenClaw; a blank team →
  // Native), degraded to Native when unavailable. The universal Boo Zero leads any mix.
  const [runtimeStatuses, setRuntimeStatuses] = useState<RuntimeStatus[]>([])
  // Per-agent overrides (all agents, leader included). Effective runtime =
  // override ?? resolvedDefaultFor(id). Cleared in reset() so overrides don't leak.
  const [agentRuntimes, setAgentRuntimes] = useState<Record<string, SelectableSourceId>>({})
  // Per-agent MODEL override for native agents (catalog model id; absent = the tier
  // default auto-resolved from the connected key). Cleared in reset().
  const [agentModels, setAgentModels] = useState<Record<string, string>>({})
  useEffect(() => {
    if (!isOpen) return
    void fetchRuntimes()
      .then(setRuntimeStatuses)
      .catch(() => {})
    // The server's OpenClaw operator connection — so OpenClaw is offered when it's
    // reachable server-side even if the browser Gateway client is null (thin-client /
    // degraded-gateway mode), matching the Runtimes panel.
    void fetchRegistryHealth()
      .then((h) => setServerOpenclawConnected(h.connection === 'connected'))
      .catch(() => setServerOpenclawConnected(false))
  }, [isOpen])

  // Deploy state
  const [progress, setProgress] = useState<DeployProgress | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Pick-step filter state (local, not in Zustand). The pick step renders the
  // SHARED Marketplace team showcase (same cards + filters + "Start from
  // scratch"), so the first-run flow and the Marketplace stay identical.
  const [pickSearch, setPickSearch] = useState('')
  const [pickCategory, setPickCategory] = useState<TemplateCategory | 'all'>('all')
  const [pickSource, setPickSource] = useState<TemplateSource | 'all'>('all')
  const [detailTemplate, setDetailTemplate] = useState<TeamTemplate | null>(null)

  const filteredPickTeams = useMemo(
    () => filterTeams(pickSearch, pickCategory, pickSource),
    [pickSearch, pickCategory, pickSource],
  )
  const pickCategoryOpts = useMemo(() => teamCategoryOptions(), [])

  const resolvedSelected = useMemo(
    () => (selectedProfile ? resolveTeamAgents(selectedProfile) : []),
    [selectedProfile],
  )

  // Live preview of each teammate's avatar color for the chosen collection,
  // seeded by the pending team id so the rotated palette matches what the team
  // will actually look like once deployed. (Classic ignores the seed and shows
  // its fixed legacy tints, exactly as before.)
  const previewColors = useMemo(
    () =>
      resolvedSelected.length
        ? paletteFor(colorCollectionId, resolvedSelected.length, resolvedTheme, pendingTeamId)
        : [],
    [colorCollectionId, resolvedSelected.length, resolvedTheme, pendingTeamId],
  )

  /**
   * True when the modal was opened via AgentCard's Deploy button — the prefilled
   * profile is an adhoc single-agent TeamTemplate. Detected via shape, not a new
   * prop, so existing team-deploy paths are untouched. Customize step swaps its
   * title and button label to "Deploy agent"/"Create agent" in this mode; the
   * deploy loop is unchanged (single-agent teams are just 1-agent teams).
   */
  const isSingleAgentMode = useMemo(
    () =>
      !!(
        selectedProfile &&
        'agentIds' in selectedProfile &&
        Array.isArray(selectedProfile.agentIds) &&
        selectedProfile.agentIds.length === 1
      ),
    [selectedProfile],
  )

  // The team-internal lead — ONLY a genuine (keyword-matched) leadership role, else
  // NULL. We do NOT force an arbitrary first agent to lead: the universal Boo Zero leads
  // every team (the server resolves Boo Zero BEFORE `leaderAgentId`), so `leaderAgentId`
  // is an OPTIONAL second-tier lead, set only when the roster genuinely has one. When set
  // (and native), that agent gets the "Leader" badge + the native leader prompt/tier; when
  // null, the team is leaderless (no badge, all specialists) and Boo Zero coordinates.
  const effectiveLeaderAgent = useMemo(
    () => resolvedSelected.find((a) => detectGenuineLeader({ name: a.name, role: a.role })) ?? null,
    [resolvedSelected],
  )

  // A picked/prefilled template (real OR the adhoc single-agent one) is a marketplace
  // team → its agents suggest OpenClaw; only "Start empty" (no profile) suggests Native.
  // This is the SOURCE RULE input for the default resolver.
  const isMarketplaceTeam = !!selectedProfile
  const availability = useMemo<RuntimeAvailability>(
    () => ({ statuses: runtimeStatuses, openclawConnected }),
    [runtimeStatuses, openclawConnected],
  )
  const agentRuntimeOpts = useMemo(
    () => agentRuntimeOptions(runtimeStatuses, openclawConnected),
    [runtimeStatuses, openclawConnected],
  )

  /** The catalog "chef's suggestion" for an agent (before availability degradation):
   *  onboarding's `preferNativeRuntime` → its own `suggestedRuntime` (unpopulated
   *  today) → the team `defaultRuntime` → the source rule (marketplace → OpenClaw,
   *  blank → Native). */
  const suggestedFor = useCallback(
    (agentCatalogId: string): SelectableSourceId =>
      suggestedRuntimeFor({
        agentSuggested: getAgent(agentCatalogId)?.suggestedRuntime,
        teamDefault: (selectedProfile as TeamTemplate | null)?.defaultRuntime,
        isMarketplaceTeam,
        preferNative: preferNativeRuntime,
      }),
    [selectedProfile, isMarketplaceTeam, preferNativeRuntime],
  )
  /** The resolved default = the suggestion degraded to Native when unavailable;
   *  `.degradedFrom` is non-null when it was degraded (drives the inline note). */
  const resolvedDefaultFor = useCallback(
    (agentCatalogId: string) => resolveDefaultRuntime(suggestedFor(agentCatalogId), availability),
    [suggestedFor, availability],
  )
  /** The source id a given resolved agent will deploy on: the user's per-agent
   *  override, else the resolved catalog default. */
  const agentSourceIdFor = useCallback(
    (agentCatalogId: string): SelectableSourceId =>
      agentRuntimes[agentCatalogId] ?? resolvedDefaultFor(agentCatalogId).selected,
    [agentRuntimes, resolvedDefaultFor],
  )

  const reset = useCallback(() => {
    setStep('pick')
    setSelectedProfile(null)
    setTeamName('')
    setTeamIcon('')
    setTeamColor(TEAM_ACCENT_PRESETS[0])
    setColorCollectionId(DEFAULT_COLLECTION_ID)
    setProgress(null)
    setError(null)
    setPickSearch('')
    setPickCategory('all')
    setPickSource('all')
    setDetailTemplate(null)
    setAgentRuntimes({})
    setAgentModels({})
    // Fresh id for the next team so each one gets its own palette rotation.
    setPendingTeamId(crypto.randomUUID())
  }, [])

  const handleClose = useCallback(() => {
    if (step === 'deploy') return // can't close while deploying
    reset()
    onClose()
  }, [step, reset, onClose])

  // Close this modal and route a disabled runtime option to its connect surface. OpenClaw
  // hands the Runtimes panel a one-shot intent so it auto-opens the OpenClaw Gateway setup
  // flow (detect / install / configure / start) — the Gateway connect flow specifically —
  // rather than just landing on the Runtimes list; the coding runtimes land on the list.
  const handleRuntimeConnectClick = useCallback(
    (sourceId: SelectableSourceId) => {
      handleClose()
      openSettings(
        'runtimes',
        sourceId === 'openclaw' ? { runtimeIntent: 'connect-openclaw' } : undefined,
      )
    },
    [handleClose, openSettings],
  )

  // Step A → Step B
  const handlePickProfile = useCallback((profile: ProfileLike) => {
    setSelectedProfile(profile)
    setTeamName(profile.name)
    setTeamIcon(profile.emoji)
    setTeamColor(profile.color)
    setColorCollectionId(DEFAULT_COLLECTION_ID)
    setStep('customize')
  }, [])

  const handlePickEmpty = useCallback(() => {
    setSelectedProfile(null)
    setTeamName('New Team')
    setTeamIcon('👻')
    setTeamColor(TEAM_ACCENT_PRESETS[0])
    setColorCollectionId(DEFAULT_COLLECTION_ID)
    setStep('customize')
  }, [])

  // Step B → create (empty) or deploy (template)
  const handleConfirmCustomize = useCallback(async () => {
    const name = teamName.trim()
    if (!name) return

    setError(null)

    try {
      // Resolve the catalog agents up front — used for dedup, deploy, and counts.
      const resolved = selectedProfile ? resolveTeamAgents(selectedProfile) : []

      // Any agent EXPLICITLY on OpenClaw needs OpenClaw reachable — the server-side
      // operator connection (its AgentSource create 503s otherwise), NOT a browser
      // Gateway client. The resolver already degrades an OpenClaw *suggestion* to Native
      // when OpenClaw is down, so this only trips when the user forces OpenClaw on a
      // member while OpenClaw is disconnected.
      const anyOpenClaw = resolved.some((a) => agentSourceIdFor(a.id) === 'openclaw')
      if (anyOpenClaw && !openclawConnected) {
        setError(
          'Connect an OpenClaw Gateway to deploy the OpenClaw members, or switch them to another runtime.',
        )
        return
      }

      // ── Dedup: auto-suffix if agent/team names collide with existing ones ──
      const existingAgentNames = useFleetStore.getState().agents.map((a) => a.name)
      const existingTeamNames = useTeamStore.getState().teams.map((t) => t.name)
      const desiredAgentNames = resolved.map((a) => a.name)
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
          // Client-minted id so the deployed team's Boo palette matches the
          // preview the user just saw (same per-team hue rotation seed).
          id: pendingTeamId,
          name: finalTeamName,
          icon: teamIcon,
          color: teamColor,
          colorCollectionId,
          templateId: selectedProfile?.id ?? null,
          // Every team is server-orchestrated after the OpenClaw cutover (native,
          // OpenClaw, and mixed all run the persistent server engine). Set the explicit
          // flag at create so it's deterministic from the first message.
          serverOrchestrated: true,
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
        colorCollectionId,
        templateId: team.templateId ?? null,
        leaderAgentId: null,
        isArchived: false,
        agentCount: 0,
        // Every team runs the persistent server engine after the OpenClaw cutover.
        serverOrchestrated: true,
      })
      useTeamStore.getState().selectTeam(team.id)

      // Onboarding: mark ONLY the "meet your team" phase as seen — the wizard's
      // `NativeReadyStep` renders that same card, so replaying it in the gate would
      // show the user two identical welcomes. The gate's `initialPhase` then opens
      // directly on the user's self-introduction.
      //
      // Do NOT also set `userIntroduced` / blank `userIntroText` here: that skipped
      // the introduction screen entirely AND left the first team's `userIntroText`
      // permanently empty, so the server's team context preamble never told those
      // agents who the user is — a gap every marketplace-created team was spared.
      // The PATCH merges partials, so omitting the field leaves it false.
      if (presatisfyOnboardingGate) {
        try {
          await fetch(`/api/teams/${team.id}/onboarding`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ agentsIntroduced: true }),
          })
        } catch {
          // best-effort — the gate will just run its welcome phase too if this fails
        }
      }

      if (!selectedProfile) {
        // Empty team — done
        useToastStore
          .getState()
          .addToast({ type: 'success', message: `Team "${finalTeamName}" created` })
        reset()
        onClose()
        onCreated(team.id)
        return
      }

      // Template team → deploy agents
      setStep('deploy')

      // Genuine-leader detection: find the first catalog agent whose
      // name/role matches a leadership archetype (CTO, Team Lead, etc.).
      // Only THIS agent (if any) becomes the team-internal lead.
      // Forced "first agent is leader" is gone — Boo Zero is the universal
      // leader, the internal-lead column is now optional.
      const genuineLeaderCatalogAgent =
        resolved.find((a) => detectGenuineLeader({ name: a.name, role: a.role })) ?? null
      const genuineLeaderFinalName = genuineLeaderCatalogAgent
        ? (dedupPlan.agentNameMap.get(genuineLeaderCatalogAgent.name) ??
          genuineLeaderCatalogAgent.name)
        : null

      // Resolve Boo Zero name to thread through agent file generation —
      // every agent gets a "Universal Leader" block in their AGENTS.md and
      // CLAWBOO.md so they know how to escalate upward via `<delegate>`.
      const booZeroAgentId = useBooZeroStore.getState().booZeroAgentId
      const booZeroAgent = booZeroAgentId
        ? (useFleetStore.getState().agents.find((a) => a.id === booZeroAgentId) ?? null)
        : null
      const universalLeaderName = booZeroAgent?.name ?? null

      let leaderAgentId: string | null = null
      const failedAgents: string[] = []
      let createdCount = 0

      for (let i = 0; i < resolved.length; i++) {
        const agent = resolved[i]
        const finalAgentName = dedupPlan.agentNameMap.get(agent.name) ?? agent.name
        setProgress({ current: i, total: resolved.length, label: finalAgentName })

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
        // CLAWBOO.md sits at the agent's workspace root and provides the
        // detailed operating reference (workspace isolation paths,
        // [Team Update] semantics, orchestration loop, common pitfalls).
        // Agents read it on demand via `cat ~/CLAWBOO.md`.
        const clawbooHelpDoc = buildClawbooHelpDoc({
          agentName: finalAgentName,
          teamName: finalTeamName,
          teammates: teammatesForProtocol,
          universalLeaderName,
        })

        const files = {
          soul: soulWithPersonality,
          identity: rewriteTemplateName(agent.identityTemplate, agent.name, finalAgentName),
          tools: agent.toolsTemplate,
          agents: enhancedAgentsMd,
          clawboo: clawbooHelpDoc,
        }

        // Runtime routing: each agent runs on its resolved runtime (per-agent
        // override, else the catalog default). A native LEADER (the team-internal
        // lead that also resolved to native) gets the leader prompt + tier.
        const sourceId = agentSourceIdFor(agent.id)
        const isNativeLeader =
          sourceId === 'clawboo-native' && effectiveLeaderAgent?.id === agent.id

        let agentId: string
        try {
          if (sourceId === 'clawboo-native') {
            // The native harness drives behavior from execConfig.systemPrompt (it
            // does NOT read AGENTS.md), so the delegate contract lives HERE — the
            // leader is taught the `delegate` tool by name (no `<delegate>` XML) +
            // gets tasks:false; provider/model are auto-resolved server-side from
            // the connected key (via the modelTier hint).
            // A picked model overrides the auto-resolved default (provider + model +
            // env-var); absent → the modelTier hint auto-resolves from the connected key.
            const modelExec = agentModels[agent.id] ? nativeModelExec(agentModels[agent.id]!) : null
            agentId = await createAgent(finalAgentName, files, 'clawboo-native', {
              systemPrompt: `${soulWithPersonality}\n\n${isNativeLeader ? NATIVE_LEADER_PROMPT : NATIVE_SPECIALIST_PROMPT}`,
              tools: NATIVE_TEAM_TOOLS,
              participantKind: 'agent',
              modelTier: isNativeLeader ? 'leader' : 'specialist',
              ...(modelExec ?? {}),
            })
          } else if (sourceId === 'openclaw') {
            agentId = await createAgent(finalAgentName, files)
          } else {
            // A coding-runtime member: the record exists so the server engine can
            // run it. Hermes takes a per-agent model (the picker) stored as an
            // execConfig `{ provider, model }` — serverDeliver threads it so the run
            // is `hermes chat -m <model> --provider <provider>`; without a pick it
            // uses the key-derived default. Codex / Claude Code run on their own
            // account / SDK default (no picker) and ignore execConfig.
            const codingExec =
              sourceId === 'hermes' && agentModels[agent.id]
                ? hermesModelExec(agentModels[agent.id]!)
                : null
            agentId = await createAgent(finalAgentName, files, sourceId, codingExec ?? undefined)
          }
        } catch {
          // One source's failure (e.g. an OpenClaw 503, or a mid-deploy hiccup)
          // must not abort the rest of the team.
          failedAgents.push(finalAgentName)
          continue
        }

        createdCount++

        // OpenClaw per-agent model override → openclaw.json agents.list[] (durable,
        // session-independent), the same mechanism the agent-detail model selector
        // uses. Native models already rode execConfig at create; coding runtimes are
        // model-inert as members, so this only applies to an OpenClaw pick. Best-effort.
        if (sourceId === 'openclaw' && agentModels[agent.id]) {
          try {
            await fetch('/api/system/openclaw-config', {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ agentModel: { agentId, model: agentModels[agent.id] } }),
            })
          } catch {
            // a failed model override is non-fatal — the agent runs on the default
          }
        }

        // Persist default personality to SQLite so sliders load correctly
        void fetch('/api/personality', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ agentId, values: defaultPersonality }),
        }).catch(() => {})

        // Capture the team-internal lead id — ONLY when the roster has a genuine
        // leadership role (effectiveLeaderAgent non-null). No genuine leader ⇒
        // leaderAgentId stays null and the universal Boo Zero coordinates.
        if (effectiveLeaderAgent && agent.id === effectiveLeaderAgent.id) leaderAgentId = agentId

        // Assign the successfully-created agent to the team (best-effort).
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

      // No forced fallback: leaderAgentId stays null unless a genuine leadership role
      // was detected (and created). Boo Zero universal-leads either way — the server
      // resolves it before leaderAgentId — so a leaderless team is fully functional.

      // Nothing deployed — surface it. The (empty) team row stays so the user can
      // retry or delete it.
      if (createdCount === 0) {
        setError('No agents could be created. Check that the runtime is connected, then retry.')
        setStep('customize')
        return
      }
      if (failedAgents.length > 0) {
        useToastStore.getState().addToast({
          type: 'error',
          message: `${createdCount} of ${resolved.length} agents created (${failedAgents.join(', ')} failed)`,
        })
      }

      // Set the team-internal lead (the genuine detected leader, or null when the
      // roster has none) — it's an OPTIONAL fallback below the universal Boo Zero.
      // PATCH always runs (incl. writing null) so the column stays accurate on re-deploys.
      if (team.id) {
        try {
          await fetch(`/api/teams/${team.id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ leaderAgentId }),
          })
          useTeamStore.getState().updateTeam(team.id, { leaderAgentId })
        } catch {
          // leader assignment is non-fatal
        }
      }

      // Generate and persist Boo Zero's per-team brief. The brief is what
      // Boo Zero reads when entering this team's chat — team identity,
      // member roster, internal lead (if any), routing patterns, anti-
      // patterns. Best-effort: a failed PUT doesn't block the deploy.
      // Extract skill names from each agent's TOOLS.md markdown bullets.
      // `ResolvedAgent` doesn't carry `description` / `skillIds` directly
      // (those live on AgentCatalogEntry), so we derive what we can from
      // the templates the deploy loop already has in hand. Anything missing
      // is left empty in the brief — the user can edit the brief later.
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
          icon: teamIcon,
          templateId: selectedProfile.id ?? null,
          description: selectedProfile.description ?? '',
        },
        members: briefMembers,
        internalLead:
          genuineLeaderFinalName && internalLeadKeyword
            ? { agentName: genuineLeaderFinalName, matchedKeyword: internalLeadKeyword }
            : null,
      })
      try {
        await fetch(`/api/boo-zero/team-briefs/${encodeURIComponent(team.id)}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: briefMarkdown }),
        })
      } catch {
        // brief generation is non-fatal — the brief is editable in the UI
      }

      setProgress({
        current: resolved.length,
        total: resolved.length,
        label: 'Done!',
      })

      // Auto-enable agent-to-agent coordination if any agent has routing
      const hasRouting = resolved.some((a) => a.agentsTemplate && /@[\w"']/.test(a.agentsTemplate))
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

      // Re-hydrate fleet from the registry (SQLite) to pick up the new agents.
      try {
        await refreshFleetFromRegistry()
      } catch {
        // hydration failure is non-fatal
      }

      // Re-hydrate teams from SQLite to patch fleet store with correct assignments
      await hydrateTeams()
      useGraphStore.getState().triggerRefresh()

      setStep('complete')
      useToastStore.getState().addToast({
        type: 'success',
        message: `Team "${name}" deployed with ${createdCount} agents`,
      })
      setTimeout(() => {
        reset()
        onClose()
        onCreated(team.id)
      }, 800)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong')
      setStep('customize')
    }
  }, [
    openclawConnected,
    teamName,
    teamIcon,
    teamColor,
    selectedProfile,
    colorCollectionId,
    agentModels,
    pendingTeamId,
    agentSourceIdFor,
    effectiveLeaderAgent,
    presatisfyOnboardingGate,
    reset,
    onClose,
    onCreated,
  ])

  if (!isOpen) return null

  return (
    <>
      <AnimatePresence>
        <motion.div
          key="create-team-backdrop"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-50 flex items-center justify-center backdrop-blur-sm"
          style={{ background: 'var(--overlay-scrim)' }}
          onClick={handleClose}
        >
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 8 }}
            transition={{ type: 'spring', stiffness: 280, damping: 28 }}
            className={`relative w-full ${step === 'pick' ? 'max-w-4xl' : step === 'customize' ? 'max-w-2xl' : 'max-w-lg'} rounded-2xl border border-border bg-surface transition-all duration-200`}
            style={{ boxShadow: 'var(--shadow-overlay)' }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Close button */}
            {step !== 'deploy' && (
              <div className="absolute right-3 top-3 z-10">
                <IconButton label="Close" variant="ghost" size="sm" onClick={handleClose}>
                  <X className="h-4 w-4" strokeWidth={2} />
                </IconButton>
              </div>
            )}

            {/* ─── Step: Pick Template ──────────────────────────────
                The SAME team showcase as the Marketplace Teams tab (shared
                filter primitives + TeamShowcaseGrid), so the first-run flow
                reads exactly like the marketplace the user already loves. */}
            {step === 'pick' && (
              <div className="flex max-h-[85vh] flex-col overflow-hidden rounded-2xl">
                {/* Header */}
                <div className="px-6 pb-3 pt-6">
                  <h2
                    className="text-[18px] font-bold text-foreground"
                    style={{ letterSpacing: '-0.01em' }}
                  >
                    Create a team
                  </h2>
                  <p className="mt-1 text-[13px] text-foreground/55">
                    Deploy a curated team, or start one from scratch.
                  </p>
                </div>

                {/* Filter bar (fixed) — search + category + source, same as the
                    Marketplace Teams tab. */}
                <div className="flex flex-col gap-2.5 border-b border-border px-6 pb-3.5">
                  <SearchInput
                    size="sm"
                    placeholder="Search teams…"
                    value={pickSearch}
                    onChange={setPickSearch}
                  />
                  <CollapsiblePillRow
                    aria-label="Filter teams by category"
                    options={pickCategoryOpts}
                    activeKey={pickCategory}
                    onSelect={(k) => setPickCategory(k as TemplateCategory | 'all')}
                  />
                  <div className="flex flex-wrap gap-1.5">
                    {TEAM_SOURCE_ENTRIES.map((src) => (
                      <Chip
                        key={src.key}
                        size="sm"
                        active={pickSource === src.key}
                        accent={src.key === 'all' ? undefined : src.color}
                        onClick={() => setPickSource(src.key as TemplateSource | 'all')}
                      >
                        {src.key !== 'all' && (
                          <span
                            className="h-1.5 w-1.5 shrink-0 rounded-full"
                            style={{ background: src.color }}
                          />
                        )}
                        {src.label}
                      </Chip>
                    ))}
                  </div>
                </div>

                {/* Grid (scrollable) — the shared Marketplace team showcase */}
                <div className="flex-1 overflow-y-auto p-6">
                  <TeamShowcaseGrid
                    teams={filteredPickTeams}
                    onSelectTeam={handlePickProfile}
                    onDetails={setDetailTemplate}
                    onStartFromScratch={handlePickEmpty}
                    showStartFromScratch={allowStartFromScratch}
                    onClearFilters={() => {
                      setPickSearch('')
                      setPickCategory('all')
                      setPickSource('all')
                    }}
                  />
                </div>
              </div>
            )}

            {/* ─── Step: Customize ────────────────────────────────── */}
            {step === 'customize' && (
              <div className="flex max-h-[85vh] flex-col overflow-hidden rounded-2xl">
                {/* Header (fixed) — the "Back to templates" arrow only makes
                    sense when the pick step is part of THIS flow. When the modal
                    was opened directly on customize from the Marketplace (a
                    template Deploy or "Start from scratch"), there's no in-modal
                    picker to return to, so it's hidden (same as single-agent). */}
                <div className="flex items-center gap-2 px-6 pb-4 pt-6">
                  {!isSingleAgentMode && !initialProfile && !startBlank && (
                    <IconButton
                      label="Back to templates"
                      variant="ghost"
                      size="sm"
                      onClick={() => setStep('pick')}
                    >
                      <ArrowLeft className="h-4 w-4" strokeWidth={2} />
                    </IconButton>
                  )}
                  <h2
                    className="text-[18px] font-bold text-foreground"
                    style={{ letterSpacing: '-0.01em' }}
                  >
                    {isSingleAgentMode ? 'Deploy agent' : 'Customize team'}
                  </h2>
                </div>

                {/* Body (scrollable) */}
                <div className="flex flex-1 flex-col gap-6 overflow-y-auto px-6 pb-2">
                  {/* Name */}
                  <label className="block">
                    <span className="mb-1.5 block font-mono text-[11px] uppercase tracking-[0.14em] text-foreground/45">
                      Name
                    </span>
                    <input
                      type="text"
                      value={teamName}
                      onChange={(e) => setTeamName(e.target.value)}
                      className="w-full rounded-xl border border-border bg-surface px-4 py-3 text-[14px] text-foreground outline-none transition placeholder:text-foreground/30 focus:border-primary focus:ring-4 focus:ring-primary/15"
                      placeholder="Team name"
                    />
                  </label>

                  {/* ── Team badge: the team's icon + color ── */}
                  <section className="flex flex-col gap-3">
                    <div>
                      <h3 className="font-mono text-[11px] uppercase tracking-[0.14em] text-foreground/45">
                        Team badge
                      </h3>
                      <p className="mt-1 text-[12px] text-foreground/50">
                        Tap the badge to change its icon, then pick a color.
                      </p>
                    </div>
                    <div className="flex items-center gap-3">
                      {/* The icon picker IS the live badge (icon on the accent tint) */}
                      <TeamIconPicker
                        value={teamIcon}
                        onChange={setTeamIcon}
                        accentColor={teamColor}
                      />
                      <div className="flex min-w-0 flex-1 flex-col gap-2">
                        <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-foreground/45">
                          Color
                        </span>
                        <TeamAccentPicker value={teamColor} onChange={setTeamColor} />
                      </div>
                    </div>
                  </section>

                  {/* ── Teammate colors + per-agent runtime: collection + live roster ── */}
                  <section className="flex flex-col gap-2.5">
                    <div className="flex items-baseline justify-between gap-2">
                      <h3 className="font-mono text-[11px] uppercase tracking-[0.14em] text-foreground/45">
                        Teammate colors
                      </h3>
                      {resolvedSelected.length > 0 && (
                        <span className="font-data text-[10px] text-foreground/50">
                          {resolvedSelected.length}{' '}
                          {resolvedSelected.length === 1 ? 'teammate' : 'teammates'}
                        </span>
                      )}
                    </div>
                    <TeamColorCollectionPicker
                      value={colorCollectionId}
                      onChange={setColorCollectionId}
                    />

                    {resolvedSelected.length > 0 ? (
                      <div className="mt-1 max-h-[220px] overflow-y-auto rounded-xl border border-border bg-foreground/[0.02] p-2">
                        <div className="flex flex-col gap-0.5">
                          {resolvedSelected.map((agent, i) => {
                            const isLeaderRow = effectiveLeaderAgent?.id === agent.id
                            const resolvedDefault = resolvedDefaultFor(agent.id)
                            const overridden = agent.id in agentRuntimes
                            const value = agentRuntimes[agent.id] ?? resolvedDefault.selected
                            const degradedFrom = overridden ? null : resolvedDefault.degradedFrom
                            const degradedLabel = degradedFrom
                              ? (agentRuntimeOpts.find((o) => o.sourceId === degradedFrom)?.label ??
                                degradedFrom)
                              : null
                            const showModel = runtimeHasModelPicker(value)
                            return (
                              <div
                                key={agent.id}
                                className="flex flex-col gap-1 rounded-lg px-1.5 py-1.5"
                              >
                                {/* Name + Leader flex on the left; the runtime + model
                                    pickers sit as a compact cluster on the right. The
                                    wider (max-w-2xl) modal keeps them on ONE line. */}
                                <div className="flex items-center gap-2.5">
                                  <BooAvatar seed={agent.name} size={24} tint={previewColors[i]} />
                                  <div className="flex min-w-0 flex-1 items-center gap-2">
                                    <span className="min-w-0 truncate text-[13px] text-foreground/80">
                                      {agent.name}
                                    </span>
                                    {isLeaderRow && (
                                      <span className="shrink-0 rounded-md border border-border bg-foreground/[0.03] px-1.5 py-0.5 text-[10px] text-foreground/60">
                                        Leader
                                      </span>
                                    )}
                                  </div>
                                  <RuntimeSelect
                                    value={value}
                                    options={agentRuntimeOpts}
                                    onChange={(sid) => {
                                      setAgentRuntimes((prev) => ({ ...prev, [agent.id]: sid }))
                                      // A model id is runtime-specific (native vs OpenClaw
                                      // catalogs differ), so clear any override when the
                                      // runtime changes — a stale cross-runtime id must not leak.
                                      setAgentModels((prev) => {
                                        if (!(agent.id in prev)) return prev
                                        const next = { ...prev }
                                        delete next[agent.id]
                                        return next
                                      })
                                    }}
                                    onDisabledClick={handleRuntimeConnectClick}
                                  />
                                  {showModel && (
                                    <Select
                                      size="sm"
                                      className="shrink-0"
                                      style={{ width: 184 }}
                                      menuWidth={252}
                                      searchable
                                      searchPlaceholder="Search models…"
                                      data-testid="member-model-trigger"
                                      aria-label={`Model for ${agent.name}`}
                                      value={agentModels[agent.id] ?? ''}
                                      onChange={(m) =>
                                        setAgentModels((prev) => ({ ...prev, [agent.id]: m }))
                                      }
                                      options={modelOptionsFor(
                                        value,
                                        nativeModelGroups,
                                        openclawModelGroups,
                                        hermesModelGroups,
                                      )}
                                    />
                                  )}
                                </div>
                                {degradedLabel && (
                                  <p className="pl-[34px] text-[10.5px] text-foreground/45">
                                    {degradedLabel} unavailable · using Clawboo Native
                                  </p>
                                )}
                              </div>
                            )
                          })}
                        </div>
                      </div>
                    ) : (
                      <p className="text-[12px] text-foreground/50">
                        Teammates you add to this team will use these colors.
                      </p>
                    )}
                  </section>

                  {error && <FormattedAlert tone="error">{error}</FormattedAlert>}
                </div>

                {/* Footer (fixed) — primary action always visible */}
                <div className="border-t border-border px-6 py-4">
                  <button
                    type="button"
                    data-testid="create-team-deploy"
                    onClick={() => void handleConfirmCustomize()}
                    disabled={!teamName.trim()}
                    className="flex h-11 w-full cursor-pointer items-center justify-center gap-2 rounded-xl text-[14px] font-semibold text-primary-foreground transition active:scale-[0.98] hover:brightness-110 disabled:pointer-events-none disabled:opacity-45"
                    style={{ backgroundColor: teamColor, boxShadow: 'var(--shadow-raised)' }}
                  >
                    {isSingleAgentMode
                      ? 'Create agent'
                      : selectedProfile
                        ? 'Deploy team'
                        : 'Create team'}
                  </button>
                </div>
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
                  className="mb-2 text-[18px] font-bold text-foreground"
                  style={{ letterSpacing: '-0.01em' }}
                >
                  Deploying {teamName}
                </h2>
                <p className="mb-6 text-[13px] text-foreground/55">Creating {progress.label}…</p>

                {/* Progress bar */}
                <div className="mb-2 h-1.5 w-full max-w-xs overflow-hidden rounded-full bg-foreground/10">
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
                <p className="font-data text-[11px] text-foreground/50">
                  {progress.current}/{progress.total} agents
                </p>

                {/* Safety-net error display (catch should reset to customize, but just in case) */}
                {error && (
                  <div className="mt-4 flex w-full max-w-xs flex-col items-center gap-2">
                    <FormattedAlert tone="error">{error}</FormattedAlert>
                    <Button variant="outline" size="sm" onClick={() => setStep('customize')}>
                      Back
                    </Button>
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
                    style={{ color: 'var(--mint)' }}
                  />
                </motion.div>
                <h2
                  className="mb-1 text-[18px] font-bold text-foreground"
                  style={{ letterSpacing: '-0.01em' }}
                >
                  Team deployed!
                </h2>
                <p className="text-[13px] text-foreground/55">{teamName} is ready to go.</p>
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
