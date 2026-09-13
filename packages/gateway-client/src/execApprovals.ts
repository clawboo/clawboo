/**
 * The session-level exec fields `sessions.patch` still accepts.
 *
 * `execSecurity` and `execAsk` are RETIRED. OpenClaw 2026.9 keeps them in the
 * protocol v4 schema but rejects any request carrying either, `null` included:
 *
 *   execSecurity/execAsk are retired; set permissionMode
 *   (read-only|guarded|workspace|full) instead, or use /exec for this run only.
 *
 * That is an INVALID_REQUEST, so the whole patch fails and the Permissions tab
 * reports "Could not apply setting to live session" on every change.
 *
 * They are not replaced here, because `permissionMode` is not their equivalent:
 * it also sets the session's FILESYSTEM boundary (`guarded` confines reads and
 * writes to the session root, `full` is unrestricted), so mapping the three exec
 * choices onto it would silently re-scope what every agent can touch. The exec
 * posture clawboo actually wants lives in the per-agent approvals policy below,
 * which the Gateway still honours: a session with no explicit mode inherits the
 * global or per-agent exec policy, and a run under `ask: "always"` was measured
 * raising a real approval request on 2026.9.2 with no session mode set at all.
 *
 * `execHost` survives and still means what it did, so it is all that is sent.
 */
export function resolveExecPatchParams(): { execHost: 'gateway' } {
  return { execHost: 'gateway' }
}

// ─── Exec Approvals Policy (per-agent, Gateway-owned store) ──────────────────
// The Gateway keeps exec approval policies in its own store, read and written
// only through `exec.approvals.get` / `exec.approvals.set`. Do NOT reach for the
// file: 2026.5 kept it at `~/.openclaw/exec-approvals.json`, and 2026.9 moved it
// into SQLite, where `get` reports its path as
// `state/openclaw.sqlite#exec_approvals_config`. The RPC contract survived that
// move unchanged, which is the whole reason this code did not have to.
//
// This is SEPARATE from session-level settings (sessions.patch): the Gateway
// consults this policy to decide whether to emit `exec.approval.requested`
// events. Without it, the Gateway silently blocks commands without asking.

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
