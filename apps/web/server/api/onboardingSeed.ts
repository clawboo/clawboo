// Onboarding seed — mint a default native team (leader + specialist) so a
// first-run user who just connected a provider key lands in a WORKING team.
//
// All native: the two agents are `clawboo-native` runtime rows created via
// `getRegistry().nativeSource.createAgent` (the native AgentSource surface) — no OpenClaw
// Gateway, no provider SDK calls here. The team row is inserted first (the FK
// `agents.teamId → teams.id` requires it), then the agents are created with the
// teamId set, then the team's leaderAgentId is recorded and the "Know Your
// Team" onboarding flags are pre-satisfied so the user lands straight in chat.
//
// Idempotent on a fresh ~/.clawboo/: a re-run mints a clean single team (there
// is no migration / merge path — delete-and-rerun is the canonical reset).

import crypto from 'node:crypto'

import type { Request, Response } from 'express'
import { eq } from 'drizzle-orm'

import { envVarForProvider, KNOWN_PROVIDERS } from '@clawboo/adapter-native'
import { createDb, getSetting, setSetting, teams } from '@clawboo/db'

import { getRegistry } from '../lib/agentSource'
import { getDbPath } from '../lib/db'
import { getTenantId } from '../lib/tenant'
// Per-provider model picks live in the shared native-defaults helper (the native
// AgentSource's provider auto-resolution uses the same map).
import { MODEL_DEFAULTS } from '../lib/runtimes/native/nativeProviderDefaults'
import { loadAgentConfig, saveAgentConfig } from '../lib/runtimes/native/agentConfigStore'
import { SETTING_NATIVE_BOO_ZERO_ID, SETTING_NATIVE_LEADER_MODEL } from '../lib/teamChat/booZero'
import { serverOrchestratedSettingKey } from '../lib/teamChat/resolveServerOrchestrated'

// The leader coordinates by delegating to teammates with the `delegate` tool —
// it does NOT do every task itself, and it does NOT touch the board directly (the
// server orchestrator observes the `delegate` tool-call and owns the board: create
// → run → report back). Teach the tool by NAME only — no `<delegate to="...">`
// example (the leader's own summary echoing that XML shape would trip the
// orchestrator's "didn't parse, re-issue" nudge). Kept self-contained (no external
// doc references) so it ships verbatim into the agent's stable prompt tier.
// Exported so the client (CreateTeamModal's native path) can drift-guard its own
// copy against this canonical text (a test asserts equality) — the server can't
// be imported by the browser bundle, so the modal duplicates these constants.
export const LEADER_PROMPT =
  'You are the lead of a small agent team. Answer simple questions and quick ' +
  'clarifications yourself, directly — do NOT delegate or create a task for something ' +
  'you can answer or already know. Delegate ONLY genuine hands-on, multi-step work ' +
  '(writing code, research, producing or changing a deliverable) by calling the ' +
  "`delegate` tool with the teammate's name and a clear, self-contained task. Your " +
  'teammates do the work and report their results back to you; rely on the task ' +
  'updates they send rather than re-doing their work. When you delegate, just call ' +
  'the `delegate` tool(s) and stop — do NOT narrate the hand-off or say the team is ' +
  'working on it (the user already sees each task appear on the board). Never narrate ' +
  'your own tool use or internal state (memory, board, searches) to the user; use them ' +
  'silently, and if your memory is empty just proceed. Only after the task updates come ' +
  'back do you reply, with one short, plain summary of what the team produced; suggest ' +
  'a next step only when there is a clear, non-obvious one, and never append a menu of ' +
  'options or ask for a priority every turn. You and your teammates share one memory — ' +
  'save durable facts so the team can recall them later.'

export const SPECIALIST_PROMPT =
  'You are a capable coding specialist on a small team. Pick up the task you are ' +
  'given, do the work using the available tools, and report back a short summary ' +
  'of what you did, what you verified, and any follow-ups. You report to your team ' +
  'lead, not the user — you cannot reach the user, so if a detail is missing make a ' +
  'reasonable assumption and note it rather than asking. Save durable facts to ' +
  'the shared memory so your teammates can build on them.'

interface SeedBody {
  provider?: unknown
  model?: unknown
}

// POST /api/onboarding/native-leader-model — record the provider + model the user
// picked when connecting their native key, so the lazily-created universal Boo
// Zero (ensureNativeBooZero) runs on it instead of the auto-resolved per-provider
// default. The seed endpoint used to write this as a side effect; now that real
// team selection replaces the auto-seed, the connect step records it here.
export function onboardingNativeLeaderModelPOST(req: Request, res: Response): void {
  const body = (req.body ?? {}) as SeedBody
  const provider = typeof body.provider === 'string' ? body.provider.trim() : ''
  const model = typeof body.model === 'string' ? body.model.trim() : ''
  if (!(KNOWN_PROVIDERS as readonly string[]).includes(provider)) {
    res.status(400).json({ error: `unknown provider '${provider}'` })
    return
  }
  if (!model) {
    res.status(400).json({ error: 'model is required' })
    return
  }
  try {
    const db = createDb(getDbPath())
    setSetting(db, SETTING_NATIVE_LEADER_MODEL, JSON.stringify({ provider, model }))
    // Retro-apply to the EXISTING native Boo Zero so the pick takes effect
    // immediately — the setting alone only reaches a FUTURE lazily-created leader
    // (ensureNativeBooZero reads it at creation time). Best-effort: no Boo Zero
    // yet (fresh install mid-onboarding) is the normal case, not an error.
    try {
      const bzId = getSetting(db, SETTING_NATIVE_BOO_ZERO_ID)
      const cfg = bzId ? loadAgentConfig(db, bzId) : null
      if (bzId && cfg) {
        const envVar = envVarForProvider(provider)
        saveAgentConfig(db, {
          ...cfg,
          primaryProvider: provider,
          primaryModel: model,
          ...(envVar ? { envVar } : {}),
          updatedAt: Date.now(),
        })
      }
    } catch {
      /* best-effort */
    }
    res.status(200).json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
  }
}

