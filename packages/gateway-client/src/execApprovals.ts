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

/**
 * One standing exec grant, as the GATEWAY actually writes it.
 *
 * This said `{ pattern: string }` and the real thing carries four more fields.
 * A single "Always" on one command was measured minting TWO of these:
 *
 *   { id: "a2583e84-...", pattern: "/bin/echo",
 *     argPattern: "sha256:cwd-argv:v1:f76b60c1...",
 *     source: "allow-always", lastUsedAt: 1789273436004 }
 *   { id: "cd9cc459-...", pattern: "=node-command:769c1dbc2726f769",
 *     source: "allow-always", lastUsedAt: 1789273436004 }
 *
 * The under-description was harmless only because `upsertExecApprovalPolicy`
 * carries the array across by reference and never rebuilds an entry. Anything
 * that maps over these, which is what an editor does, would have narrowed them
 * to `{ pattern }` and written back grants the Gateway no longer honours,
 * silently: an entry missing its `argPattern` no longer matches the command it
 * was minted for.
 *
 * `index signature` rather than a closed shape, deliberately. These are the
 * fields observed on 2026.9.2; the Gateway owns this document and may add more,
 * and a closed type would invite exactly the narrowing described above.
 */
export type ExecAllowlistEntry = {
  /** The Gateway's own id for the grant. Stable, and the handle for removing one. */
  id?: string
  /** The resolved binary, or `=node-command:<hash>` for a shell-parsed form. */
  pattern: string
  /** Binds the grant to the argv AND the working directory it was minted in. */
  argPattern?: string
  /** `allow-always` for an operator-minted grant, versus a configured entry. */
  source?: string
  lastUsedAt?: number
  [key: string]: unknown
}

export type AgentApprovalPolicy = {
  security?: string
  ask?: string
  allowlist?: ExecAllowlistEntry[]
}

export type GatewayApprovalsDoc = {
  version: 1
  socket?: { path?: string; token?: string }
  defaults?: { security?: string; ask?: string }
  agents?: Record<string, AgentApprovalPolicy>
}

export type ApprovalsGetResult = {
  path: string
  exists: boolean
  hash: string
  file?: GatewayApprovalsDoc
}

type GatewayClientLike = {
  call<T = unknown>(method: string, params?: unknown): Promise<T>
}

/**
 * The Gateway's compare-and-swap refusals, in all six spellings it ships.
 *
 * Matched NARROWLY on purpose. The previous test was `/hash|changed|re-run/i`,
 * which also catches "exec approvals changed after migration loaded them" and
 * anything else that happens to contain the word. Treating an unrelated error as
 * a conflict means retrying a write the Gateway refused for a different reason,
 * and this document is the fleet's permissions. Anything unrecognised rethrows
 * with no retry.
 */
const EXEC_APPROVALS_CONFLICT =
  /exec approvals (?:base hash (?:required|unavailable)|changed(?: since last load)?)/i

export interface ExecApprovalsMutationOutcome {
  /** False only when `mutate` declined to produce a document. */
  wrote: boolean
  attempts: number
  /**
   * What the Gateway said the document looks like AFTER the write.
   *
   * `exec.approvals.set` answers with `toExecApprovalsPayload(nextSnapshot)`
   * (exec-approvals-C9Z7E1JE.js:129), so a caller can prove its change landed
   * from the reply alone. That matters here because the obvious way to check,
   * calling `exec.approvals.get` again, is itself a write.
   */
  result?: ApprovalsGetResult
}

/**
 * Read, change, write back, and actually honour the Gateway's compare-and-swap.
 *
 * THE BUG THIS REPLACES was a lost update, and it defeated the exact mechanism it
 * appeared to implement. On a base-hash conflict the old code re-read the
 * snapshot, took ONLY its new `hash`, and re-sent the document it had computed
 * from the STALE read. That converts a compare-and-swap into last-writer-wins:
 * whatever the other writer had just committed was silently erased, and the call
 * reported success. The other writer here is not hypothetical. The Gateway itself
 * mints allowlist entries when an operator answers "Always", so an operator
 * changing a Boo's posture in one tab could delete a grant they had approved
 * seconds earlier in another.
 *
 * `mutate` is therefore re-run against each fresh read rather than its result
 * being re-sent. It receives the current document and returns the next one, or
 * `null` to write nothing at all, which is how a caller says "there was nothing
 * to change" without spending a write on the fleet's permissions document.
 */
