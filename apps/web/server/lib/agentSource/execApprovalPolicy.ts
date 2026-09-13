// Write the exec-approval policy from the SERVER, not from a browser tab.
//
// THE BUG THIS EXISTS FOR, found by checking the outcome rather than the toast.
// Setting a Boo's Command Execution to "Ask for Unknown" showed "Saved" and wrote
// clawboo's own record, and OpenClaw's policy stayed empty. The Boo went on
// running every command without asking, and nothing on screen said so.
//
// `ExecSettings.persist` puts the Gateway write behind `if (client)`, wrapped in
// a `catch {}`, and shows the success toast unconditionally afterwards. So with
// no Gateway connection in that tab the whole block is skipped in silence. There
// IS a retry, at `chatSendOperation.ts:147`, but it only fires when someone sends
// that Boo a message from a connected tab — which is exactly the condition a
// fleet-wide gate must not depend on. A Boo woken by cron or WhatsApp never
// triggers it, and those are the runs the gate is for.
//
// A PERMISSIONS CONTROL THAT CAN SILENTLY NOT APPLY IS WORSE THAN NO CONTROL,
// because the operator believes the door is shut. The server holds a long-lived
// Gateway connection that already survives reconnects and no longer depends on
// anyone looking at a page, so the policy belongs on it.
//
// SHARED THROUGH A PACKAGE, not reached across the app. `apps/web/server` and
// `apps/web/src` are separate build targets and the repo forbids one importing
// the other, correctly: this module first reached into the browser lib directly
// and lint caught it. The writer now lives in `@clawboo/gateway-client`, which
// both already depend on.
//
// REUSED RATHER THAN COPIED. That function is pure, and
// it carries invariants that are easy to lose in a second copy: it never authors
// the allowlist (`allowlist: prior?.allowlist ?? []`), it preserves the Gateway's
// own `socket` section and `defaults` across a rewrite, and it retries once on a
// base-hash conflict. Two divergent writers of the same document is the failure
// this whole area keeps producing.

import { createLogger } from '@clawboo/logger'

import { upsertExecApprovalPolicy } from '@clawboo/gateway-client'

const log = createLogger('exec-policy')

export interface ExecPolicySource {
  operatorCall<T>(method: string, params?: unknown): Promise<T>
}

/** What the Permissions tab offers, in the Gateway's own vocabulary. */
export type ExecAsk = 'off' | 'on-miss' | 'always'

export function isExecAsk(value: unknown): value is ExecAsk {
  return value === 'off' || value === 'on-miss' || value === 'always'
}

/**
 * Apply a Boo's exec posture to the Gateway.
 *
 * REPORTS FAILURE. The browser path swallowed it and showed success anyway,
 * which is the entire defect; a caller here is told whether the door actually
 * moved so it can say so rather than guess.
 *
 * `sourceAgentId` is OPENCLAW'S agent id, not clawboo's row id. The Gateway keys
 * its policy by its own ids, so passing the wrong one writes a policy for an
 * agent that does not exist — which fails silently, since a policy for a
 * nonexistent agent is simply never consulted. The live store already contains
 * one such entry for a clawboo-native agent that no longer exists.
 */
export async function applyExecApprovalPolicy(
  source: ExecPolicySource,
  sourceAgentId: string,
  execAsk: ExecAsk,
): Promise<{ ok: boolean; error?: string }> {
  try {
    await upsertExecApprovalPolicy(
      { call: (method, params) => source.operatorCall(method, params) },
      sourceAgentId,
      execAsk,
    )
    log.info({ sourceAgentId, execAsk }, 'applied exec approval policy')
    return { ok: true }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    log.warn({ err, sourceAgentId, execAsk }, 'could not apply exec approval policy')
    return { ok: false, error }
  }
}

/**
 * What the Gateway currently holds for an agent, so a caller can show the truth
 * rather than clawboo's local copy of it.
 *
 * The two drifted apart on this machine precisely because the local record was
 * written and the Gateway's was not.
 */
export async function readExecApprovalPolicy(
  source: ExecPolicySource,
  sourceAgentId: string,
): Promise<{ ok: boolean; ask?: string | null; error?: string }> {
  try {
    const snapshot = await source.operatorCall<{
      file?: { agents?: Record<string, { ask?: string }> }
    }>('exec.approvals.get', {})
    const entry = snapshot?.file?.agents?.[sourceAgentId]
    // An ABSENT entry is not "unknown", it is the Gateway's default: run freely.
    // Reporting it as unknown would let the UI keep showing a gate that is off.
    return { ok: true, ask: entry?.ask ?? 'off' }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    return { ok: false, error }
  }
}
