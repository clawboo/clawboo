import type { ClassifiedEvent, EventHandlerDeps, EventHandlerHandle, EventIntent } from './types'

const CLOSED_RUN_TTL_MS = 30_000
const CLOSED_RUNS_MAX_SIZE = 500

// ── createEventHandler ─────────────────────────────────────────────────────

export function createEventHandler(deps: EventHandlerDeps): EventHandlerHandle {
  let summaryRefreshTimer: ReturnType<typeof setTimeout> | null = null
  // runId → why and when it closed; guards against stale terminal events.
  //
  // `byCommit` IS LOAD-BEARING. A run closed by its own commit has said
  // everything it is going to say, so a second final for it is a replay and is
  // dropped. A run closed by a LIFECYCLE terminal has not: OpenClaw emits its
  // `agent` end frame BEFORE the `chat` final, so treating that close as
  // "finished" discarded the reply itself. The whole commitChat branch was
  // skipped, which is why a 1:1 OpenClaw reply rendered as a live card and then
  // vanished with nothing appended and nothing persisted.
  const closedRuns = new Map<string, { expiresAt: number; byCommit: boolean }>()

  function pruneClosedRuns(): void {
    const now = Date.now()
    for (const [runId, entry] of closedRuns) {
      if (now > entry.expiresAt) closedRuns.delete(runId)
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
          // A run that already COMMITTED has said everything, so a second final
          // for it is a replay and is dropped.
          //
          // A run closed only by its LIFECYCLE still owes its final: OpenClaw
          // emits the `agent` end frame before the `chat` final, so treating
          // that close as "finished" discarded the reply itself. Let it through,
          // UNLESS a DIFFERENT run is already live, which means this frame is a
          // stale replay whose terminal patch would flip that live run to idle.
          const closed = intent.runId ? closedRuns.get(intent.runId) : undefined
          const liveRunId = deps.getAgentRunId(intent.agentId)
          if (closed && (closed.byCommit || (liveRunId !== null && liveRunId !== intent.runId))) {
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
          deps.dispatchIntent(intent)
          // KEYED ON THE INCOMING FRAME'S runId, not on a pre/post comparison.
          // Under the real wire order the lifecycle end has ALREADY nulled the
          // fleet runId before this frame arrives, so a pre/post check reads
          // null-to-null, never marks the run, and duplicate-final protection
          // lapses silently: a replayed final would append the reply twice.
          //
          // A runId still live AFTER dispatch means an exec approval deferred
          // the terminal patch, so this commit did not close the run and must
          // not be marked.
          if (intent.runId && deps.getAgentRunId(intent.agentId) === null) {
            closedRuns.set(intent.runId, {
              expiresAt: Date.now() + CLOSED_RUN_TTL_MS,
              byCommit: true,
            })
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
              // NOT `byCommit`: a lifecycle terminal says the run stopped, not
              // that it delivered. Its chat final may still be in flight.
              closedRuns.set(preStatusRunId, {
                expiresAt: Date.now() + CLOSED_RUN_TTL_MS,
                byCommit: false,
              })
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
