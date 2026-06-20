import type { EventFrame } from '@clawboo/gateway-client'
import {
  createAsyncQueue,
  type Capabilities,
  type HealthResult,
  type RunHandle,
  type RuntimeAdapter,
  type RuntimeEvent,
  type StartOpts,
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

  constructor(private readonly client: OpenClawGatewayClient) {}

  capabilities(): Capabilities {
    return {
      streaming: true,
      mcp: false,
      worktrees: false,
      resume: true,
      toolApproval: true,
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
      // Late-bind / re-bind the runId from the frame (a new run on the same
      // long-lived session carries a new runId; we track the latest).
      const rid = runIdOf(frame)
      if (rid) run.runId = rid
      const ctx: MapContext = { runId: run.runId, sessionId: run.sessionKey }
      for (const ev of mapFrameToRuntimeEvents(
        frame,
        ctx,
        nextSeq,
        () => Date.now(),
        accumulated,
      )) {
        if (ev.kind === 'text-delta' && ev.channel !== 'reasoning') accumulated += ev.text
        queue.push(ev)
      }
    })

    return {
      [Symbol.asyncIterator](): AsyncIterator<RuntimeEvent> {
        const inner = queue[Symbol.asyncIterator]()
        return {
          next: () => inner.next(),
          return: () => {
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
}
