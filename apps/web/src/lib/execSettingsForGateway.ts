/**
 * Maps the user-facing `execAsk` value to the full set of Gateway session
 * exec parameters.  The Gateway needs three fields to be sent together:
 *
 *   execHost     — where commands run ("gateway" or null to disable)
 *   execSecurity — allowlist mode ("allowlist" = check list + ask, "full" = pre-approved, "deny" = none)
 *   execAsk      — approval prompt ("off" | "on-miss" | "always")
 */
export function resolveExecPatchParams(execAsk: string): {
  execHost: 'gateway' | null
  execSecurity: 'deny' | 'allowlist' | 'full'
  execAsk: 'off' | 'on-miss' | 'always'
} {
  switch (execAsk) {
    case 'always':
      // 'allowlist' security routes every command through the exec approval
      // pipeline, and 'ask: always' prompts even when a command matches the
      // allowlist — so nothing runs without an explicit user decision.
      return { execHost: 'gateway', execSecurity: 'allowlist', execAsk: 'always' }
    case 'on-miss':
      // Only commands that miss the allowlist prompt for approval.
      return { execHost: 'gateway', execSecurity: 'allowlist', execAsk: 'on-miss' }
    case 'off':
    default:
      // Fully pre-approved: commands run without prompting.
      return { execHost: 'gateway', execSecurity: 'full', execAsk: 'off' }
  }
}

// ─── Exec Approvals Policy (per-agent, Gateway file) ─────────────────────────
// The Gateway stores exec approval policies in a JSON file (`exec-approvals.json`).
// This is SEPARATE from session-level settings (sessions.patch) — the Gateway
// checks this file to decide whether to emit `exec.approval.requested` events.
// Without this policy, the Gateway silently blocks commands without asking.

type AgentApprovalPolicy = {
  security?: string
  ask?: string
  allowlist?: { pattern: string }[]
}

type GatewayApprovalsDoc = {
  version: 1
  socket?: { path?: string; token?: string }
  defaults?: { security?: string; ask?: string }
  agents?: Record<string, AgentApprovalPolicy>
}

type ApprovalsGetResult = {
  path: string
  exists: boolean
  hash: string
  file?: GatewayApprovalsDoc
}

type GatewayClientLike = {
  call<T = unknown>(method: string, params?: unknown): Promise<T>
}

/**
 * Writes the per-agent exec approval policy to the Gateway's exec-approvals file.
 * This must be called alongside `sessions.patch` for approval events to work.
 */
export async function upsertExecApprovalPolicy(
  client: GatewayClientLike,
  agentId: string,
  execAsk: string,
): Promise<void> {
  const snapshot = await client.call<ApprovalsGetResult>('exec.approvals.get', {})
  const current =
    typeof snapshot.file === 'object' && snapshot.file !== null ? snapshot.file : undefined

  // Rebuild the per-agent policy map: every other agent's entry carries over
  // untouched; this agent is either dropped (execAsk 'off' = fall back to the
  // Gateway defaults, run freely) or upserted with an allowlist policy layered
  // over whatever the Gateway already stored for it.
  const agents: Record<string, AgentApprovalPolicy> = {}
  for (const [id, entry] of Object.entries(current?.agents ?? {})) {
    if (id !== agentId) agents[id] = entry
  }
  if (execAsk !== 'off') {
    const prior = current?.agents?.[agentId]
    agents[agentId] = {
      ...prior,
      security: 'allowlist',
      ask: execAsk as 'on-miss' | 'always',
      allowlist: prior?.allowlist ?? [],
    }
  }

  const nextDoc: GatewayApprovalsDoc = { version: 1, agents }
  // The Gateway creates the `socket` section internally as an IPC channel for
  // routing approval resolutions to waiting agent processes. Dropping it on a
  // rewrite breaks the resolution flow (`exec.approval.resolve` succeeds at the
  // RPC level but the agent process never hears the decision) — so it, and any
  // stored defaults, must survive the round-trip.
  if (current?.socket) nextDoc.socket = current.socket
  if (current?.defaults) nextDoc.defaults = current.defaults

  const payload: Record<string, unknown> = { file: nextDoc }
  if (snapshot.exists && snapshot.hash) {
    payload.baseHash = snapshot.hash
  }

  try {
    await client.call('exec.approvals.set', payload)
  } catch (err) {
    // Retry once on hash conflict
    const msg = err instanceof Error ? err.message : ''
    if (/hash|changed|re-run/i.test(msg)) {
      const fresh = await client.call<ApprovalsGetResult>('exec.approvals.get', {})
      const retryPayload: Record<string, unknown> = { file: nextDoc }
      if (fresh.exists && fresh.hash) retryPayload.baseHash = fresh.hash
      await client.call('exec.approvals.set', retryPayload)
    } else {
      throw err
    }
  }
}