// GET /api/onboarding/native-leader-model — the current default provider + model
// for the native leader (null/null when never set). Read by the Runtimes panel's
// native provider manager so its "Default" tag + model dropdown reflect reality.
export function onboardingNativeLeaderModelGET(_req: Request, res: Response): void {
  try {
    const db = createDb(getDbPath())
    const raw = getSetting(db, SETTING_NATIVE_LEADER_MODEL)
    if (!raw) {
      res.json({ provider: null, model: null })
      return
    }
    const parsed = JSON.parse(raw) as { provider?: string; model?: string }
    res.json({ provider: parsed.provider ?? null, model: parsed.model ?? null })
  } catch {
    res.json({ provider: null, model: null })
  }
}

export async function onboardingSeedNativeTeamPOST(req: Request, res: Response): Promise<void> {
  const body = (req.body ?? {}) as SeedBody
  const provider = typeof body.provider === 'string' ? body.provider.trim() : 'anthropic'
  const modelOverride =
    typeof body.model === 'string' && body.model.trim() ? body.model.trim() : null

  if (!(KNOWN_PROVIDERS as readonly string[]).includes(provider)) {
    res.status(400).json({ error: `unknown provider '${provider}'` })
    return
  }

  // Ollama is keyless; AgentConfig.envVar is non-empty by schema, so the local
  // path carries a harmless placeholder (the native router skips key resolution
  // for ollama candidates entirely).
  const envVar = envVarForProvider(provider) ?? 'OLLAMA_BASE_URL'
  const models = MODEL_DEFAULTS[provider] ?? MODEL_DEFAULTS['anthropic']!
  const leaderModel = modelOverride ?? models.leader
  const specialistModel = models.specialist

  try {
    const db = createDb(getDbPath())
    const now = Date.now()
    const teamId = crypto.randomUUID()
    const tenantId = getTenantId(req)

    // Team first — the agents' teamId FK requires it.
    db.insert(teams)
      .values({
        id: teamId,
        name: 'My First Team',
        icon: '🚀',
        // Hex, never a CSS var — team.color is hex-alpha concatenated app-wide.
        color: '#e94560',
        colorCollectionId: 'classic',
        templateId: null,
        leaderAgentId: null,
        tenantId,
        createdAt: now,
        updatedAt: now,
      })
      .run()

    const nativeSource = getRegistry().nativeSource

    const leader = await nativeSource.createAgent({
      name: 'Team Lead',
      teamId,
      tenantId,
      execConfig: {
        primaryProvider: provider,
        primaryModel: leaderModel,
        envVar,
        systemPrompt: LEADER_PROMPT,
        // Trust-first: the engine OWNS the board, so the leader does NOT get the
        // Tasks MCP (create_task etc.) — it would race the engine's claim (→409) or
        // create an unrun orphan. The leader delegates via the `delegate` signal
        // tool (added by the native driver for team runs) and sees results as the
        // `[Task Update]` reflections the engine delivers. Memory + tools stay on.
        tools: { memory: true, tools: true, tasks: false, teamchat: false },
        participantKind: 'agent',
        budgetUsd: null,
      },
    })

    const specialist = await nativeSource.createAgent({
      name: 'Coder',
      teamId,
      tenantId,
      execConfig: {
        primaryProvider: provider,
        primaryModel: specialistModel,
        envVar,
        systemPrompt: SPECIALIST_PROMPT,
        tools: { memory: true, tools: true, tasks: false, teamchat: false },
        participantKind: 'agent',
        budgetUsd: null,
      },
    })

    // Record the leader + pre-satisfy the "Know Your Team" gate so the user
    // lands straight in the team space (the gate is for getting acquainted; a
    // seeded team is already introduced).
    db.update(teams)
      .set({ leaderAgentId: leader.id, updatedAt: Date.now() })
      .where(eq(teams.id, teamId))
      .run()
    setSetting(
      db,
      `team-onboarding:${teamId}`,
      JSON.stringify({ agentsIntroduced: true, userIntroduced: true, userIntroText: '' }),
    )
    // A native team is SERVER-orchestrated: its team chat runs the persistent
    // server engine (client-independent), not the legacy browser path.
    setSetting(db, serverOrchestratedSettingKey(teamId), 'true')
    // Remember the chosen leader model so the universal Boo Zero (created lazily by
    // ensureNativeBooZero, a DIFFERENT agent from this team's "Team Lead") runs on it
    // instead of the auto-resolved per-provider default.
    setSetting(db, SETTING_NATIVE_LEADER_MODEL, JSON.stringify({ provider, model: leaderModel }))

    res.status(201).json({ teamId, leaderAgentId: leader.id, specialistAgentId: specialist.id })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
  }
}
