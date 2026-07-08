// Boo Zero — the UNIVERSAL team leader, now a runtime-NEUTRAL designated role rather
// than "the OpenClaw default agent." It is the server-side reduce-point that presides
// over EVERY team via a team-scoped session. Resolution per team:
//   1. an explicit user OVERRIDE (`boo-zero:agent-id`) — any runtime, set via a
//      "Make this agent Boo Zero" action; the user's choice always wins.
//   2. else the per-runtime DEFAULT for the team's base leader: an OpenClaw team keeps
//      the Gateway's teamless default (backward-compat); a native / mixed team gets the
//      DEFAULT-NATIVE Boo Zero — a teamless `clawboo-native` agent Clawboo owns, so
//      native teams get a real coordinator with NO Gateway dependency.
// `serverDeliver` runs Boo Zero on whatever runtime its row says (native runs in-process,
// OpenClaw over the operator connection), so the leader is not coupled to any one runtime.

import { envVarForProvider } from '@clawboo/adapter-native'
import { agents, getSetting, setSetting, type ClawbooDb } from '@clawboo/db'
import { and, eq, isNotNull, isNull } from 'drizzle-orm'

import { SETTING_DEFAULT_ID } from '../agentSource/openClawAgentSource'
import { hasConnectedNativeProvider } from '../runtimes/native/nativeProviderDefaults'

/** User OVERRIDE: designate ANY agent (any runtime) as Boo Zero. Wins over the
 *  per-runtime defaults; set via the "Make this agent Boo Zero" action. */
export const SETTING_BOO_ZERO_OVERRIDE = 'boo-zero:agent-id'
/** The auto-created native Boo Zero (the DEFAULT universal leader for native teams). */
export const SETTING_NATIVE_BOO_ZERO_ID = 'boo-zero:native-agent-id'
/** The provider + model the user picked at native onboarding for the leader — read by
 *  `ensureNativeBooZero` so the universal Boo Zero runs on the CHOSEN model instead of
 *  the auto-resolved per-provider default. JSON `{ provider, model }`. Absent → auto-resolve. */
export const SETTING_NATIVE_LEADER_MODEL = 'boo-zero:native-leader-model'

const NATIVE_RUNTIME = 'clawboo-native'

/** The native Boo Zero's system prompt — the delegate-silently universal-lead behavior
 *  (mirrors the native `LEADER_PROMPT`) plus the Boo Zero identity. Kept here (not
 *  imported from the api layer) so lib doesn't depend on api. */
export const NATIVE_BOO_ZERO_PROMPT =
  'You are Boo Zero, the universal lead of the team. Answer simple questions and quick ' +
  'clarifications yourself, directly — do NOT delegate or create a task for something you ' +
  'can answer or already know. Delegate ONLY genuine hands-on, multi-step work by calling ' +
  "the `delegate` tool with the teammate's name and a clear, self-contained task. When you " +
  'delegate, just call the `delegate` tool(s) and stop — do NOT narrate the hand-off or say ' +
  'the team is working on it (the user already sees each task appear on the board). Never ' +
  'narrate your own tool use or internal state (memory, board, searches) to the user; use ' +
  'them silently, and if your memory is empty just proceed. Only after the task updates come ' +
  'back do you reply, with one short, plain summary of what the team produced; suggest a next ' +
  'step only when there is a clear, non-obvious one, and never append a menu of options or ask ' +
  'for a priority every turn. You and your teammates share one memory — save durable facts so ' +
  'the team can recall them later.'

interface AgentLite {
  id: string
  name: string
  runtime?: string | null
  teamId?: string | null
  archivedAt?: number | null
}

/** The minimal AgentSource surface `ensureNativeBooZero` needs — DI-friendly for tests.
 *  (Structurally satisfied by `getRegistry().nativeSource`, whose `createAgent` returns
 *  an `AgentRecord`; we only need the `id` back.) */
export interface NativeBooZeroCreator {
  createAgent(input: {
    name: string
    teamId: string | null
    execConfig: Record<string, unknown>
  }): Promise<{ id: string }>
}

/** The canonical display name of the native Boo Zero. */
const BOO_ZERO_NAME = 'Boo Zero'

function agentById(db: ClawbooDb, id: string | null | undefined): AgentLite | null {
  if (!id) return null
  const row = db.select().from(agents).where(eq(agents.id, id)).get() as AgentLite | undefined
  if (!row || row.archivedAt) return null
  return row
}

/** The teamless OpenClaw default (the Gateway `defaultId` agent), or null. */
export function resolveOpenClawBooZero(db: ClawbooDb): AgentLite | null {
  const candidates = db
    .select()
    .from(agents)
    .where(and(eq(agents.sourceId, 'openclaw'), isNull(agents.teamId), isNull(agents.archivedAt)))
    .all() as AgentLite[]
  if (candidates.length === 0) return null
  const defaultId = getSetting(db, SETTING_DEFAULT_ID)
  const match = defaultId ? candidates.find((a) => a.id === defaultId) : undefined
  return match ?? candidates[0]!
}

/** The designated native Boo Zero (teamless `clawboo-native`), or null if it hasn't been
 *  created / was archived. Validated so a stale setting can't point at a foreign agent. */
