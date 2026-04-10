/**
 * apps/web/src/lib/deployDedup.ts
 *
 * Pure utilities for handling duplicate agent/team names during deployment.
 * When deploying a template that collides with existing names, these helpers
 * compute a consistent numeric suffix (" 2", " 3", …) and rewrite @mention
 * routing in AGENTS.md so Ghost Graph edges resolve correctly.
 */

// ─── Types ───────────────────────────────────────────────────────────────────

/** Maps original template agent name → final (potentially suffixed) name. */
export type NameMap = Map<string, string>

export interface DedupPlan {
  /** The suffix number applied (0 = no suffix needed, 2+ = suffix applied). */
  suffix: number
  /** Potentially suffixed team name. */
  teamName: string
  /** Original agent name → final agent name. */
  agentNameMap: NameMap
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// ─── computeDedupSuffix ──────────────────────────────────────────────────────

/**
 * Given the desired agent/team names and the existing names already in use,
 * compute a DedupPlan with a consistent suffix that makes everything unique.
 *
 * If no collisions exist, suffix is 0 and all names are unchanged.
 * Otherwise, every agent name AND the team name get the same " N" suffix.
 */
export function computeDedupSuffix(
  desiredAgentNames: string[],
  existingAgentNames: string[],
  desiredTeamName: string,
  existingTeamNames: string[],
): DedupPlan {
  const existingAgentSet = new Set(existingAgentNames.map((n) => n.toLowerCase()))
  const existingTeamSet = new Set(existingTeamNames.map((n) => n.toLowerCase()))

  const hasAgentCollision = desiredAgentNames.some((n) => existingAgentSet.has(n.toLowerCase()))
  const hasTeamCollision = existingTeamSet.has(desiredTeamName.toLowerCase())

  // No collisions — return identity map
  if (!hasAgentCollision && !hasTeamCollision) {
    const map: NameMap = new Map(desiredAgentNames.map((n) => [n, n]))
    return { suffix: 0, teamName: desiredTeamName, agentNameMap: map }
  }

  // Find the smallest suffix ≥ 2 where ALL suffixed names are free
  for (let suffix = 2; suffix <= 1000; suffix++) {
    const sfx = ` ${suffix}`
    const suffixedAgents = desiredAgentNames.map((n) => `${n}${sfx}`)
    const suffixedTeam = `${desiredTeamName}${sfx}`

    const agentsFree = suffixedAgents.every((n) => !existingAgentSet.has(n.toLowerCase()))
    const teamFree = !existingTeamSet.has(suffixedTeam.toLowerCase())

    if (agentsFree && teamFree) {
      const map: NameMap = new Map(
        desiredAgentNames.map((original, i) => [original, suffixedAgents[i]!]),
      )
      return { suffix, teamName: suffixedTeam, agentNameMap: map }
    }
  }

  // Safety fallback (should never be reached in practice)
  throw new Error('Could not find available name suffix after 1000 attempts')
}

// ─── rewriteAgentsMd ─────────────────────────────────────────────────────────

/**
 * Rewrite @mention routing patterns in AGENTS.md content using the name map.
 * Handles both unquoted (`@Agent Boo`) and quoted (`@"Agent Boo"`) forms.
 * Sorts replacements by original name length descending to prevent partial matches.
 */
export function rewriteAgentsMd(content: string | undefined, nameMap: NameMap): string | undefined {
  if (!content) return content

  // Collect renames (skip identity mappings)
  const renames = [...nameMap.entries()].filter(([orig, final]) => orig !== final)
  if (renames.length === 0) return content

  // Sort by original name length descending (longest first → prevents partial matches)
  renames.sort((a, b) => b[0].length - a[0].length)

  let result = content
  for (const [originalName, newName] of renames) {
    const escaped = escapeRegex(originalName)
    // Unquoted @mention: @Original Name Boo → @New Name Boo 2
    result = result.replace(new RegExp(`@${escaped}(?=[\\s,.:;!?)]|$)`, 'gi'), `@${newName}`)
    // Double-quoted: @"Original Name Boo" → @"New Name Boo 2"
    result = result.replace(new RegExp(`@"${escaped}"`, 'gi'), `@"${newName}"`)
    // Single-quoted: @'Original Name Boo' → @'New Name Boo 2'
    result = result.replace(new RegExp(`@'${escaped}'`, 'gi'), `@'${newName}'`)
  }

  return result
}

// ─── rewriteTemplateName ─────────────────────────────────────────────────────

/**
 * Replace occurrences of the original agent name with the new name in template
 * content (IDENTITY.md, SOUL.md). Used for updating "You are Agent Boo, …"
 * to "You are Agent Boo 2, …".
 */
export function rewriteTemplateName(
  content: string | undefined,
  originalName: string,
  newName: string,
): string | undefined {
  if (!content) return content
  if (originalName === newName) return content
  return content.replaceAll(originalName, newName)
}