export async function mutateExecApprovalsDoc(
  client: GatewayClientLike,
  mutate: (current: GatewayApprovalsDoc | undefined) => GatewayApprovalsDoc | null,
  opts: { attempts?: number } = {},
): Promise<ExecApprovalsMutationOutcome> {
  const maxAttempts = Math.max(1, opts.attempts ?? 3)
  let lastConflict: unknown

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const snapshot = await client.call<ApprovalsGetResult>('exec.approvals.get', {})
    // A REPLY THIS DOES NOT UNDERSTAND IS NOT AN EMPTY DOCUMENT. Carrying on with
    // `current = undefined` would build a fresh document from nothing and write it
    // over whatever the Gateway actually holds, reporting success. The one thing
    // this document must never suffer is being replaced by a guess.
    if (!snapshot || typeof snapshot !== 'object') {
      throw new Error('exec approvals: the Gateway did not return a policy snapshot')
    }
    const current =
      typeof snapshot.file === 'object' && snapshot.file !== null ? snapshot.file : undefined

    const next = mutate(current)
    if (next === null) return { wrote: false, attempts: attempt }

    const payload: Record<string, unknown> = { file: next }
    if (snapshot.exists && snapshot.hash) payload.baseHash = snapshot.hash

    try {
      const result = await client.call<ApprovalsGetResult>('exec.approvals.set', payload)
      return { wrote: true, attempts: attempt, result }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (!EXEC_APPROVALS_CONFLICT.test(msg)) throw err
      lastConflict = err
    }
  }

  // Exhausted rather than resolved. Reporting success here would be the same lie
  // the old retry told, just later.
  throw lastConflict instanceof Error
    ? lastConflict
    : new Error('exec approvals: the document kept changing under this write')
}

/**
 * Write a Boo's exec approval posture, preserving everything else about it.
 *
 * "RUN FREELY" USED TO DESTROY EVERY STANDING GRANT. The old code carried over
 * every OTHER agent's entry and simply omitted this one when `execAsk` was
 * 'off', on the reasoning that an absent bucket falls back to the Gateway
 * defaults. The posture reasoning was right and the blast radius was not: the
 * bucket is also where that Boo's allowlist lives, so one click of the least
 * alarming option in the dropdown silently deleted every "Always" the operator
 * had ever granted it, with no warning and nothing on screen afterwards to show
 * what had been there. This repo already has that exact wipe in its incident
 * record, from a different caller.
 *
 * Removing the two POSTURE FIELDS achieves the same fallback with none of the
 * loss. `resolveAgentSecurityField` and `resolveAgentAskField` test
 * `rawAgent[field] != null` and fall through to the wildcard and then the
 * defaults when it is absent; the bucket's mere existence is never consulted. So
 * a bucket holding only an allowlist resolves exactly as a missing one, and the
 * grants are still there when the operator turns asking back on.
 */
export async function upsertExecApprovalPolicy(
  client: GatewayClientLike,
  agentId: string,
  execAsk: string,
): Promise<void> {
  await mutateExecApprovalsDoc(client, (current) => {
    const agents: Record<string, AgentApprovalPolicy> = { ...(current?.agents ?? {}) }
    const prior = agents[agentId]

    if (execAsk === 'off') {
      if (!prior) return null
      const { security: _security, ask: _ask, ...keep } = prior
      // Nothing of this Boo's left to keep, so do not leave an empty bucket
      // behind. An absent bucket and an empty one resolve identically.
      if (Object.keys(keep).length === 0) delete agents[agentId]
      else agents[agentId] = keep
    } else {
      agents[agentId] = {
        ...prior,
        security: 'allowlist',
        ask: execAsk as 'on-miss' | 'always',
        // NEVER authored here, only carried. An entry rebuilt from a narrower
        // shape loses its `argPattern` and then matches nothing, so the grant is
        // gone while the row still looks present.
        allowlist: prior?.allowlist ?? [],
      }
    }

    const nextDoc: GatewayApprovalsDoc = { version: 1, agents }
    // The Gateway creates the `socket` section internally as an IPC channel for
    // routing approval resolutions to waiting agent processes. Dropping it on a
    // rewrite breaks the resolution flow (`exec.approval.resolve` succeeds at the
    // RPC level but the agent process never hears the decision), so it, and any
    // stored defaults, must survive the round-trip.
    if (current?.socket) nextDoc.socket = current.socket
    if (current?.defaults) nextDoc.defaults = current.defaults
    return nextDoc
  })
}
