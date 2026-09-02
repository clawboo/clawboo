// The most recent screenshot each agent took, held in memory for the UI.
//
// IN MEMORY ON PURPOSE. The obvious alternative is the obs event log, and it is
// the wrong home: that table is append-only with no delete writer, so putting
// megabytes of base64 in it would grow the database forever with data whose
// whole value expires in seconds. This is the same posture as `chatDeltaBus`
// and `agentStatusBus` — live run state, meaningless after a restart.
//
// LAST ONE WINS, per agent. A browser panel answers "what is it looking at
// now", so a history would cost memory to serve a question nobody asked. That
// also bounds the whole store at one frame per agent that has ever run in this
// process lifetime.

/** One captured frame. `data` is base64 with no `data:` prefix. */
export interface AgentScreenshot {
  data: string
  mimeType: string
  /** The tool that produced it, so the panel can attribute what it shows. */
  toolName: string
  ts: number
}

const latest = new Map<string, AgentScreenshot>()

/**
 * Bound on total retained bytes across every agent.
 *
 * One frame per agent is already a small number, but an agent fleet plus
 * full-page screenshots is not free, and this process also serves every
 * dashboard read. Evicting the OLDEST frame keeps whoever is currently working
 * visible, which is the only thing the panel is for.
 */
const MAX_TOTAL_B64_BYTES = 24 * 1024 * 1024

function totalBytes(): number {
  let n = 0
  for (const shot of latest.values()) n += shot.data.length
  return n
}

/** Record the newest frame for `agentId`, replacing any previous one. */
export function putScreenshot(
  agentId: string,
  shot: Omit<AgentScreenshot, 'ts'> & { ts?: number },
): void {
  if (!agentId || !shot.data) return
  latest.set(agentId, {
    data: shot.data,
    mimeType: shot.mimeType,
    toolName: shot.toolName,
    ts: shot.ts ?? Date.now(),
  })
  while (totalBytes() > MAX_TOTAL_B64_BYTES && latest.size > 1) {
    let oldestId: string | null = null
    let oldestTs = Infinity
    for (const [id, s] of latest) {
      if (s.ts < oldestTs) {
        oldestTs = s.ts
        oldestId = id
      }
    }
    if (!oldestId) break
    latest.delete(oldestId)
  }
}

/** The newest frame for `agentId`, or null if it has taken none this lifetime. */
export function getScreenshot(agentId: string): AgentScreenshot | null {
  return latest.get(agentId) ?? null
}

/** Test seam. Never called in production — the store is process-lifetime state. */
export function resetScreenshots(): void {
  latest.clear()
}
