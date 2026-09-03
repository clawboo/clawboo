// Fold the obs event tail into per-agent run status.
//
// Board runs are the gap this fills. Nothing else writes fleet status for them:
// `chatSendOperation` patches it when the USER sends a chat, `useGatewayEvents`
// only fires on the Gateway socket (openclaw), and the `status` frames on the
// chat SSE stream need an open chat stream, which a board run does not have. So
// during the exact window a board task is being worked, every Boo on the graph
// reads idle and its glow stays dark.
//
// The executor already emits `execution_started` / `execution_completed` into
// the durable obs log, and every row carries a top-level `agentId`. That makes
// this a read of data that already exists rather than a new publish path.
//
// The fold is over a WINDOW, not a history, so it is deliberately evidence-only:
// an agent the window says nothing about is left alone rather than assumed idle.
// That keeps a chat run's status (written by the paths above) from being
// clobbered by a stale board event, and keeps a long run whose `execution_started`
// has scrolled out of the window from being reset to idle underneath itself.

import type { AgentStatus } from '@clawboo/gateway-client'

import type { ObsLogEvent } from './useObsStream'

/**
 * How long an `execution_started` may stand alone before it stops meaning
 * "running".
 *
 * Generous on purpose: a long agent run is normal and must not be declared dead
 * underneath itself. This only has to be shorter than "forever", which is what
 * it was.
 */
export const STALE_RUN_MS = 6 * 60 * 60 * 1000

/** Terminal `execution_completed.status` values that should read as a failure. */
const FAILED = new Set(['failed', 'error', 'errored', 'crashed'])

/**
 * The status each agent's most recent execution event implies.
 *
 * `events` must be ascending by `seq` — which is what `useObsStream` returns, as
 * it reverses the newest-first backfill and appends the live tail. Only agents
 * with an execution event in the window appear in the result.
 */
export function deriveRunStatus(
  events: readonly ObsLogEvent[],
  now: number = Date.now(),
): Map<string, AgentStatus> {
  const out = new Map<string, AgentStatus>()
  for (const e of events) {
    if (!e.agentId) continue
    if (e.kind === 'execution_started') {
      // A start with no completion means the run is in flight OR the process
      // died holding it. Nothing ever writes the completion for a killed run, so
      // without an age bound the agent reads as running forever: a start from
      // two months ago was still lighting Boos up on the graph. Past the bound
      // the event is evidence of nothing, so the agent is left alone rather than
      // forced to idle, which is the same evidence-only rule as above.
      if (now - e.ts > STALE_RUN_MS) continue
      out.set(e.agentId, 'running')
      continue
    }
    if (e.kind !== 'execution_completed') continue
    const raw = e.data['status']
    const status = typeof raw === 'string' ? raw.toLowerCase() : ''
    out.set(e.agentId, FAILED.has(status) ? 'error' : 'idle')
  }
  return out
}
