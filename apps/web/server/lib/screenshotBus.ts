// The most recent screenshot each agent took, served from memory, mirrored to
// disk.
//
// NOT THE OBS LOG. That table is append-only with no delete writer, so megabytes
// of base64 in it would grow the database forever with data whose whole value
// expires in seconds. Reads stay in memory for the same reason they always did.
//
// But memory alone MEANT LOSING THEM. Every restart wiped every frame, so the
// panel said "Nothing captured yet" for a Boo that had browsed all afternoon,
// and the only way back was to make it browse again. `screenshotFrames` keeps a
// cache beside the database so a restart resumes with what the fleet last saw;
// it is a mirror, never a source, and a disk that will not take a write leaves
// the in-memory behaviour exactly as it was.
//
// LAST ONE WINS, per agent. A browser panel answers "what is it looking at
// now", so a history would cost memory to serve a question nobody asked. That
// also bounds the whole store at one frame per agent that has ever run.

import { forgetFrame, loadFrames, persistFrame } from './screenshotFrames'

/** One captured frame. `data` is base64 with no `data:` prefix. */
export interface AgentScreenshot {
  data: string
  mimeType: string
  /** The tool that produced it, so the panel can attribute what it shows. */
  toolName: string
  ts: number
  /**
   * Came back from disk rather than from a tool call in this process.
   *
   * The panel needs this to tell the truth about what it is showing. A restored
   * frame can be hours old, and presenting it identically to a live one would
   * have the browser view assert that an idle Boo is looking at a page it
   * closed before lunch.
   */
  restored?: boolean
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
  const record: AgentScreenshot = {
    data: shot.data,
    mimeType: shot.mimeType,
    toolName: shot.toolName,
    ts: shot.ts ?? Date.now(),
  }
  latest.set(agentId, record)
  persistFrame(agentId, record)
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
    // Evicted from memory is evicted from disk. Leaving it would have the next
    // boot restore a frame this process had already decided it could not afford.
    forgetFrame(oldestId)
  }
}

/**
 * Load the on-disk cache into memory. Called once at boot, before anything
 * serves a read.
 *
 * Newest first, and stops at the same byte budget a running process would: a
 * cache grown under a larger budget must not be able to blow past the current
 * one just because it arrived all at once. Returns how many were restored.
 */
export function restoreScreenshots(): number {
  let restored = 0
  for (const frame of loadFrames()) {
    if (latest.has(frame.agentId)) continue
    if (totalBytes() + frame.data.length > MAX_TOTAL_B64_BYTES && latest.size > 0) break
    latest.set(frame.agentId, {
      data: frame.data,
      mimeType: frame.mimeType,
      toolName: frame.toolName,
      ts: frame.ts,
      restored: true,
    })
    restored += 1
  }
  return restored
}

/** The newest frame for `agentId`, or null if it has taken none this lifetime. */
export function getScreenshot(agentId: string): AgentScreenshot | null {
  return latest.get(agentId) ?? null
}

/** Test seam. Never called in production — the store is process-lifetime state. */
export function resetScreenshots(): void {
  latest.clear()
}
