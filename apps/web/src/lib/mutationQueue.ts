// ─── Per-agent mutation queue ─────────────────────────────────────────────────
// Serialises writes to agents.files.set() so concurrent callers (personality
// sliders, skill installs, routing writes) cannot race.  Only the *latest*
// queued mutation runs — intermediate ones are dropped because for file writes
// only the most recent value matters.

type MutationFn = () => Promise<void>

interface QueueEntry {
  running: boolean
  latest: MutationFn | null
}

class AgentMutationQueue {
  private queues = new Map<string, QueueEntry>()

  async enqueue(agentId: string, mutation: MutationFn): Promise<void> {
    let entry = this.queues.get(agentId)
    if (!entry) {
      entry = { running: false, latest: null }
      this.queues.set(agentId, entry)
    }

    if (entry.running) {
      // Replace any previously queued mutation with the latest one
      // (for file writes, only the most recent value matters)
      entry.latest = mutation
      return
    }

    entry.running = true
    try {
      await mutation()
    } finally {
      entry.running = false
      // If a newer mutation was queued while we were running, execute it now
      const next = entry.latest
      if (next) {
        entry.latest = null
        await this.enqueue(agentId, next)
      }
    }
  }
}

export const mutationQueue = new AgentMutationQueue()
