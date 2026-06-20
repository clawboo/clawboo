// ─── Per-runtime MEMORY_GUIDANCE ─────────────────────────────────────────────
// A short instruction telling a runtime where SHARED team memory lives (clawboo's
// memory tool) versus its own PRIVATE native memory. The shared tier is the one
// place every teammate — across all five runtimes — reads/writes; a runtime's
// native memory (Hermes MEMORY.md, Claude memory:project, the native store) is
// private scratch other teammates cannot see. We name the private store per
// runtime but NEVER tell a runtime to stop using it (Hermes's self-improvement
// Curator feeds on MEMORY.md — disabling it would break the agent).
//
// Lands in the cache-stable instruction context (NOT the volatile per-turn tier),
// alongside the MCP + degradation notes the runner already assembles.

/** The private-memory name a given runtime recognises (best-effort; generic fallback). */
function privateMemoryName(runtimeId: string): string {
  switch (runtimeId) {
    case 'hermes':
      return 'your Hermes `MEMORY.md`'
    case 'claude-code':
      return "Claude Code's `memory:project`"
    case 'clawboo-native':
      return 'your own private memory store'
    case 'codex':
      return 'your own private notes'
    default:
      return 'your own native memory'
  }
}

/**
 * The shared-vs-private memory guidance for a runtime. Returns '' when there is
 * no shared memory surface (no MCP base URL) so nothing misleading is injected.
 */
export function buildMemoryGuidance(runtimeId: string, hasMcp: boolean): string {
  if (!hasMcp) return ''
  const priv = privateMemoryName(runtimeId)
  return (
    'Shared team memory: save durable team/project facts with the clawboo memory tool ' +
    '(`memory_save`) — that is the one place every teammate, across all runtimes, can read them. ' +
    `${priv} is private scratch for your own cognition only; teammates cannot see it, so never rely ` +
    'on it for anything the team needs.'
  )
}
