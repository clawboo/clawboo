// The board's in-process lifecycle BUS — the push plane the coordination
// overhaul was missing. The obs `orchestration_events` table is the durable
// LOG (replay, projections); this bus is the live NOTIFICATION: every board
// mutation that goes through the repository fires here, post-commit, so a
// subsystem learns about work the moment it changes instead of whenever it
// happens to poll. One door: the team-chat engine, the executor runner, MCP
// tool mutations, routines, sweeps and REST handlers all write through the
// repository, so none of them can mutate the board silently.
//
// In-process by design (clawboo is one process over one SQLite file): with no
// subscribers a publish is a no-op, and a listener error is isolated so it can
// never break the write path that triggered it. Anything that must SURVIVE the
// process (agent-bound notifications) is not a bus concern — that's the durable
// `agent_inbox` mailbox, whose rows a subscriber writes.

export type BoardLifecycleEvent =
  | {
      kind: 'task_created'
      taskId: string
      teamId: string | null
      sourceDelegationId: string | null
    }
  | { kind: 'task_claimed'; taskId: string; teamId: string | null; assigneeAgentId: string }
  | { kind: 'status_changed'; taskId: string; teamId: string | null; status: string }
  | {
      kind: 'task_released'
      taskId: string
      teamId: string | null
      via: 'release' | 'sweep' | 'orphan-reap'
    }
  | {
      kind: 'comment_added'
      taskId: string
      teamId: string | null
      authorType: string
      authorAgentId: string | null
    }
  | {
      kind: 'execution_completed'
      taskId: string
      teamId: string | null
      execId: string
      status: string
      /** The run's executor ('openclaw' = an engine-owned fire whose reflection
       *  the engine itself delivers; anything else = the executor runner). */
      executorType: string
    }

type Listener = (ev: BoardLifecycleEvent) => void

const listeners = new Set<Listener>()

/** Subscribe to every board lifecycle event. Returns an idempotent unsubscribe. */
export function onBoardLifecycle(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Publish post-commit. Never throws — a faulty listener is isolated so it can
 *  never break the board write that triggered it. No subscribers ⇒ no-op. */
export function emitBoardLifecycle(ev: BoardLifecycleEvent): void {
  for (const l of listeners) {
    try {
      l(ev)
    } catch {
      // Isolated: the write path must never fail because a subscriber did.
    }
  }
}

/** Test helper: drop every subscriber (suite isolation). */
export function resetBoardLifecycleListeners(): void {
  listeners.clear()
}
