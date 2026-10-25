import type { EventFrame } from '@clawboo/gateway-client'
import {
  createAsyncQueue,
  type Capabilities,
  type HealthResult,
  type RunHandle,
  type RuntimeAdapter,
  type RuntimeEvent,
  type StartOpts,
  type SteerOptions,
  type SteerResult,
  type TaskHandle,
} from '@clawboo/executor'

import { mapFrameToRuntimeEvents, type MapContext } from './mapFrame'
import type { OpenClawGatewayClient } from './types'

const SESSION_KEY_RE = /^agent:([^:]+):/
/** OpenClaw sessionKeys are `agent:<agentId>:<session>`; recover the agentId. */
const agentIdFromSessionKey = (sessionKey: string): string =>
  sessionKey.match(SESSION_KEY_RE)?.[1] ?? sessionKey

const payloadRecord = (frame: EventFrame): Record<string, unknown> | null =>
  frame.payload && typeof frame.payload === 'object'
    ? (frame.payload as Record<string, unknown>)
    : null

const sessionKeyOf = (frame: EventFrame): string | undefined => {
  const p = payloadRecord(frame)
  return p && typeof p['sessionKey'] === 'string' ? p['sessionKey'] : undefined
}

const runIdOf = (frame: EventFrame): string | undefined => {
  const p = payloadRecord(frame)
  return p && typeof p['runId'] === 'string' ? p['runId'] : undefined
}

const HEALTH_TIMEOUT_MS = 2000

// ─── Steering ────────────────────────────────────────────────────────────────
//
// A steer is a `chat.send` with `queueMode: 'steer'`: the Gateway puts it into the
// session's ACTIVE run at the next runtime boundary (a tool launch or a model call)
// without stopping anything. Verified against OpenClaw 2026.9.2's chat.send handler.
// Two of its behaviors shape everything below:
//
//  1. An ACCEPTED steer is closed out with a `chat` FINAL frame carrying the
//     steer's own runId (its idempotencyKey), once the runtime has committed the
//     message to the transcript. Read as the run's final, that frame would end a
//     run that is still working. So a steer's runId is remembered, and every
//     frame carrying it is kept out of the run's event stream.
//  2. A steer the active run could NOT take is not dropped: it becomes a FOLLOW-UP
//     turn queued behind the run. Nothing would observe that turn, so when the
//     run ends with a steer still unread it is cancelled (`chat.abort` by its
//     runId cancels a queued turn) and reported as not delivered; the mailbox
//     still holds the message for the agent's next run.

/** How long a steer's runId stays on the filter list after it is issued. */
const STEER_RUN_ID_TTL_MS = 30 * 60_000

/** Run ids that belong to steers, never to a run. Module-level, not per adapter:
 *  each team delivery builds its own adapter, and a stray steer frame must not be
 *  taken for the NEXT run on the session either. */
const steerRunIds = new Set<string>()

function rememberSteerRunId(id: string): void {
  steerRunIds.add(id)
  const timer = setTimeout(() => steerRunIds.delete(id), STEER_RUN_ID_TTL_MS)
  ;(timer as { unref?: () => void }).unref?.()
}

const chatStateOf = (frame: EventFrame): string | undefined => {
  if (frame.event !== 'chat') return undefined
  const p = payloadRecord(frame)
  return p && typeof p['state'] === 'string' ? p['state'] : undefined
}

const chatErrorOf = (frame: EventFrame): string | undefined => {
  const p = payloadRecord(frame)
  return p && typeof p['errorMessage'] === 'string' ? p['errorMessage'] : undefined
}

/** The subset of the chat.send response we inspect. The happy path carries NONE
 *  of these (the runId binds later via the frame stream), so a no-run check can
 *  never false-fire on a normal accept. */
type ChatSendResult = { accepted?: boolean; status?: string } | null | undefined

// Statuses a {ok:true} chat.send can carry that mean "acknowledged but no run
// will stream" (idempotency replay swallowed, agent asleep, deliver:false
// dropped). Keyed on EXPLICIT structured fields only — never message prose.
const NO_RUN_STATUSES = new Set([
  'no-active-run',
  'no_active_run',
  'dropped',
  'rejected',
  'no_session',
])

function isNoRunAck(res: ChatSendResult): boolean {
  if (!res || typeof res !== 'object') return false
  if (res.accepted === false) return true
  return typeof res.status === 'string' && NO_RUN_STATUSES.has(res.status)
}

/**
 * Reference RuntimeAdapter: wraps the OpenClaw Gateway client. `start` delivers
 * a message (`chat.send`), `events` normalizes the Gateway frame stream into
 * RuntimeEvents, `setModel`/`writeContext`/`abort` map onto the Gateway's typed
 * helpers. Zero behavior change to OpenClaw — only the seam is new.
 */
