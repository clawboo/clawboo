import {
  createAsyncQueue,
  type Capabilities,
  type HealthResult,
  type RunHandle,
  type RuntimeAdapter,
  type RuntimeEvent,
  type SessionCodec,
  type StartOpts,
  type TaskHandle,
} from '@clawboo/executor'

import { claudeNativeId, mapClaudeEvent, type MapContext } from './mapClaudeEvent'
import type { ClaudeCodeDriver, ClaudeCodeDriverFactory, ClaudeNativeEvent } from './types'

/**
 * Claude Code RuntimeAdapter. Generalizes the OpenClaw reference pattern to a
 * spawned/SDK-backed runtime: instead of one long-lived injected client, a fresh
 * `ClaudeCodeDriver` is minted per run via the injected `driverFactory`. `start`
 * boots the run; `events` subscribes to the driver's native stream and maps each
 * frame into the normalized `RuntimeEvent` union; `abort`/`setModel`/`writeContext`
 * delegate to the run's driver. Heavy SDK/spawn logic lives in the real driver
 * (server-side) — this package stays dependency-light and contract-testable
 * against an in-memory fake driver.
 */
export class ClaudeCodeAdapter implements RuntimeAdapter {
  readonly id = 'claude-code'
  readonly participantKind = 'agent' as const

  private readonly drivers = new Map<string, ClaudeCodeDriver>()
  /** Native Claude session id captured per run (from init/result frames) — the
   *  resumable handle the `sessionCodec` serializes for rotation lineage. */
  private readonly sessionIds = new Map<string, string>()

  constructor(
    private readonly driverFactory: ClaudeCodeDriverFactory,
    private readonly healthCheck: () => Promise<HealthResult> = async () => ({ ok: true }),
  ) {}

  capabilities(): Capabilities {
    return {
      streaming: true,
      mcp: true,
      worktrees: true,
      resume: true,
      toolApproval: true,
      models: ['sonnet', 'opus', 'haiku'],
      // Claude (Sonnet/Opus) ships a 200k-token context window — drives the
      // proactive session-rotation watermark.
      contextWindowTokens: 200000,
      // Native-preservation seam: a stateless wrapped one-shot — the cognition
      // is the model; no durable cross-run self-improvement substrate exists to
      // preserve. `nativeHome` is OMITTED: the SDK runs against the user's real
      // HOME/Keychain auth; the host provisions no home and nothing native
      // accrues per identity.
      runtimeClass: 'wrapped-oneshot',
      nativeSkills: 'none',
      nativeMemory: 'none',
      nativeChannels: 'none',
      nativeScheduler: false,
    }
  }

  /**
   * Serialize/restore the run's native session handle. Rotation deliberately does
   * NOT replay the heavy transcript (continuity rides the handoff note) — the codec captures the session id for lineage + optional resume.
   */
  readonly sessionCodec: SessionCodec = {
    serialize: async (run: RunHandle): Promise<string> =>
      JSON.stringify({
        sessionKey: run.sessionKey,
        sessionId: this.sessionIds.get(run.sessionKey) ?? run.runId ?? null,
      }),
    restore: async (blob: string): Promise<RunHandle> => {
      const parsed = JSON.parse(blob) as { sessionKey?: string; sessionId?: string | null }
      return {
        adapterId: this.id,
        sessionKey: parsed.sessionKey ?? '',
        runId: parsed.sessionId ?? null,
      }
    },
  }

  async health(): Promise<HealthResult> {
    try {
      return await Promise.race([
        this.healthCheck(),
        new Promise<HealthResult>((resolve) =>
          setTimeout(() => resolve({ ok: false, message: 'health check timed out' }), 2000),
        ),
      ])
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) }
    }
  }

  async start(_task: TaskHandle, opts: StartOpts): Promise<RunHandle> {
    const driver = this.driverFactory(opts)
    this.drivers.set(opts.sessionKey, driver)
    await driver.start()
    // The runId is not known yet — it late-binds in `events()` from the first
    // native frame (Claude Code's `init` carries the session id).
    return { adapterId: this.id, sessionKey: opts.sessionKey, runId: null }
  }

  events(run: RunHandle): AsyncIterable<RuntimeEvent> {
    const driver = this.drivers.get(run.sessionKey)
    const queue = createAsyncQueue<RuntimeEvent>({ max: 1000 })
    let seq = 0
    let accumulated = ''
    const nextSeq = () => (seq += 1)

    if (!driver) {
      queue.close()
      return queue
    }

    const unsubscribe = driver.onEvent((native: ClaudeNativeEvent) => {
      // Late-bind the runId from the first frame that carries a native id;
      // otherwise fall back to the sessionKey so the event base is always stable.
      const nid = claudeNativeId(native)
      if (nid) this.sessionIds.set(run.sessionKey, nid)
      if (nid && !run.runId) run.runId = nid
      if (!run.runId) run.runId = run.sessionKey
      const ctx: MapContext = { runId: run.runId, sessionId: run.sessionKey }
      for (const ev of mapClaudeEvent(native, ctx, nextSeq, () => Date.now(), accumulated)) {
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
    await this.drivers.get(run.sessionKey)?.abort()
  }

  async setModel(run: RunHandle, model: string): Promise<void> {
    await this.drivers.get(run.sessionKey)?.setModel(model)
  }

  async writeContext(run: RunHandle, key: string, value: string): Promise<void> {
    await this.drivers.get(run.sessionKey)?.writeContext(key, value)
  }
}
