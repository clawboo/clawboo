/**
 * Resolve the generated palette color for a single Boo, given its team and the
 * active theme. This is the bridge between the team's chosen collection
 * (`teamPalettes`) and the avatar's `tint`.
 *
 * Boo Zero (the universal leader) and any teamless / unknown agent return
 * `undefined`, so the avatar keeps its reserved red / hashed fallback tint.
 */

import { resolveBooTint } from '@clawboo/ui'

import { DEFAULT_COLLECTION_ID, generateTeamColors, type CollectionId } from './teamPalettes'

// Palettes are deterministic in (collection, count, theme), so memoize: every
// avatar in a team shares one generation instead of recomputing per render.
const paletteCache = new Map<string, string[]>()

export function paletteFor(
  collectionId: CollectionId,
  count: number,
  theme: 'light' | 'dark',
): string[] {
  const key = `${collectionId}:${count}:${theme}`
  let palette = paletteCache.get(key)
  if (!palette) {
    palette = generateTeamColors(collectionId, count, theme)
    paletteCache.set(key, palette)
  }
  return palette
}

/**
 * Pick a Boo's color from its team palette by slot. `memberIds` must be the
 * team's members in a STABLE order (Boo Zero excluded) so the same Boo always
 * lands on the same slot across renders.
 */
export function pickBooColor(
  collectionId: CollectionId,
  memberIds: readonly string[],
  agentId: string,
  theme: 'light' | 'dark',
): string | undefined {
  // Classic is legacy-faithful: reproduce the ORIGINAL per-agent hash
  // assignment so every Boo keeps the exact color it had before collections —
  // independent of team slot or size. (Boo Zero is already excluded upstream.)
  if (collectionId === 'classic') return resolveBooTint(agentId, false)
  const idx = memberIds.indexOf(agentId)
  if (idx < 0) return undefined
  return paletteFor(collectionId, memberIds.length, theme)[idx]
}

export interface ResolveBooColorInput {
  agentId: string
  agents: ReadonlyArray<{ id: string; teamId: string | null }>
  teams: ReadonlyArray<{ id: string; colorCollectionId: CollectionId | null }>
  booZeroAgentId: string | null
  theme: 'light' | 'dark'
}

/**
 * Full resolution from raw store data — used directly in tests. The live hook
 * in `AgentBooAvatar` mirrors this with narrow selectors (for render perf) but
 * shares `pickBooColor` so the slot math can't drift.
 */
export function resolveTeamBooColor(input: ResolveBooColorInput): string | undefined {
  const { agentId, agents, teams, booZeroAgentId, theme } = input
  if (agentId === booZeroAgentId) return undefined
  const agent = agents.find((a) => a.id === agentId)
  if (!agent?.teamId) return undefined
  const team = teams.find((t) => t.id === agent.teamId)
  if (!team) return undefined
  const collectionId = team.colorCollectionId ?? DEFAULT_COLLECTION_ID
  const memberIds = agents
    .filter((a) => a.teamId === agent.teamId && a.id !== booZeroAgentId)
    .map((a) => a.id)
    .sort()
  return pickBooColor(collectionId, memberIds, agentId, theme)
}
