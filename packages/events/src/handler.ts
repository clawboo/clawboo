import type { ClassifiedEvent, EventHandlerDeps, EventHandlerHandle, EventIntent } from './types'

const CLOSED_RUN_TTL_MS = 30_000

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
  }

  function applyIntents(intents: EventIntent[], _event: ClassifiedEvent): void {
    pruneClosedRuns()

    for (const intent of intents) {
      switch (intent.kind) {
        case 'queueLivePatch':
          deps.queueLivePatch(intent.agentId, intent.patch)
          break

        case 'clearPendingLivePatch':
          deps.clearPendingLivePatch(intent.agentId)
          break

        case 'commitChat': {
          deps.clearPendingLivePatch(intent.agentId)
          if (intent.outputLines.length > 0) {
            deps.appendOutputLines(intent.agentId, intent.outputLines)
          }
          deps.dispatchIntent(intent)
          // Mark the current run as closed so stale lifecycle events are ignored
          const commitRunId = deps.getAgentRunId(intent.agentId)
          if (commitRunId) {
            closedRuns.set(commitRunId, Date.now() + CLOSED_RUN_TTL_MS)
          }
          break
        }

        case 'updateAgentStatus': {
          // Skip stale terminal updates for runs that already closed
          if (intent.patch.status !== 'running') {
            const currentRunId = deps.getAgentRunId(intent.agentId)
            if (currentRunId && closedRuns.has(currentRunId)) {
              deps.log?.debug(
                { kind: intent.kind, agentId: intent.agentId },
                'skipping stale terminal updateAgentStatus',
              )
              break
            }
          }
          deps.dispatchIntent(intent)
          // Mark run as closed on terminal status
          if (intent.patch.runId === null && intent.patch.status !== 'running') {
            const agentRunId = deps.getAgentRunId(intent.agentId)
            if (agentRunId) {
              closedRuns.set(agentRunId, Date.now() + CLOSED_RUN_TTL_MS)
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