export class OpenClawAdapter implements RuntimeAdapter {
  readonly id = 'openclaw'
  readonly participantKind = 'agent' as const

  /** Sessions with a run this adapter started whose terminal has not been seen. */
  private readonly liveRuns = new Set<string>()
  /** Steers sent into a live run and not yet read, by session: runId -> settle. */
  private readonly pendingSteers = new Map<string, Map<string, (r: SteerResult) => void>>()

  constructor(private readonly client: OpenClawGatewayClient) {}

  capabilities(): Capabilities {
    return {
      streaming: true,
      mcp: false,
      worktrees: false,
      resume: true,
      toolApproval: true,
      // `chat.send` with `queueMode: 'steer'` goes into the active run at its
      // next boundary (see Steering above). `writeContext` is NOT a mid-run
      // channel: it sets an agent file the running session does not re-read.
      steering: 'live',
      models: [],
      // Native-preservation seam: a CONNECTED SUBSTRATE — runs ride the LIVE
      // Gateway session over this adapter's long-lived client; the one-shot
      // runner refuses it by construction. `nativeHome` is deliberately
      // OMITTED: the Gateway owns its own state dir entirely — the host
      // neither provisions nor persists a home for it. Channels (WhatsApp/
      // Telegram/etc.) and the Gateway's own cron are runtime-native: the host
      // never serves a channel and never co-runs the Gateway scheduler.
      runtimeClass: 'connected-substrate',
      nativeSkills: 'preserve',
      nativeMemory: 'preserve',
      nativeChannels: 'gateway',
      nativeScheduler: true,
    }
  }

