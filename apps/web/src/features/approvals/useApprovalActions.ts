import { useCallback } from 'react'
import { useConnectionStore } from '@/stores/connection'
import { useApprovalsStore } from '@/stores/approvals'
import type { ApprovalDecision, ApprovalRequest } from '@/stores/approvals'
import { useFleetStore } from '@/stores/fleet'
import type { DbApprovalHistory } from '@clawboo/db'
import { resolveExecPatchParams, upsertExecApprovalPolicy } from '@/lib/execSettingsForGateway'

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

        // After an allow decision, the Gateway runs the approved command asynchronously
        // and tries to send a followup via its internal `agent` method with deliver:true.
        // In webchat-only setups (no Slack/Discord/Telegram configured), this fails with
        // "Channel is required (no configured channels detected)" because deliver:true
        // requires a messaging channel. The error is silently swallowed (.catch(() => {})),
        // but the followup agent run never starts — the agent stays idle and the command
        // output is permanently lost (never injected into the session).
        //
        // Workaround: wait for the initial run to end + command to execute, then check
        // if the Gateway's followup succeeded (agent is running). If not, tell the agent
        // to re-run the command itself so it can capture the output directly.
        //
        // For allow-always: the command pattern is on the allowlist, so re-running works.
        // For allow-once: we temporarily disable exec approval so the re-run doesn't
        //   trigger another approval loop, then restore settings after the agent finishes.
        if (agentId && (decision === 'allow-once' || decision === 'allow-always')) {
          const agent = useFleetStore.getState().agents.find((a) => a.id === agentId)
          const sessionKey = agent?.sessionKey
          const activeRunId = agent?.runId ?? null

          // 1. Wait for the original agent run to finish (returns "approval pending" tool result)
          if (activeRunId) {
            try {
              await client.call('agent.wait', { runId: activeRunId, timeoutMs: 30_000 })
            } catch {
              // Timeout or disconnect — continue with followup logic
            }
          }

          // 2. Wait for the Gateway's async exec process to complete.
          //    The Gateway runs the command, captures output, then tries sendExecApprovalFollowup.
          //    Give it time to finish before checking if the agent responded.
          await new Promise((resolve) => setTimeout(resolve, 5_000))

          // 3. Check if the Gateway's followup succeeded (agent started a new run)
          const agentAfter = useFleetStore.getState().agents.find((a) => a.id === agentId)
          const agentIsResponding = agentAfter?.status === 'running'

          if (!agentIsResponding && sessionKey) {
            // Gateway followup failed — the exec output is lost.
            // Tell the agent to re-run the command so it can capture the output itself.
            const cmd = approval?.command ?? 'the requested command'
            const originalExecAsk = agent?.execConfig?.execAsk ?? 'always'

            try {
              // For allow-once: temporarily disable exec approval so the re-run
              // doesn't trigger another approval loop. Both session-level and
              // file-level policies must be updated — the Gateway checks both.
              if (decision === 'allow-once') {
                await client.call('sessions.patch', {
                  key: sessionKey,
                  execHost: 'gateway',
                  execSecurity: 'full',
                  execAsk: 'off',
                })
                await upsertExecApprovalPolicy(client, agentId, 'off')
              }
              // For allow-always: command is already on the allowlist — no changes needed.

              // Send followup telling the agent to re-run the command.
              // The agent will execute it, get the real output, and share the results.
              await client.call('chat.send', {
                sessionKey,
                message: [
                  `Your command \`${cmd}\` was approved.`,
                  'The system executed it but the output was not captured due to a technical limitation.',
                  `Please run this exact command now and share the output with me: \`${cmd}\``,
                ].join(' '),
                deliver: false,
                idempotencyKey: crypto.randomUUID(),
              })

              // For allow-once: wait for the re-run to complete, then restore settings
              if (decision === 'allow-once') {
                for (let i = 0; i < 60; i++) {
                  await new Promise((r) => setTimeout(r, 1_000))
                  const a = useFleetStore.getState().agents.find((x) => x.id === agentId)
                  if (!a || a.status === 'idle' || a.status === 'error') break
                }
                // Restore exec approval settings
                try {
                  await client.call('sessions.patch', {
                    key: sessionKey,
                    ...resolveExecPatchParams(originalExecAsk),
                  })
                  await upsertExecApprovalPolicy(client, agentId, originalExecAsk)
                } catch {
                  // Best-effort restore — settings page will re-apply on next send
                }
              }
            } catch {
              // Non-fatal — best-effort restore on error
              if (decision === 'allow-once') {
                try {
                  await client.call('sessions.patch', {
                    key: sessionKey,
                    ...resolveExecPatchParams(originalExecAsk),
                  })
                  await upsertExecApprovalPolicy(client, agentId, originalExecAsk)
                } catch {
                  // Settings page will re-apply on next send
                }
              }
            }
          }

          // 4. Best-effort history refresh to catch any events we missed
          try {
            await client.sessions.list(agentId)
          } catch {
            // Non-fatal — transcript is built from events
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to resolve exec approval.'
        setResolving(id, false, message)
      }
    },
    [client, pendingApprovals, setResolving, removePending, prependHistory],
  )

  return { handleApproval }
}
