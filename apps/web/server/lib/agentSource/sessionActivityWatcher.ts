// What a Boo does when nobody asked it to.
//
// THE GAP. clawboo's activity feed is complete for its own agents and for
// OpenClaw runs that clawboo itself started. Everything else an OpenClaw agent
// does — a cron job it owns, an incoming WhatsApp or Telegram message, someone
// typing at OpenClaw's own terminal — was invisible. Not thin: absent. Two real
// CLI runs on this machine produced zero rows.
//
// The cause is that the `chat` and `agent` streams are addressed to the
// connection that STARTED a run. Nobody starts these, so nobody is addressed.
// The obvious-looking fix, `session.tool` over `sessions.subscribe`, is gated on
// `isControlUiVisible`, and executing that predicate against every channel value
// returns true for exactly one of them, "webchat" — so it is switched off for
// precisely the runs this exists to see. Building on it would have shipped a
// feature that looked correct and reported nothing.
//
// `session.message` is the channel that works, because it fires on TRANSCRIPT
// COMMIT rather than on who is watching. It carries the row in full: tool calls
// with their arguments, results with their error flag, and real token usage.
//
// ONE SUBSCRIPTION, NOT ONE PER SESSION. `session.message` fans out to every
// connection that has called `sessions.subscribe`, with no per-key registration
// and no agentId — unlike `sessions.messages.subscribe`, which refuses a bare key
// on a multi-agent Gateway. So the whole feature is one call plus a frame handler.

import { mapFrameToRuntimeEvents } from '@clawboo/adapter-openclaw'
import { parseSessionMessagePayload } from '@clawboo/events'
import type { EventFrame } from '@clawboo/gateway-client'
import { createLogger } from '@clawboo/logger'

import { costRecords } from '@clawboo/db'
import { extractText } from '@clawboo/protocol'
import { isTeamSessionKey } from '@clawboo/team-orchestration'

import { calculateCostUsd } from '../costUtils'
import { getDb } from '../db'
import { emitEvent } from '../obs/emit'
import { markToolCallLogged } from './loggedToolCalls'
import { persistDirectChatEntry } from './persistDirectChatEntry'
import { SessionTokenSpend, type TurnSpend } from './sessionTokenSpend'

const log = createLogger('session-activity')

/** Enough to cover a fleet; a session key maps to exactly one agent. */
const MAX_SESSION_KEYS = 500

export interface SessionActivitySource {
  operatorCall<T>(method: string, params?: unknown): Promise<T>
  onGatewayBroadcast(cb: (frame: { event: string; payload?: unknown }) => void): () => void
  onConnectionChange(cb: (c: string) => void): () => void
}

/** Resolve an OpenClaw agent id to the clawboo row id the feed is keyed on. */
export type ResolveAgentId = (sourceAgentId: string) => string | null

/** The last token spend already recorded for an agent, so a restart does not re-bill it. */
export type LastRecordedSpend = (agentId: string) => TurnSpend | null

/**
 * The OpenClaw agent id inside a session key.
 *
 * `agent:<sourceAgentId>:<mainKey>` where mainKey may itself contain colons
 * (`team:<uuid>`, `dashboard:<uuid>`), so this takes the first two segments only.
 */
function sourceAgentIdFromSessionKey(sessionKey: string): string | null {
  const parts = sessionKey.split(':')
  if (parts.length < 3 || parts[0] !== 'agent') return null
  return parts[1] || null
}

export interface SessionActivityWatcher {
  stop(): void
  /** False when the Gateway is down or the subscribe was refused. A silent
   *  no-delivery is this feature's main failure mode, so it is worth being able
   *  to ask rather than infer from an empty feed. */
  isSubscribed(): boolean
}

/**
 * Watch every session's committed transcript rows and log the tool activity.
 *
 * `resolveAgentId` is injected rather than looked up here so the watcher stays
 * testable without a database, and so the caller owns the one subtlety worth
 * owning: the session key carries OpenClaw's agent id, while the feed is keyed on
 * clawboo's row id. They are equal on every row today, which means getting it
 * wrong passes every test that can be written now and misattributes the first
 * time an agent is renamed or re-imported.
 */
