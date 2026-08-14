import type { ClassifiedEvent, EventHandlerDeps, EventHandlerHandle, EventIntent } from './types'

const CLOSED_RUN_TTL_MS = 30_000
const CLOSED_RUNS_MAX_SIZE = 500

// ── createEventHandler ─────────────────────────────────────────────────────

export function createEventHandler(deps: EventHandlerDeps): EventHandlerHandle {
  let summaryRefreshTimer: ReturnType<typeof setTimeout> | null = null
  // runId → expiry timestamp; guards against stale terminal events
  const closedRuns = new Map<string, number>()

  function pruneClosedRuns(): void {
    const now = Date.now()
    for (const [runId, expiry] of closedRuns) {
      if (now > expiry) closedRuns.delete(runId)
    }
    // Evict oldest entries if map exceeds max size
    if (closedRuns.size > CLOSED_RUNS_MAX_SIZE) {
      const excess = closedRuns.size - CLOSED_RUNS_MAX_SIZE
      const iter = closedRuns.keys()
      for (let i = 0; i < excess; i++) {
        const key = iter.next().value
        if (key !== undefined) closedRuns.delete(key)
      }
    }
  }

  function applyIntents(intents: EventIntent[], _event: ClassifiedEvent): void {
    pruneClosedRuns()

    for (const intent of intents) {
      switch (intent.kind) {
        case 'queueLivePatch':
          deps.queueLivePatch(intent.agentId, intent.patch, intent.sessionKey)
          break

        case 'clearPendingLivePatch':
          deps.clearPendingLivePatch(intent.agentId)
          break

        case 'commitChat': {
          // Drop a replayed terminal frame for a run that already closed. Two
          // things must not happen twice: minting fresh transcript entryIds (the
          // triple-render symptom), and applying the terminal patch — which, if a
          // NEW run has since started, flips a live agent back to idle.
          //
          // Compare the INCOMING frame's runId, never `getAgentRunId(agentId)`:
          // once a run closes the agent's runId is null (or already the NEXT
          // run's id), so a current-runId read can never name the run this guard
          // exists to recognise.
          //
          // A legitimate post-approval continuation carries the SAME runId, but
          // its run was never closed — `dispatchIntent` skips the status patch
          // while an approval is pending, so the pre/post comparison below never
          // fires and the id is absent from `closedRuns`. It passes.
          //
          // A missing runId fails OPEN: losing a real message is worse than
          // showing a duplicate.
          if (intent.runId && closedRuns.has(intent.runId)) {
            deps.log?.debug(
              { kind: intent.kind, agentId: intent.agentId, runId: intent.runId },
              'skipping stale commitChat for closed run',
            )
            break
          }
          deps.clearPendingLivePatch(intent.agentId)
          if (intent.outputLines.length > 0) {
            deps.appendOutputLines(intent.agentId, intent.outputLines, intent.sessionKey)
          }
          // Capture runId BEFORE dispatch — dispatchIntent may clear it
          const preCommitRunId = deps.getAgentRunId(intent.agentId)
          deps.dispatchIntent(intent)
          // Mark the run as closed ONLY if dispatchIntent actually cleared the runId.
          // When an exec approval is pending, dispatchIntent skips the status patch,
          // keeping the runId alive — we must NOT mark it as closed or we'll
          // incorrectly drop subsequent events for the same run (lifecycle end,
          // second chat final after the approval resolves).
          const postCommitRunId = deps.getAgentRunId(intent.agentId)
          if (preCommitRunId && !postCommitRunId) {
            closedRuns.set(preCommitRunId, Date.now() + CLOSED_RUN_TTL_MS)
          }
          break
        }

        case 'updateAgentStatus': {
          // Skip stale terminal updates for runs that already closed. Same rule
          // as `commitChat`: match the INCOMING frame's runId. Reading the
          // agent's CURRENT runId here was a no-op — a closed run's runId is
          // already null, so the comparison could never be true for the run this
          // guard exists to recognise.
          if (intent.patch.status !== 'running') {
            if (intent.runId && closedRuns.has(intent.runId)) {
              deps.log?.debug(
                { kind: intent.kind, agentId: intent.agentId, runId: intent.runId },
                'skipping stale terminal updateAgentStatus',
              )
              break
            }
          }
          const preStatusRunId = deps.getAgentRunId(intent.agentId)
          deps.dispatchIntent(intent)
          // Mark run as closed on terminal status, but only if the runId was
          // actually cleared by dispatchIntent (same guard as commitChat — pending
          // approvals may block the status change, keeping the run alive).
          if (intent.patch.runId === null && intent.patch.status !== 'running') {
            const postStatusRunId = deps.getAgentRunId(intent.agentId)
            if (preStatusRunId && !postStatusRunId) {
              closedRuns.set(preStatusRunId, Date.now() + CLOSED_RUN_TTL_MS)
            }
          }
          break
        }

        case 'scheduleSummaryRefresh': {
          // Debounce: cancel any pending refresh before scheduling a new one
          if (summaryRefreshTimer !== null) {
            deps.clearTimeout(summaryRefreshTimer)
            summaryRefreshTimer = null
          }
          const { delayMs, includeHeartbeatRefresh } = intent
          summaryRefreshTimer = deps.setTimeout(() => {
            summaryRefreshTimer = null
            void deps.loadSummarySnapshot()
            if (includeHeartbeatRefresh) {
              deps.refreshHeartbeatLatest()
            }
          }, delayMs)
          break
        }

        case 'requestHistoryRefresh':
          // Fire-and-forget async
          void deps.requestHistoryRefresh(intent.agentId, intent.reason)
          break

        case 'approvalPending':
        case 'approvalResolved':
          deps.dispatchIntent(intent)
          break

        case 'ignore':
          deps.log?.debug({ reason: intent.reason }, 'event ignored')
          break
      }
    }
  }

  function dispose(): void {
    if (summaryRefreshTimer !== null) {
      deps.clearTimeout(summaryRefreshTimer)
      summaryRefreshTimer = null
    }
    closedRuns.clear()
  }

  return { applyIntents, dispose }
}
