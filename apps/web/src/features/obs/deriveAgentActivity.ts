// Per-agent "what it is doing right now", folded from the obs event tail.
//
// The Boo card's activity band reads `pickLatestActivity`, which is sourced
// entirely from the CHAT store (streaming text + transcript). A board run never
// writes to the chat store, so during a board task the band renders an endless
// typing indicator: the Boo looks busy but says nothing.
//
// The obs log already carries the answer. `deriveNowActivity` turns a tool_call
// tail into the current file and command, and every obs row is tagged with the
// agent that produced it — so grouping by `agentId` and reusing that deriver
// gives the same live line the Workspace tab shows, for every agent at once,
// off a stream the app already has open.

import { deriveNowActivity } from '@/features/workspace/deriveNowActivity'

import type { ObsLogEvent } from './useObsStream'

/** Trim a command to something that fits a Boo card without wrapping twice. */
const MAX_COMMAND = 48

function shorten(command: string): string {
  const oneLine = command.replace(/\s+/g, ' ').trim()
  return oneLine.length > MAX_COMMAND ? `${oneLine.slice(0, MAX_COMMAND - 1)}…` : oneLine
}

/** The trailing path segment, which is what identifies the file on a small card. */
function basename(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? p
}

/**
 * One human-readable activity line per agent that has recent tool activity.
 *
 * Whichever of file / command the agent touched MOST RECENTLY wins, so the line
 * tracks what it is doing now rather than always preferring one kind of work.
 * Agents with no tool calls in the window are absent, which lets the caller keep
 * whatever the chat store already had rather than blanking a live chat run.
 */
export function deriveAgentActivity(events: readonly ObsLogEvent[]): Map<string, string> {
  const byAgent = new Map<string, ObsLogEvent[]>()
  for (const e of events) {
    if (!e.agentId) continue
    const bucket = byAgent.get(e.agentId)
    if (bucket) bucket.push(e)
    else byAgent.set(e.agentId, [e])
  }

  const out = new Map<string, string>()
  for (const [agentId, rows] of byAgent) {
    const now = deriveNowActivity(rows)
    const file = now.file
    const command = now.command
    if (!file && !command) continue
    const useCommand = !file || (!!command && command.ts >= file.ts)
    out.set(
      agentId,
      useCommand && command ? shorten(command.command) : `editing ${basename(file?.path ?? '')}`,
    )
  }
  return out
}