export function startSessionActivityWatcher(
  source: SessionActivitySource,
  resolveAgentId: ResolveAgentId,
  lastRecordedSpend?: LastRecordedSpend,
): SessionActivityWatcher {
  /** sessionKey -> clawboo agent id, learned from frames so no lookup is needed per row. */
  const agentBySession = new Map<string, string>()
  const spend = new SessionTokenSpend()
  /** Sessions whose already-recorded spend has been loaded once. */
  const seeded = new Set<string>()
  let subscribed = false

  const remember = (sessionKey: string, agentId: string): void => {
    if (agentBySession.size >= MAX_SESSION_KEYS) {
      const oldest = agentBySession.keys().next().value
      if (oldest !== undefined) agentBySession.delete(oldest)
    }
    agentBySession.set(sessionKey, agentId)
  }

  const resolve = (sessionKey: string): string | null => {
    const known = agentBySession.get(sessionKey)
    if (known) return known
    const sourceId = sourceAgentIdFromSessionKey(sessionKey)
    if (!sourceId) return null
    const agentId = resolveAgentId(sourceId)
    if (agentId) remember(sessionKey, agentId)
    return agentId
  }

  const subscribe = (): void => {
    // RE-SUBSCRIBED ON EVERY CONNECT, not once at boot. The Gateway keys a
    // subscription to the connection that asked, so it dies with the socket and
    // raises no error on either side. A watcher that subscribed once would look
    // correct on day one and be silently deaf after the first reconnect, which is
    // the single most likely way to ship this broken.
    void source
      .operatorCall('sessions.subscribe', {})
      .then(() => {
        subscribed = true
        log.info('subscribed to session activity')
      })
      .catch((err: unknown) => {
        subscribed = false
        log.warn({ err }, 'could not subscribe to session activity')
      })
  }

  const offConnection = source.onConnectionChange((c) => {
    if (c === 'connected') subscribe()
    else subscribed = false
  })

  const offBroadcast = source.onGatewayBroadcast((frame) => {
    try {
      // Run starts are free on this same subscription and are how a session key
      // becomes known without enumerating an unbounded key space.
      if (frame.event === 'sessions.changed') {
        const p = frame.payload as Record<string, unknown> | undefined
        const sessionKey = typeof p?.['sessionKey'] === 'string' ? p['sessionKey'] : ''
        const sourceId = typeof p?.['agentId'] === 'string' ? p['agentId'] : ''
        if (sessionKey && sourceId) {
          const agentId = resolveAgentId(sourceId)
          if (agentId) remember(sessionKey, agentId)
        }
        return
      }

      if (frame.event !== 'session.message') return
      const payload = parseSessionMessagePayload(frame.payload)
      if (!payload) return
      const agentId = resolve(payload.sessionKey)
      // FAILS CLOSED. An unresolvable session is dropped rather than logged under
      // a guess: a row filed against the wrong agent is worse than a missing row,
      // because the feed is what an operator trusts to say what an agent did.
      if (!agentId) return

      // ── Real money ──────────────────────────────────────────────────────
      //
      // The same frame that carries the tool activity carries the session's
      // token snapshot, so cost costs nothing extra to collect. Only a turn
      // whose numbers CHANGED is billed: several messages land per turn and all
      // of them carry the same snapshot, so writing on every frame would charge
      // one request once per message.
      // SEED BEFORE THE FIRST BILL. A restart leaves the tracker empty, so the
      // first frame of every live conversation looks like a brand new turn and
      // gets charged a second time. Loading what is already recorded turns a
      // restart mid-conversation into a resume instead of a repeat, and it is the
      // only way this design can over-count.
      if (!seeded.has(payload.sessionKey)) {
        seeded.add(payload.sessionKey)
        const prior = lastRecordedSpend?.(agentId) ?? null
        if (prior) spend.seed(payload.sessionKey, prior)
      }

      const turn = spend.take(payload.sessionKey, payload)
      if (turn) {
        try {
          getDb()
            .insert(costRecords)
            .values({
              agentId,
              model: turn.model,
              inputTokens: turn.inputTokens,
              outputTokens: turn.outputTokens,
              costUsd: calculateCostUsd(turn.model, turn.inputTokens, turn.outputTokens),
              runId: payload.runId ?? null,
              createdAt: Date.now(),
            })
            .run()
        } catch (err) {
          // Cost is a report, never a reason to lose the activity row below it.
          log.debug({ err }, 'could not record token spend')
        }
      }

      // ── The conversation itself ─────────────────────────────────────────
      //
      // Written HERE rather than in the browser, which only recorded it while a
      // tab happened to be open: close the tab and the conversation happened and
      // was never saved. Team sessions are skipped because the server already
      // owns them (`persistTeamChatEntry`), and writing them again would
      // reintroduce the duplicate that move was made to fix.
      if (!isTeamSessionKey(payload.sessionKey)) {
        const text = extractText(payload.message)
        if (text) {
          persistDirectChatEntry(getDb(), {
            sessionKey: payload.sessionKey,
            text,
            messageId: payload.messageId,
            messageSeq: payload.messageSeq,
            runId: payload.runId,
          })
        }
      }

      // A per-frame sequence is enough: these events are written straight to the
      // log, never ordered against another frame's.
      let seq = 0
      const events = mapFrameToRuntimeEvents(
        { event: 'session.message', payload: frame.payload } as EventFrame,
        { runId: payload.runId ?? null, sessionId: payload.sessionKey },
        () => seq++,
      )

      for (const ev of events) {
        if (ev.kind === 'tool-call') {
          // Skip what clawboo's own runner already logged off the chat stream.
          // Both writers see a run clawboo started, so without this every ordinary
          // tool call would appear twice and read as the agent running it twice.
          if (!markToolCallLogged(ev.toolCallId)) continue
          emitEvent(getDb(), {
            kind: 'tool_call',
            agentId,
            runtime: 'openclaw',
            data: { toolCallId: ev.toolCallId, name: ev.name, input: ev.input },
          })
        } else if (ev.kind === 'tool-result') {
          if (!markToolCallLogged(`${ev.toolCallId}:result`)) continue
          emitEvent(getDb(), {
            kind: 'tool_result',
            agentId,
            runtime: 'openclaw',
            data: {
              toolCallId: ev.toolCallId,
              name: ev.name,
              output: ev.output,
              isError: ev.isError,
            },
          })
        }
      }
    } catch (err) {
      // Never let a malformed frame break the fan-out for every other listener.
      log.debug({ err }, 'session activity frame dropped')
    }
  })

  return {
    isSubscribed: () => subscribed,
    stop(): void {
      offConnection()
      offBroadcast()
      subscribed = false
    },
  }
}