export function resolveNativeBooZero(db: ClawbooDb): AgentLite | null {
  const a = agentById(db, getSetting(db, SETTING_NATIVE_BOO_ZERO_ID))
  return a && a.runtime === NATIVE_RUNTIME && a.teamId == null ? a : null
}

/** The user's explicit override Boo Zero (any runtime), or null. */
function resolveOverrideBooZero(db: ClawbooDb): AgentLite | null {
  return agentById(db, getSetting(db, SETTING_BOO_ZERO_OVERRIDE))
}

/** The PRIMARY Boo Zero for identity / display (the `GET /api/agents` `defaultId` the
 *  client identifies): override → native → OpenClaw. Any runtime. */
export function resolveBooZero(db: ClawbooDb): { id: string; name: string } | null {
  const bz = resolveOverrideBooZero(db) ?? resolveNativeBooZero(db) ?? resolveOpenClawBooZero(db)
  return bz ? { id: bz.id, name: bz.name } : null
}

function activeMembers(db: ClawbooDb, teamId: string): AgentLite[] {
  const members = db.select().from(agents).where(eq(agents.teamId, teamId)).all() as AgentLite[]
  return members.filter((a) => !a.archivedAt)
}

/** The reduce-point Boo Zero for a TEAM. ONE universal Boo Zero leads EVERY team
 *  (override → native → OpenClaw): the DEFAULT-NATIVE Boo Zero presides over native AND
 *  OpenClaw teams alike — `serverDeliver` runs it on its own runtime (native in-process)
 *  and delegates to each member on theirs (native / OpenClaw / coding). OpenClaw is the
 *  fallback ONLY when no native Boo Zero exists (a pure-OpenClaw / no-key install).
 *  Returns null only when the team has no members, or no Boo Zero exists at all — then
 *  the team keeps its own leader. (The drop-in successor to `booZeroForOpenClawTeam`.) */
export function booZeroForTeam(db: ClawbooDb, teamId: string): { id: string; name: string } | null {
  if (activeMembers(db, teamId).length === 0) return null
  return resolveBooZero(db)
}

/** True when the install actually uses native — there is at least one native team member.
 *  Gates auto-creating the native Boo Zero so a pure-OpenClaw install (that merely has a
 *  stray native key) never materializes an unused native leader that would hijack the
 *  `defaultId` display. */
function hasNativeTeamMember(db: ClawbooDb): boolean {
  const row = db
    .select({ id: agents.id })
    .from(agents)
    .where(
      and(
        eq(agents.runtime, NATIVE_RUNTIME),
        isNotNull(agents.teamId),
        isNull(agents.archivedAt),
      ),
    )
    .get()
  return row != null
}

/** The provider + model the user picked at native onboarding (SETTING_NATIVE_LEADER_MODEL),
 *  with the provider's vault env-var resolved — or null when unset/invalid (auto-resolve). */
function readChosenLeaderModel(
  db: ClawbooDb,
): { provider: string; model: string; envVar: string } | null {
  const raw = getSetting(db, SETTING_NATIVE_LEADER_MODEL)
  if (!raw) return null
  try {
    const p = JSON.parse(raw) as { provider?: unknown; model?: unknown }
    if (typeof p.provider !== 'string' || typeof p.model !== 'string' || !p.model) return null
    // Ollama is keyless; AgentConfig.envVar is non-empty by schema (a harmless placeholder).
    const envVar = envVarForProvider(p.provider) ?? 'OLLAMA_BASE_URL'
    return { provider: p.provider, model: p.model, envVar }
  } catch {
    return null
  }
}

/** Ensure the DEFAULT-NATIVE Boo Zero exists (idempotent via `SETTING_NATIVE_BOO_ZERO_ID`).
 *  Creates a teamless `clawboo-native` universal leader ONLY when native is actually in use
 *  (a native team member exists) AND a native provider key is connected (else a native agent
 *  can't run) — so a no-key or pure-OpenClaw install materializes nothing and native teams
 *  keep their own leader (no regression). Best-effort: never throws. Safe to call at boot
 *  and per-team; the setting makes it a one-time create. */
export async function ensureNativeBooZero(
  db: ClawbooDb,
  nativeSource: NativeBooZeroCreator,
): Promise<{ id: string; name: string } | null> {
  const existing = resolveNativeBooZero(db)
  if (existing) return { id: existing.id, name: existing.name }
  if (!hasNativeTeamMember(db) || !hasConnectedNativeProvider()) return null
  // The model the user picked at native onboarding, if any — else the native source
  // auto-resolves the per-provider leader default from the first connected key.
  const chosen = readChosenLeaderModel(db)
  try {
    const bz = await nativeSource.createAgent({
      name: BOO_ZERO_NAME,
      teamId: null,
      execConfig: {
        modelTier: 'leader',
        ...(chosen
          ? { primaryProvider: chosen.provider, primaryModel: chosen.model, envVar: chosen.envVar }
          : {}),
        systemPrompt: NATIVE_BOO_ZERO_PROMPT,
        tools: { memory: true, tools: true, tasks: false, teamchat: false },
        participantKind: 'agent',
        budgetUsd: null,
      },
    })
    setSetting(db, SETTING_NATIVE_BOO_ZERO_ID, bz.id)
    return { id: bz.id, name: BOO_ZERO_NAME }
  } catch {
    return null
  }
}
