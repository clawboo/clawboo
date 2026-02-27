'use client'

import { useCallback } from 'react'
import { useConnectionStore } from '@/stores/connection'
import { useApprovalsStore } from '@/stores/approvals'
import type { ApprovalDecision, ApprovalRequest } from '@/stores/approvals'
import { useFleetStore } from '@/stores/fleet'
import type { DbApprovalHistory } from '@clawboo/db'

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
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to resolve exec approval.'
        setResolving(id, false, message)
      }
    },
    [client, pendingApprovals, setResolving, removePending, prependHistory],
  )

  return { handleApproval }
}