  async health(): Promise<HealthResult> {
    try {
      await Promise.race([
        this.client.agents.list(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('health check timed out')), HEALTH_TIMEOUT_MS),
        ),
      ])
      return { ok: true }
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) }
    }
  }

  async start(_task: TaskHandle, opts: StartOpts): Promise<RunHandle> {
    const message = opts.context ? `${opts.context}\n\n${opts.message}` : opts.message
    // Mirror the SPA's send shape: `deliver: false` (no external channel echo)
    // + an idempotencyKey. The runId is NOT returned here — it lands on the first
    // streaming frame and is bound by `events()`. A {ok:false} response rejects
    // (handled by the caller); we additionally VERIFY a {ok:true} response did
    // start a run — an "acknowledged but no run" ack (idempotency replay, asleep
    // agent) would otherwise leave events() blocking on frames that never come
    // until the watchdog. Fail fast instead so the caller can release/retry.
    const res = await this.client.call<ChatSendResult>('chat.send', {
      sessionKey: opts.sessionKey,
      message,
      deliver: false,
      idempotencyKey: crypto.randomUUID(),
    })
    if (isNoRunAck(res)) {
      const status = res && typeof res === 'object' && res.status ? ` (status: ${res.status})` : ''
      throw new Error(`chat.send was acknowledged but did not start a run${status}`)
    }
    this.liveRuns.add(opts.sessionKey)
    return { adapterId: this.id, sessionKey: opts.sessionKey, runId: null }
  }

  events(run: RunHandle): AsyncIterable<RuntimeEvent> {
    const queue = createAsyncQueue<RuntimeEvent>({ max: 1000 })
    let seq = 0
    let accumulated = ''
    const nextSeq = () => (seq += 1)

    // Subscribe eagerly (on call, not on first pull) so frames emitted between
    // `events()` and the first `next()` are buffered, not dropped.
    const unsubscribe = this.client.onEvent((frame: EventFrame) => {
      if (sessionKeyOf(frame) !== run.sessionKey) return
      const rid = runIdOf(frame)
      // A steer's own frames (its closing final above all) are not the run's.
      if (rid && steerRunIds.has(rid)) return
      // Late-bind / re-bind the runId from the frame (a new run on the same
      // long-lived session carries a new runId; we track the latest).
      if (rid) run.runId = rid
      const ctx: MapContext = { runId: run.runId, sessionId: run.sessionKey }
      let ended = false
      for (const ev of mapFrameToRuntimeEvents(
        frame,
        ctx,
        nextSeq,
        () => Date.now(),
        accumulated,
      )) {
        if (ev.kind === 'text-delta' && ev.channel !== 'reasoning') accumulated += ev.text
        if (ev.kind === 'done' || (ev.kind === 'error' && ev.fatal)) ended = true
        queue.push(ev)
      }
      if (ended) endRun()
    })
    const endRun = (): void => this.endRun(run.sessionKey)

    return {
      [Symbol.asyncIterator](): AsyncIterator<RuntimeEvent> {
        const inner = queue[Symbol.asyncIterator]()
        return {
          next: () => inner.next(),
          return: () => {
            // The consumer stopped observing: as far as the host is concerned the
            // run is over, so nothing should still be waiting to get into it.
            endRun()
            unsubscribe()
            return inner.return
              ? inner.return()
              : Promise.resolve({ value: undefined as never, done: true })
          },
        }
      },
    }
  }

  async abort(run: RunHandle): Promise<void> {
    // Two-tier teardown: the surgical per-run `chat.abort` when we have a runId,
    // plus the heavier session-level `sessions.abort` backstop ALWAYS — which
    // covers the runId-not-yet-bound race and any queued/pending work.
    const tasks: Promise<unknown>[] = []
    if (run.runId)
      tasks.push(this.client.chat.abort(run.sessionKey, run.runId).catch(() => undefined))
    tasks.push(
      this.client.sessions.abort(run.sessionKey, run.runId ?? undefined).catch(() => undefined),
    )
    await Promise.allSettled(tasks)
  }

  async setModel(run: RunHandle, model: string): Promise<void> {
    await this.client.sessions.patch(run.sessionKey, { model })
  }

  async writeContext(run: RunHandle, key: string, value: string): Promise<void> {
    await this.client.agents.files.set(agentIdFromSessionKey(run.sessionKey), key, value)
  }

  /**
   * Steer the session's active run (see Steering above). Resolves once the
   * outcome is known: delivered when the Gateway reports the message committed to
   * the run, not delivered when the run ended first (the unread steer is then
   * cancelled so it can't start a turn nobody is watching) or the Gateway refused it.
   * A steer here never extends a run (an unread one is cancelled when the run
   * ends), so a passive steer needs no different handling.
   */
  async steer(run: RunHandle, text: string, _opts?: SteerOptions): Promise<SteerResult> {
    const sessionKey = run.sessionKey
    if (!this.liveRuns.has(sessionKey)) return { delivered: false, reason: 'run-ended' }
    const steerRunId = crypto.randomUUID()
    rememberSteerRunId(steerRunId)
    return new Promise<SteerResult>((resolve) => {
      let settled = false
      const off = this.client.onEvent((frame: EventFrame) => {
        if (runIdOf(frame) !== steerRunId) return
        const state = chatStateOf(frame)
        if (state === 'final') settle({ delivered: true, mode: 'live' })
        else if (state === 'aborted') settle({ delivered: false, reason: 'run-ended' })
        else if (state === 'error')
          settle({
            delivered: false,
            reason: 'rejected',
            ...(chatErrorOf(frame) ? { detail: chatErrorOf(frame) } : {}),
          })
      })
      const settle = (result: SteerResult): void => {
        if (settled) return
        settled = true
        off()
        this.pendingSteers.get(sessionKey)?.delete(steerRunId)
        resolve(result)
      }
      let waiting = this.pendingSteers.get(sessionKey)
      if (!waiting) {
        waiting = new Map()
        this.pendingSteers.set(sessionKey, waiting)
      }
      waiting.set(steerRunId, settle)
      this.client
        .call<ChatSendResult>('chat.send', {
          sessionKey,
          message: text,
          deliver: false,
          idempotencyKey: steerRunId,
          queueMode: 'steer',
        })
        .then(
          (res) => {
            if (isNoRunAck(res)) {
              const status = res && typeof res === 'object' && res.status ? res.status : 'no run'
              settle({ delivered: false, reason: 'rejected', detail: status })
            } else if (!this.liveRuns.has(sessionKey)) {
              // The run ended while the send was in flight.
              this.cancelSteer(sessionKey, steerRunId)
              settle({ delivered: false, reason: 'run-ended' })
            }
          },
          (err: unknown) =>
            settle({
              delivered: false,
              reason: 'rejected',
              detail: err instanceof Error ? err.message : String(err),
            }),
        )
    })
  }

  /** The run on this session is over: cancel every steer it never read. */
  private endRun(sessionKey: string): void {
    this.liveRuns.delete(sessionKey)
    const waiting = this.pendingSteers.get(sessionKey)
    if (!waiting) return
    this.pendingSteers.delete(sessionKey)
    for (const [steerRunId, settle] of waiting) {
      this.cancelSteer(sessionKey, steerRunId)
      settle({ delivered: false, reason: 'run-ended' })
    }
  }

  private cancelSteer(sessionKey: string, steerRunId: string): void {
    void this.client.chat.abort(sessionKey, steerRunId).catch(() => undefined)
  }
}
