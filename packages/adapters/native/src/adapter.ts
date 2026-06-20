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

import { mapNativeEvent, nativeFrameId, type MapContext } from './mapNativeEvent'
import type { NativeDriver, NativeDriverFactory, NativeEvent } from './types'

/**
 * Clawboo's native RuntimeAdapter — the fifth peer runtime. Unlike the wrapped
 * one-shot adapters (which re-shape a CLI/SDK process's output), the injected
 * driver here HOSTS the conversation: an in-process turn loop calling provider
 * SDKs directly and consuming clawboo's shared MCP spine. The adapter stays the
 * thin, dependency-light translation layer the contract suite can drive with an
 * in-memory fake; the harness lives in the real server-side driver.
 */
export class NativeAdapter implements RuntimeAdapter {
  readonly id = 'clawboo-native'
  readonly participantKind = 'agent' as const

  private readonly drivers = new Map<string, NativeDriver>()
  /** Native session id captured per run (from init/result frames) — the
   *  resumable handle the `sessionCodec` serializes. A native session resume
   *  reloads the persisted conversation transcript, so this id is a REAL
   *  continuation handle, not just lineage. */
  private readonly sessionIds = new Map<string, string>()

  constructor(
    private readonly driverFactory: NativeDriverFactory,
    private readonly healthCheck: () => Promise<HealthResult> = async () => ({ ok: true }),
  ) {}

  capabilities(): Capabilities {
    return {
      streaming: true,
      mcp: true,
      worktrees: true,
      resume: true,
      toolApproval: true,
      // Routable surface, not an exhaustive list — AgentConfig picks the model;
      // any provider-supported id works.
      models: ['claude-haiku-4-5', 'claude-sonnet-4-6', 'gpt-4o-mini', 'gpt-4o'],
      // Conservative floor across routable providers; drives the proactive
      // session-rotation watermark.
      contextWindowTokens: 200000,
      // Native-preservation seam: clawboo IS this runtime's substrate. Its
      // private plane — persisted conversation transcripts — lives in a stable
      // per-identity home the host materializes, so sessions survive and
      // resume across dispatches. No native skills dir (capabilities ride the
      // shared broker), no channels (the shared spine is the only voice), and
      // never a self-scheduler (the host owns when-to-run).
      runtimeClass: 'native',
      nativeHome: { scope: 'per-identity', persist: true },
      nativeSkills: 'none',
      nativeMemory: 'preserve',
      nativeChannels: 'none',
      nativeScheduler: false,
    }
  }

  /**
   * Serialize/restore the run's native session handle. For the native runtime
   * the session id keys a persisted transcript in the per-identity home, so a
   * same-runtime resume genuinely continues the conversation.
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
    // The runId late-binds in `events()` from the first native frame (the
    // harness's `init` carries the fresh session id).
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

    const unsubscribe = driver.onEvent((native: NativeEvent) => {
      const nid = nativeFrameId(native)
      if (nid) this.sessionIds.set(run.sessionKey, nid)
      if (nid && !run.runId) run.runId = nid
      if (!run.runId) run.runId = run.sessionKey
      const ctx: MapContext = { runId: run.runId, sessionId: run.sessionKey }
      for (const ev of mapNativeEvent(native, ctx, nextSeq, () => Date.now(), accumulated)) {
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
