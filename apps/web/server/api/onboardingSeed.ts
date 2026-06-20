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
import { createDb, setSetting, teams } from '@clawboo/db'

import { getRegistry } from '../lib/agentSource'
import { getDbPath } from '../lib/db'

// Per-provider model picks: a capable model for the leader, a cheap one for the
// specialist. All entries are in the native pricing table (honest USD) except
// Ollama (local, estimated). A custom provider is rejected before we get here.
const MODEL_DEFAULTS: Record<string, { leader: string; specialist: string }> = {
  anthropic: { leader: 'claude-sonnet-4-6', specialist: 'claude-haiku-4-5' },
  openai: { leader: 'gpt-4o', specialist: 'gpt-4o-mini' },
  openrouter: { leader: 'anthropic/claude-haiku-4.5', specialist: 'openai/gpt-4o-mini' },
  ollama: { leader: 'llama3.2', specialist: 'llama3.2' },
}

// The leader coordinates by delegating to teammates through the durable Tasks
// board — it does NOT do every task itself. Kept self-contained (no external
// doc references) so it ships verbatim into the agent's stable prompt tier.
const LEADER_PROMPT =
  'You are the lead of a small agent team. When a request needs hands-on work, ' +
  'break it into clear tasks and delegate them to your teammates using the ' +
  'Tasks board tool rather than doing everything yourself. Coordinate, keep the ' +
  'plan moving, and reply with a short, plain summary of what the team did and ' +
  "what's next. You and your teammates share one memory — save durable facts so " +
  'the team can recall them later.'

const SPECIALIST_PROMPT =
  'You are a capable coding specialist on a small team. Pick up the task you are ' +
  'given, do the work using the available tools, and report back a short summary ' +
  'of what you did, what you verified, and any follow-ups. Save durable facts to ' +
  'the shared memory so your teammates can build on them.'

interface SeedBody {
  provider?: unknown
  model?: unknown
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
        createdAt: now,
        updatedAt: now,
      })
      .run()

    const nativeSource = getRegistry().nativeSource

    const leader = await nativeSource.createAgent({
      name: 'Team Lead',
      teamId,
      execConfig: {
        primaryProvider: provider,
        primaryModel: leaderModel,
        envVar,
        systemPrompt: LEADER_PROMPT,
        tools: { memory: true, tools: true, tasks: true, teamchat: false },
        participantKind: 'agent',
        budgetUsd: null,
      },
    })

    const specialist = await nativeSource.createAgent({
      name: 'Coder',
      teamId,
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

    res.status(201).json({ teamId, leaderAgentId: leader.id, specialistAgentId: specialist.id })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
  }
}
