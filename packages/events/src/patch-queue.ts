// ─── Live patch queue: batch rapid updates, flush on animation frame ──────────

export interface Patch {
  agentId: string
  updates: Record<string, unknown>
}

type PatchQueueEntry = {
  pending: Map<string, Record<string, unknown>>
  rafId: ReturnType<typeof requestAnimationFrame> | null
}

/**
 * Creates a patch queue that batches rapid updates per agent and flushes on
 * the next animation frame (or via explicit flush()).
 *
 * @param onFlush Called with all accumulated patches when the queue flushes.
 */
export function createPatchQueue(onFlush: (patches: Patch[]) => void): {
  enqueue: (patch: Patch) => void
  flush: () => void
} {
  const state: PatchQueueEntry = { pending: new Map(), rafId: null }

  const flush = (): void => {
    if (state.rafId !== null) {
      // cancelAnimationFrame is browser-only; guard for SSR
      if (typeof cancelAnimationFrame !== 'undefined') cancelAnimationFrame(state.rafId)
      state.rafId = null
    }
    if (state.pending.size === 0) return
    const patches: Patch[] = []
    for (const [agentId, updates] of state.pending) {
      patches.push({ agentId, updates })
    }
    state.pending.clear()
    onFlush(patches)
  }

  const enqueue = (patch: Patch): void => {
    const existing = state.pending.get(patch.agentId)
    if (existing) {
      // Merge: incoming run ID change discards old streaming state
      const existingRunId = typeof existing['runId'] === 'string' ? existing['runId'] : ''
      const incomingRunId = typeof patch.updates['runId'] === 'string' ? patch.updates['runId'] : ''
      if (incomingRunId && existingRunId && incomingRunId !== existingRunId) {
        state.pending.set(patch.agentId, { ...patch.updates })
      } else {
        state.pending.set(patch.agentId, { ...existing, ...patch.updates })
      }
    } else {
      state.pending.set(patch.agentId, { ...patch.updates })
    }

    // Schedule flush on next animation frame (browser only)
    if (state.rafId === null && typeof requestAnimationFrame !== 'undefined') {
      state.rafId = requestAnimationFrame(() => {
        state.rafId = null
        flush()
      })
    }
  }

  return { enqueue, flush }
}
