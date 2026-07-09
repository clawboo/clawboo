import { useCallback } from 'react'
import { useConnectionStore } from '@/stores/connection'
import { useApprovalsStore } from '@/stores/approvals'
import type { ApprovalDecision, ApprovalRequest } from '@/stores/approvals'
import { useFleetStore } from '@/stores/fleet'
import type { DbApprovalHistory } from '@clawboo/db'
import { GatewayResponseError } from '@clawboo/gateway-client'
import { resolveExecPatchParams, upsertExecApprovalPolicy } from '@/lib/execSettingsForGateway'
import { listAgentSessions } from '@clawboo/control-client'

// ─── Parsers ─────────────────────────────────────────────────────────────────

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null

const asOptionalString = (value: unknown): string | null =>
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : null

const asPositiveTimestamp = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null

export function parseApprovalRequestPayload(payload: unknown): ApprovalRequest | null {
  const p = asRecord(payload)
  if (!p) return null

  const id = asOptionalString(p['id'])
  const request = asRecord(p['request'])
  const createdAtMs = asPositiveTimestamp(p['createdAtMs'])
  const expiresAtMs = asPositiveTimestamp(p['expiresAtMs'])
  if (!id || !request || !createdAtMs || !expiresAtMs) return null

  const command = asOptionalString(request['command'])
  if (!command) return null

  // Resolve agentId: prefer explicit agentId, fall back to session key mapping
  const rawAgentId = asOptionalString(request['agentId'])
  const sessionKey = asOptionalString(request['sessionKey'])
  let agentId = rawAgentId

  if (!agentId && sessionKey) {
    const agents = useFleetStore.getState().agents
    const matched = agents.find((a) => a.sessionKey?.trim() === sessionKey.trim())
    agentId = matched?.id ?? null
  }

  return {
    id,
    agentId,
    sessionKey,
    command,
    cwd: asOptionalString(request['cwd']),
    host: asOptionalString(request['host']),
    security: asOptionalString(request['security']),
    ask: asOptionalString(request['ask']),
    resolvedPath: asOptionalString(request['resolvedPath']),
    createdAtMs,
    expiresAtMs,
    resolving: false,
    error: null,
  }
}

// ─── Approval followup recovery (exported for testing) ───────────────────────

/** The slice of the Gateway client the followup needs (structural — the real
 *  GatewayClient satisfies it; a test passes a recording double). */
export interface ApprovalFollowupClient {
  call<T = unknown>(method: string, params?: unknown): Promise<T>
}

export interface ApprovalFollowupDeps {
  client: ApprovalFollowupClient
  agentId: string
  decision: 'allow-once' | 'allow-always'
  command: string
  sessionKey: string
  activeRunId: string | null
  /** The agent's exec-ask before we (allow-once only) drop it; restored in `finally`. */
  originalExecAsk: string
  /** True when the Gateway's own followup already started the agent — no recovery needed. */
  isAgentResponding: () => boolean
  /** allow-once: wait for the re-run to finish before restoring the exec policy. */
  waitForRerunIdle: () => Promise<void>
  /** Injected so tests need no real timers; defaults to a real `setTimeout`. */
  delay?: (ms: number) => Promise<void>
}

