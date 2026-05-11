const SESSION_KEY_AGENT_RE = /^agent:([^:]+):/

/** Extracts the agentId from a sessionKey of format `agent:<agentId>:<sessionName>`. */
export function agentIdFromSessionKey(sessionKey: string): string | null {
  const m = sessionKey.match(SESSION_KEY_AGENT_RE)
  return m?.[1] ?? null
}

/** Build a team-scoped sessionKey: `agent:<agentId>:team:<teamId>`. */
export function buildTeamSessionKey(agentId: string, teamId: string): string {
  return `agent:${agentId}:team:${teamId}`
}

// ─── Team chat override ──────────────────────────────────────────────────────
//
// The Gateway echoes events with the agent's main sessionKey regardless of
// which custom sessionKey was used in chat.send. This redirect map ensures
// incoming events for agents currently processing team chat messages are
// stored under the team sessionKey, not the main one.
//
// **Concurrency model (runId-aware)**:
//
// Boo Zero participates in N teams as the universal leader. Two team chats
// in flight at the same time both have outstanding overrides on Boo Zero's
// agentId. A naïve `Map<agentId, sessionKey>` clobbers the older one. We
// disambiguate by the per-run `runId` on the Gateway events.
//
// Lifecycle of an override:
//
//   1. Caller calls `setTeamChatOverride(agentId, sessionKey)` BEFORE sending
//      the message. The runId isn't known yet — we store the entry in
//      `pendingOverrides`.
//
//   2. The first event for that agent arrives with a runId. We "promote" the
//      pending entry to `runScopedOverrides` keyed by `${agentId} ${runId}`.
//      Subsequent events for the same agent + runId look up here.
//
//   3. When the run ends, the caller calls `clearTeamChatOverride(agentId,
//      runId)`. Run-scoped entry is removed.
//
// If a second `setTeamChatOverride` for the same agent fires before step 2
// (overlapping team sends), the second call REPLACES the pending entry — but
// any already-promoted run-scoped entry stays put, so the older run keeps
// routing correctly until it ends.

const pendingOverrides = new Map<string, string>()
const runScopedOverrides = new Map<string, string>()
/** Tracks which runIds belong to which agentId — supports bulk cleanup. */
const runIdsByAgent = new Map<string, Set<string>>()

function runKey(agentId: string, runId: string): string {
  return `${agentId} ${runId}`
}

/** Mark an agent as currently processing a team chat message (pre-runId). */
export function setTeamChatOverride(agentId: string, teamSessionKey: string): void {
  pendingOverrides.set(agentId, teamSessionKey)
}

/**
 * Promote the pending override for an agent to a run-scoped one.
 * Called by the event handler on the first event that arrives with a runId.
 * Idempotent — re-promoting the same run is a no-op.
 *
 * Returns the sessionKey that ended up scoped to (agentId, runId), or
 * `undefined` if there was no pending override and no existing scoped one.
 */
export function promoteOverrideToRun(agentId: string, runId: string): string | undefined {
  if (!runId) return undefined
  const key = runKey(agentId, runId)
  const existing = runScopedOverrides.get(key)
  if (existing) return existing
  const pending = pendingOverrides.get(agentId)
  if (!pending) return undefined
  runScopedOverrides.set(key, pending)
  pendingOverrides.delete(agentId)
  let set = runIdsByAgent.get(agentId)
  if (!set) {
    set = new Set<string>()
    runIdsByAgent.set(agentId, set)
  }
  set.add(runId)
  return pending
}

/**
 * Clear the override for an agent.
 *
 * - If `runId` is provided: clears only the run-scoped entry for that run.
 *   This is the precise post-commit cleanup path.
 * - If `runId` is omitted: clears the pending entry only (back-compat for
 *   the legacy "the agent finished" semantics where the caller didn't track
 *   the runId).
 */
export function clearTeamChatOverride(agentId: string, runId?: string): void {
  if (runId) {
    runScopedOverrides.delete(runKey(agentId, runId))
    const set = runIdsByAgent.get(agentId)
    if (set) {
      set.delete(runId)
      if (set.size === 0) runIdsByAgent.delete(agentId)
    }
    return
  }
  pendingOverrides.delete(agentId)
}

/**
 * Get the override for an agent — run-aware.
 *
 * - When `runId` is provided AND a run-scoped entry exists for (agentId,
 *   runId): returns that sessionKey.
 * - When `runId` is provided but no run-scoped entry exists yet: falls
 *   through to the pending entry (caller may want to promote it).
 * - When `runId` is omitted: returns the pending entry only (back-compat).
 *
 * Does NOT mutate any state. Use `promoteOverrideToRun` if you want to
 * persist a runId-keyed entry going forward.
 */
export function getTeamChatOverride(agentId: string, runId?: string | null): string | undefined {
  if (runId) {
    const scoped = runScopedOverrides.get(runKey(agentId, runId))
    if (scoped) return scoped
  }
  return pendingOverrides.get(agentId)
}

/** Check if an agent currently has ANY active override (pending OR run-scoped). */
export function hasTeamChatOverride(agentId: string): boolean {
  if (pendingOverrides.has(agentId)) return true
  const set = runIdsByAgent.get(agentId)
  return Boolean(set && set.size > 0)
}

/** Clear all overrides for an agent — used when the agent is deleted. */
export function clearAllTeamChatOverridesForAgent(agentId: string): void {
  pendingOverrides.delete(agentId)
  const set = runIdsByAgent.get(agentId)
  if (set) {
    for (const r of set) runScopedOverrides.delete(runKey(agentId, r))
    runIdsByAgent.delete(agentId)
  }
}

/** Clear ALL overrides — exposed for testing. */
export function resetTeamChatOverrides(): void {
  pendingOverrides.clear()
  runScopedOverrides.clear()
  runIdsByAgent.clear()
}
