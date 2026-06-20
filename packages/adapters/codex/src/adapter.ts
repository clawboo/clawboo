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

import { codexNativeId, mapCodexEvent, type MapContext } from './mapCodexEvent'
import type { CodexDriver, CodexDriverFactory, CodexNativeEvent } from './types'

/**
 * Codex RuntimeAdapter. Same shape as the Claude Code adapter (per-run injected
 * driver, eager subscribe, late-bound runId), driving `codex exec` instead. The
 * runtime differences (no USD cost, thread-id resume) live entirely in
 * `mapCodexEvent` + the driver, so the trait surface is identical.
 */
export class CodexAdapter implements RuntimeAdapter {
  readonly id = 'codex'
  readonly participantKind = 'agent' as const

  private readonly drivers = new Map<string, CodexDriver>()

  constructor(
    private readonly driverFactory: CodexDriverFactory,
    private readonly healthCheck: () => Promise<HealthResult> = async () => ({ ok: true }),
  ) {}

  capabilities(): Capabilities {
    return {
      streaming: true,
      mcp: true,
      worktrees: true,
      resume: true,
      toolApproval: true,
      models: ['gpt-5-codex', 'gpt-5', 'o4-mini'],
      // Native-preservation seam: declared as today's reality — a throwaway
      // per-run CODEX_HOME (the driver mkdtemps one each run), no cross-run
      // self-improvement substrate to preserve. KNOWN LIMITATION: Codex keeps
      // its ChatGPT OAuth in $CODEX_HOME/auth.json, so a user's `codex login`
      // (~/.codex) is invisible to spawned runs; flipping to a persistent
      // per-identity home would CHANGE auth behavior and needs its own
      // login-against-that-home connect flow first.
      runtimeClass: 'wrapped-oneshot',
      nativeHome: { scope: 'per-run', persist: false },
      nativeSkills: 'none',
      nativeMemory: 'none',
      nativeChannels: 'none',
      nativeScheduler: false,
    }
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

    const unsubscribe = driver.onEvent((native: CodexNativeEvent) => {
      const nid = codexNativeId(native)
      if (nid && !run.runId) run.runId = nid
      if (!run.runId) run.runId = run.sessionKey
      const ctx: MapContext = { runId: run.runId, sessionId: run.sessionKey }
      for (const ev of mapCodexEvent(native, ctx, nextSeq, () => Date.now(), accumulated)) {
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
