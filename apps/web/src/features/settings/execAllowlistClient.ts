// Typed access to the standing-grant routes.
//
// EVERY CALL CHECKS `res.ok`. `apiFetch` is a thin wrapper over `fetch` and does
// not throw on a non-2xx, which is the exact trap the Permissions tab fell into:
// the server answered 502, the browser discarded it, and a success toast went up
// over a gate that was never applied.
//
// "Could not read" is a first-class state here rather than an absence, because a
// read that degraded to an empty list would print "no standing grants" over a
// policy document whose grants are still on disk and still being enforced.

import { apiFetch } from '@clawboo/control-client'

export interface ExecAllowlistRow {
  key: string
  pattern: string
  argPattern: string | null
  source: string | null
  classification:
    | 'bound-grant'
    | 'node-marker'
    | 'exact-command-grant'
    | 'inert-allow-always'
    | 'path-rule'
    | 'arg-rule'
    | 'catch-all'
    | 'inert'
  bucket: 'agent' | 'wildcard'
  lastUsedCommand: string | null
  lastResolvedPath: string | null
  lastUsedAt: number | null
}

export interface ExecAllowlistSnapshot {
  entries: ExecAllowlistRow[]
  wildcard: ExecAllowlistRow[]
  duplicatedInWildcard: string[]
  storedSecurity: string | null
  storedAsk: string | null
  defaultSecurity: string | null
  defaultAsk: string | null
  updatedAtMs: number
}

export type ExecAllowlistState =
  | { state: 'ok'; snapshot: ExecAllowlistSnapshot }
  /** No policy document exists at all. The one honest empty. */
  | { state: 'absent' }
  /** This runtime keeps no standing-grant store. Not the same as having none. */
  | { state: 'not-applicable' }
  /** The document exists and could not be read. Never render as empty. */
  | { state: 'unreadable'; error: string; knownAllowlistCount: number }

export async function fetchExecAllowlist(agentId: string): Promise<ExecAllowlistState> {
  try {
    const res = await apiFetch(`/api/exec-allowlist?agentId=${encodeURIComponent(agentId)}`)
    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null
    const state = typeof body?.['state'] === 'string' ? body['state'] : null

    if (state === 'unreadable' || !res.ok) {
      return {
        state: 'unreadable',
        error:
          typeof body?.['error'] === 'string' ? body['error'] : `clawboo could not read the policy`,
        knownAllowlistCount:
          typeof body?.['knownAllowlistCount'] === 'number' ? body['knownAllowlistCount'] : 0,
      }
    }
    if (state === 'absent') return { state: 'absent' }
    if (state === 'not-applicable') return { state: 'not-applicable' }
    return { state: 'ok', snapshot: body as unknown as ExecAllowlistSnapshot }
  } catch (err) {
    // A transport failure is an unreadable policy, not an empty one.
    return {
      state: 'unreadable',
      error: err instanceof Error ? err.message : 'clawboo could not be reached',
      knownAllowlistCount: 0,
    }
  }
}

export interface RevokeResult {
  ok: boolean
  outcome: string
  error?: string
  removed?: number
}

export async function revokeExecGrants(agentId: string, keys: string[]): Promise<RevokeResult> {
  try {
    const res = await apiFetch('/api/exec-allowlist/revoke', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agentId, keys }),
    })
    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null
    const outcome = typeof body?.['outcome'] === 'string' ? body['outcome'] : 'failed'
    if (!res.ok) {
      return {
        ok: false,
        outcome,
        error: typeof body?.['error'] === 'string' ? body['error'] : `the Gateway refused`,
      }
    }
    return {
      ok: true,
      outcome,
      removed: typeof body?.['removed'] === 'number' ? body['removed'] : undefined,
    }
  } catch (err) {
    return {
      ok: false,
      outcome: 'failed',
      error: err instanceof Error ? err.message : 'clawboo could not be reached',
    }
  }
}
