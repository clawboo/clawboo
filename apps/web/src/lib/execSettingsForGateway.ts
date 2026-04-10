/**
 * Maps the user-facing `execAsk` value to the full set of Gateway session
 * exec parameters.  The Gateway needs three fields to be sent together:
 *
 *   execHost     — where commands run ("gateway" or null to disable)
 *   execSecurity — allowlist mode ("allowlist" = check list + ask, "full" = pre-approved, "deny" = none)
 *   execAsk      — approval prompt ("off" | "on-miss" | "always")
 *
 * Reference: openclaw-studio `resolveSessionExecSettingsForRole` in
 * `agentPermissionsOperation.ts`.
 */
export function resolveExecPatchParams(execAsk: string): {
  execHost: 'gateway' | null
  execSecurity: 'deny' | 'allowlist' | 'full'
  execAsk: 'off' | 'on-miss' | 'always'
} {
  switch (execAsk) {
    case 'always':
      // allowlist security + always ask = approval required for every command.
      // Matches OpenClaw Studio's collaborative role: security is 'allowlist' so commands
      // go through the exec approval pipeline; 'ask: always' ensures every command triggers
      // an approval prompt regardless of allowlist match.
      return { execHost: 'gateway', execSecurity: 'allowlist', execAsk: 'always' }
    case 'on-miss':
      // allowlist security + on-miss ask = only ask for commands not on the allowlist.
      return { execHost: 'gateway', execSecurity: 'allowlist', execAsk: 'on-miss' }
    case 'off':
    default:
      // full security + no ask = run freely.
      return { execHost: 'gateway', execSecurity: 'full', execAsk: 'off' }
  }
}

// ─── Exec Approvals Policy (per-agent, Gateway file) ─────────────────────────
// The Gateway stores exec approval policies in a JSON file (`exec-approvals.json`).
// This is SEPARATE from session-level settings (sessions.patch) — the Gateway
// checks this file to decide whether to emit `exec.approval.requested` events.
// Without this policy, the Gateway silently blocks commands without asking.
//
// Reference: openclaw-studio `upsertGatewayAgentExecApprovals` in
// `src/lib/gateway/execApprovals.ts`.

type ExecApprovalsFile = {
  version: 1
  socket?: { path?: string; token?: string }
  defaults?: { security?: string; ask?: string }
  agents?: Record<string, { security?: string; ask?: string; allowlist?: { pattern: string }[] }>
}

type ExecApprovalsSnapshot = {
  path: string
  exists: boolean
  hash: string
  file?: ExecApprovalsFile
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
  const snapshot = await client.call<ExecApprovalsSnapshot>('exec.approvals.get', {})

  const baseFile: ExecApprovalsFile =
    snapshot.file && typeof snapshot.file === 'object'
      ? {
          version: 1,
          // Preserve the socket section — the Gateway creates it internally as an IPC
          // channel for routing approval resolutions to waiting agent processes.
          // Stripping it breaks the resolution flow: `exec.approval.resolve` succeeds
          // at the RPC level but the agent process never receives the decision.
          // OpenClaw Studio follows the same pattern — preserving socket on write.
          socket: snapshot.file.socket,
          defaults: snapshot.file.defaults,
          agents: { ...(snapshot.file.agents ?? {}) },
        }
      : { version: 1, agents: {} }

  const nextAgents = { ...(baseFile.agents ?? {}) }

  if (execAsk === 'off') {
    // Remove per-agent policy — use Gateway defaults (run freely)
    if (agentId in nextAgents) {
      delete nextAgents[agentId]
    }
  } else {
    const existing = nextAgents[agentId] ?? {}
    nextAgents[agentId] = {
      ...existing,
      security: 'allowlist',
      ask: execAsk as 'on-miss' | 'always',
      allowlist: existing.allowlist ?? [],
    }
  }

  const nextFile: ExecApprovalsFile = {
    ...baseFile,
    version: 1,
    agents: nextAgents,
  }

  const payload: Record<string, unknown> = { file: nextFile }
  if (snapshot.exists && snapshot.hash) {
    payload.baseHash = snapshot.hash
  }

  try {
    await client.call('exec.approvals.set', payload)
  } catch (err) {
    // Retry once on hash conflict
    const msg = err instanceof Error ? err.message : ''
    if (/hash|changed|re-run/i.test(msg)) {
      const fresh = await client.call<ExecApprovalsSnapshot>('exec.approvals.get', {})
      const retryPayload: Record<string, unknown> = { file: nextFile }
      if (fresh.exists && fresh.hash) retryPayload.baseHash = fresh.hash
      await client.call('exec.approvals.set', retryPayload)
    } else {
      throw err
    }
  }
}
