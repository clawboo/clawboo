// Auto-sync Boo Zero's display name into the Gateway-side SOUL.md.
//
// Why this exists
// ---------------
// The Clawboo display-name override lives in SQLite and overlays the
// Gateway-side `agent.name` in the UI. But the LLM's persisted identity
// (the SOUL.md / IDENTITY.md it sees on every turn) still carries whatever
// name OpenClaw set during onboarding (a custom name, or the
// literal slug "main"). When the override and the persisted identity
// disagree, the LLM drifts — calls itself one name in one breath and the
// other in the next.
//
// The per-turn `[Your Rules]` block carries the authoritative name
// and is the load-bearing fix. This sync is the belt-and-suspenders layer:
// when it succeeds, the LLM's natural self-reference also aligns with the
// override, removing one pressure point for drift.
//
// Sync triggers (all "implicit user approval" moments):
//   1. `GatewayBootstrap.hydrateFleet` — first connect AND every connect
//      where the override already exists (idempotent so it doesn't matter
//      if the SOUL.md was already updated).
//   2. `DisplayNameEditor` save in maintenance — when the user changes the
//      name, the SOUL.md sync runs immediately after the override PUT.
//   3. `TeamOnboardingGate` Phase C — when the user submits their intro
//      and clicks "Continue to Team Chat", that approval also triggers
//      the sync (per-team onboarding moment of approval).
//
// Best-effort. Gateway `agents.files.set('SOUL.md')` is known to be
// unreliable for persistence in older runtimes. When it works, great; when
// it doesn't, the per-turn rules block keeps the identity anchored anyway.

import { readAgentFile, writeAgentFile } from '@clawboo/control-client'

/**
 * Rewrite the first `# <heading>` line of an existing SOUL.md to `# <name>`.
 * When the file has no leading heading, prepend one. Preserves all other
 * content (role description, personality block, About-the-User section, etc.)
 * so we never destroy the user's customizations.
 */
function rewriteSoulHeading(current: string, name: string): string {
  const trimmedName = name.trim()
  if (!trimmedName) return current
  // Drop any existing leading top-level heading + the blank lines after it.
  const stripped = current.replace(/^#\s+[^\n]*\n+/, '')
  const next = `# ${trimmedName}\n\n${stripped}`.trimEnd() + '\n'
  return next
}

/**
 * Best-effort: write the display name into Boo Zero's SOUL.md as the first
 * heading. Returns `true` on success, `false` on any failure (the caller
 * decides whether to surface this to the user).
 */
export async function syncBooZeroSoulIdentity(params: {
  agentId: string
  displayName: string
}): Promise<boolean> {
  const { agentId, displayName } = params
  const trimmed = displayName.trim()
  if (!trimmed) return false
  try {
    let current = ''
    try {
      current = await readAgentFile(agentId, 'SOUL.md')
    } catch {
      // SOUL.md may be missing / source offline — start from empty.
      current = ''
    }
    const next = rewriteSoulHeading(current, trimmed)
    if (next === current) return true // already aligned
    await writeAgentFile(agentId, 'SOUL.md', next)
    return true
  } catch {
    return false
  }
}

// Exported for tests.
export const __test__ = { rewriteSoulHeading }