const realDelay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * Recover the output of an approved command when the Gateway's internal
 * deliver:true followup fails silently (webchat-only setups — no channel). Once
 * the original run ends and the agent is NOT already responding, ask the agent to
 * re-run the command itself with **deliver:false** (clawboo's own send — never
 * depending on the Gateway's deliver:true path failing-then-recovering). For
 * allow-once we briefly drop exec approval so the re-run doesn't re-prompt, then
 * ALWAYS restore it in a `finally` (so a transport error can't leave the session
 * with exec approval disabled). No-op when the agent is already responding.
 */
export async function runApprovalFollowup(deps: ApprovalFollowupDeps): Promise<void> {
  const {
    client,
    agentId,
    decision,
    command,
    sessionKey,
    activeRunId,
    originalExecAsk,
  } = deps
  const delay = deps.delay ?? realDelay
  const allowOnce = decision === 'allow-once'

  // 1. Wait for the original run (which returned "approval pending") to finish.
  if (activeRunId) {
    try {
      await client.call('agent.wait', { runId: activeRunId, timeoutMs: 30_000 })
    } catch {
      // Timeout / disconnect — continue; the followup logic is best-effort.
    }
  }
  // 2. Give the Gateway's async exec + its (likely-failing) followup time to run.
  await delay(5_000)
  // 3. If the Gateway followup already started the agent, the output is not lost.
  if (deps.isAgentResponding()) return

  // For allow-once, temporarily disable exec approval so the re-run doesn't loop
  // back into another approval prompt. Both the session-level and file-level
  // policies must be off (the Gateway checks both). allow-always needs no change
  // (the command pattern is already on the allowlist).
  if (allowOnce) {
    await client.call('sessions.patch', {
      key: sessionKey,
      execHost: 'gateway',
      execSecurity: 'full',
      execAsk: 'off',
    })
    await upsertExecApprovalPolicy(client, agentId, 'off')
  }

  try {
    await client.call('chat.send', {
      sessionKey,
      message: [
        `Your command \`${command}\` was approved.`,
        'The system executed it but the output was not captured due to a technical limitation.',
        `Please run this exact command now and share the output with me: \`${command}\``,
      ].join(' '),
      deliver: false,
      idempotencyKey: crypto.randomUUID(),
    })
    if (allowOnce) await deps.waitForRerunIdle()
  } catch {
    // Best-effort recovery — the approval itself already succeeded at the Gateway;
    // a transport hiccup on the re-run must not surface as an approval error.
  } finally {
    // ALWAYS restore the allow-once exec policy — even if the re-run threw — so a
    // transport error can't strand the session with exec approval disabled.
    if (allowOnce) {
      try {
        await client.call('sessions.patch', {
          key: sessionKey,
          ...resolveExecPatchParams(originalExecAsk),
        })
        await upsertExecApprovalPolicy(client, agentId, originalExecAsk)
      } catch {
        // Best-effort — the settings page re-applies the policy on the next send.
      }
    }
  }
}

// ─── useApprovalActions hook ──────────────────────────────────────────────────

export function useApprovalActions() {
  const client = useConnectionStore((s) => s.client)
  const { setResolving, removePending, prependHistory } = useApprovalsStore()
  const pendingApprovals = useApprovalsStore((s) => s.pendingApprovals)

  const handleApproval = useCallback(
    async (id: string, decision: ApprovalDecision) => {
      if (!client) return

      const approval = pendingApprovals.get(id)
      setResolving(id, true, null)

      try {
        // Send decision to Gateway
        await client.call('exec.approval.resolve', { id, decision })

        // Persist to SQLite via API route
        const agentId = approval?.agentId ?? null
        const toolName = approval?.command ?? 'unknown'

        if (agentId) {
          try {
            const res = await fetch('/api/approvals', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                agentId,
                action: decision,
                toolName,
                details: approval
                  ? {
                      command: approval.command,
                      cwd: approval.cwd,
                      host: approval.host,
                      security: approval.security,
                      resolvedPath: approval.resolvedPath,
                    }
                  : null,
              }),
            })

            if (res.ok) {
              const data = (await res.json()) as { record?: DbApprovalHistory }
              if (data.record) {
                prependHistory(data.record)
              }
            }
          } catch {
            // API persistence failure is non-fatal — decision already sent to gateway
          }
        }

        removePending(id)

        // After an allow decision, the Gateway runs the approved command and tries
        // an internal followup with deliver:true — which fails silently in
        // webchat-only setups (no channel), stranding the command output. Recover
        // it via the deterministic, restore-guaranteed `runApprovalFollowup` helper
        // (drives the re-run with deliver:false from clawboo's side).
        if (agentId && (decision === 'allow-once' || decision === 'allow-always')) {
          const agent = useFleetStore.getState().agents.find((a) => a.id === agentId)
          // Route the followup to the agent's own session. (Team-chat approvals no
          // longer redirect via a session override — the server orchestrator owns
          // team runs now; a team-originated re-run renders in the 1:1 session.)
          const sessionKey = agent?.sessionKey ?? null
          if (sessionKey) {
            await runApprovalFollowup({
              client,
              agentId,
              decision,
              command: approval?.command ?? 'the requested command',
              sessionKey,
              activeRunId: agent?.runId ?? null,
              originalExecAsk: agent?.execConfig?.execAsk ?? 'always',
              isAgentResponding: () =>
                useFleetStore.getState().agents.find((a) => a.id === agentId)?.status === 'running',
              waitForRerunIdle: async () => {
                for (let i = 0; i < 60; i++) {
                  await new Promise((r) => setTimeout(r, 1_000))
                  const a = useFleetStore.getState().agents.find((x) => x.id === agentId)
                  if (!a || a.status === 'idle' || a.status === 'error') break
                }
              },
            })
          }

          // Best-effort history refresh to catch any events we missed.
          try {
            await listAgentSessions(agentId)
          } catch {
            // Non-fatal — transcript is built from events
          }
        }
      } catch (err) {
        // Gateway returns "unknown approval id" when the approval has already expired
        // (timeout is Gateway-side, ~120s). Silently remove the card instead of
        // showing a confusing error — matches OpenClaw Studio's behavior.
        if (
          err instanceof GatewayResponseError &&
          /unknown.*approval.*id|expired/i.test(err.message)
        ) {
          removePending(id)
          return
        }
        const message = err instanceof Error ? err.message : 'Failed to resolve exec approval.'
        setResolving(id, false, message)
      }
    },
    [client, pendingApprovals, setResolving, removePending, prependHistory],
  )

  return { handleApproval }
}
