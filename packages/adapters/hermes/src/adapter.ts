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

import { hermesNativeId, mapHermesEvent, type MapContext } from './mapHermesEvent'
import type { HermesDriver, HermesDriverFactory, HermesNativeEvent } from './types'

/**
 * Hermes RuntimeAdapter. Same trait surface as the Claude Code / Codex adapters,
 * driving the Hermes CLI headless. The only capability difference is
 * `streaming: false` (Hermes has no live token stream — the driver derives
 * structured lifecycle events from its run output + state.db). Hermes is a
 * single-task worker on clawboo's one board of record; clawboo never syncs
 * Hermes's internal kanban.
 */
export class HermesAdapter implements RuntimeAdapter {
  readonly id = 'hermes'
  readonly participantKind = 'agent' as const

  private readonly drivers = new Map<string, HermesDriver>()
  /** Native Hermes session id captured per run (from session/result frames) —
   *  the resumable handle the `sessionCodec` serializes for `--resume`. */
  private readonly sessionIds = new Map<string, string>()

  constructor(
    private readonly driverFactory: HermesDriverFactory,
    private readonly healthCheck: () => Promise<HealthResult> = async () => ({ ok: true }),
  ) {}

  capabilities(): Capabilities {
    return {
      streaming: false,
      mcp: true,
      worktrees: true,
      resume: true,
      toolApproval: true,
      models: [], // provider-defined — Hermes resolves models via its own provider config
      // Native-preservation seam: a wrapped one-shot whose value COMPOUNDS in
      // its home — one stable home per identity; self-created skills, MEMORY.md
      // and state.db accrue there across runs (the Hermes self-improvement
      // loop). nativeScheduler is informational: Hermes ships its own cron/
      // heartbeat, which the host deliberately does not co-run for teammates.
      runtimeClass: 'wrapped-oneshot',
      nativeHome: { scope: 'per-identity', persist: true },
      nativeSkills: 'preserve',
      nativeMemory: 'preserve',
      nativeChannels: 'none',
      nativeScheduler: true,
    }
  }

  /**
   * Serialize/restore the run's native session handle. Rotation deliberately
   * does NOT replay the heavy transcript (continuity rides the handoff note) —
   * the codec captures the session id for lineage + same-runtime `--resume`.
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

    const unsubscribe = driver.onEvent((native: HermesNativeEvent) => {
      const nid = hermesNativeId(native)
      if (nid) this.sessionIds.set(run.sessionKey, nid)
      if (nid && !run.runId) run.runId = nid
      if (!run.runId) run.runId = run.sessionKey
      const ctx: MapContext = { runId: run.runId, sessionId: run.sessionKey }
      for (const ev of mapHermesEvent(native, ctx, nextSeq, () => Date.now(), accumulated)) {
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
