// OpenClaw runs the board closed in its database with no engine to stop them. Moving
// a deleted room's unfinished task closes its run in the db layer, which has no
// Gateway client. On a room DELETE the engine's Stop has usually aborted the run
// already; at boot, and on a DELETE with no resident engine, nothing has, and the
// run may still be going in the Gateway with nobody reading it.
//
// So the closed runs wait here until the server's operator connection is up, which at
// boot it is not yet, and each session is aborted once. The list is in memory: a
// restart before the Gateway connects loses it, and the next boot does not find that
// run again, because its row is already closed.

import { agents, type ClawbooDb, type ClosedRoomRun } from '@clawboo/db'
import { createLogger } from '@clawboo/logger'
import { buildTeamSessionKey } from '@clawboo/team-orchestration'
import { eq } from 'drizzle-orm'

import { getRegistry } from '../agentSource'

import { isTeamSessionLive } from './teamOrchestrator'

const log = createLogger('gateway-run-aborts')

/**
 * How long a closed run waits for the Gateway. An hour is twice Clawboo's own limits
 * on a run nobody hears from (the 30-minute drain guard, and the Gateway's 30-minute
 * hold on an approval), and a Gateway that first connects later than that has most
 * likely restarted, which ends its runs anyway.
 */
export const GATEWAY_ABORT_GIVE_UP_MS = 60 * 60_000

/** How often the list is looked at while it holds anything. */
const RETRY_MS = 5_000

export interface GatewayRunAbortsDeps {
  /** The live operator connection, or null while the Gateway is not connected. */
  client: () => { sessions: { abort(key: string): Promise<unknown> } } | null
  /** A live engine owns this session, so what runs on it is not the closed run. */
  isLive: (sessionKey: string) => boolean
}

export interface GatewayRunAborts {
  /** Abort these sessions in the Gateway, now or once it is connected. */
  add(sessionKeys: readonly string[]): void
  /** The sessions still waiting. */
  pending(): string[]
}

export function createGatewayRunAborts(deps: GatewayRunAbortsDeps): GatewayRunAborts {
  const waiting = new Map<string, { giveUpAt: number; failed: boolean }>()
  let timer: ReturnType<typeof setInterval> | null = null
  let passing = false

  const pass = async (): Promise<void> => {
    // An abort can take up to the Gateway call's own timeout: one pass at a time.
    if (passing) return
    passing = true
    try {
      for (const [sessionKey, entry] of [...waiting]) {
        if (Date.now() >= entry.giveUpAt) {
          waiting.delete(sessionKey)
          log.warn({ sessionKey }, 'gave up aborting a closed run: the Gateway never took it')
          continue
        }
        const client = deps.client()
        if (!client) continue
        // Asked right before the call, not when the run was queued. Forgotten rather
        // than kept: whatever runs on that session now is not the run that was closed,
        // and an abort takes whatever is running there.
        if (deps.isLive(sessionKey)) {
          waiting.delete(sessionKey)
          log.info({ sessionKey }, 'not aborting a closed run: a live engine owns its session')
          continue
        }
        try {
          // The Gateway answers `no-active-run` for a run that already ended.
          await client.sessions.abort(sessionKey)
          waiting.delete(sessionKey)
          log.info({ sessionKey }, 'aborted a closed run in the Gateway')
        } catch (err) {
          if (!entry.failed) log.warn({ err, sessionKey }, 'aborting a closed run failed; retrying')
          entry.failed = true
        }
      }
    } finally {
      passing = false
      if (waiting.size === 0 && timer) {
        clearInterval(timer)
        timer = null
      }
    }
  }
  const runPass = (): void => {
    pass().catch((err: unknown) => log.error({ err }, 'a pass over closed runs failed'))
  }

  return {
    add(sessionKeys) {
      const giveUpAt = Date.now() + GATEWAY_ABORT_GIVE_UP_MS
      for (const key of sessionKeys)
        if (!waiting.has(key)) waiting.set(key, { giveUpAt, failed: false })
      if (waiting.size === 0) return
      if (!timer) {
        timer = setInterval(runPass, RETRY_MS)
        ;(timer as { unref?: () => void }).unref?.()
      }
      runPass()
    },
    pending: () => [...waiting.keys()],
  }
}

let serverAborts: GatewayRunAborts | null = null

/** The server's own list, over its operator connection and its resident engines. */
function aborts(): GatewayRunAborts {
  serverAborts ??= createGatewayRunAborts({
    client: () => getRegistry().source.operatorClient(),
    isLive: isTeamSessionLive,
  })
  return serverAborts
}

/**
 * Queue what `moveArchivedRoomTasks` closed for an abort in the Gateway. Only an
 * OpenClaw agent's: the team engine labels every run it drives `openclaw`, so the
 * agent's own runtime is what says where it ran. Never throws: it runs in the boot
 * pass and in a route whose move has already landed.
 */
export function queueGatewayAborts(
  db: ClawbooDb,
  runs: readonly ClosedRoomRun[],
  into?: GatewayRunAborts,
): void {
  try {
    const keys: string[] = []
    for (const run of runs) {
      const row = db
        .select({ runtime: agents.runtime })
        .from(agents)
        .where(eq(agents.id, run.agentId))
        .get()
      if (row?.runtime === 'openclaw')
        keys.push(buildTeamSessionKey(run.agentId, run.teamId, run.roomId))
    }
    if (keys.length > 0) (into ?? aborts()).add(keys)
  } catch (err) {
    log.error({ err }, 'could not queue closed runs for an abort in the Gateway')
  }
}
