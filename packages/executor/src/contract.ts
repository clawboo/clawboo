// The contract test-suite every RuntimeAdapter must pass. An adapter ships a
// runtime-specific `AdapterTestHarness` (in its own tests) and calls
// `runAdapterContract(harness)` — the generic assertions below then drive a
// runtime-agnostic scenario through the adapter and check the normalized
// output. Imports a test runner, so this module is exposed under the package's
// `./contract` subpath only (never re-exported from the app-safe barrel).

import { describe, expect, it } from 'vitest'

import type { RuntimeEvent } from './runtime-event'
import type { RunHandle, RuntimeAdapter } from './types'

/** A recorded RPC / side-effect the adapter issued, for assertions. */
export interface RecordedCall {
  method: string
  params: unknown
}

/**
 * Native-frame builders the harness supplies. The generic contract drives a
 * runtime-agnostic scenario by asking for these abstract frames; the harness
 * translates each into the runtime's own transport frame and `emit`s it.
 */
export interface ContractFrames {
  /** Incremental assistant text. */
  delta(text: string): unknown
  /** A tool / function invocation. */
  toolCall(name: string, input: unknown): unknown
  /** Terminal success carrying a final summary. */
  final(summary: string): unknown
  /** Terminal abort / cancel. */
  aborted(): unknown
  /** Terminal error. */
  error(message: string): unknown
}

/** Runtime-specific glue the contract suite drives. */
export interface AdapterTestHarness {
  /** Short label for the suite title (e.g. 'openclaw'). */
  label: string
  /** Construct a fresh adapter wired to a fresh fake transport. */
  makeAdapter(): RuntimeAdapter
  /** Start a run on the adapter; returns the handle the contract observes. */
  start(adapter: RuntimeAdapter): Promise<RunHandle>
  /** Push a native frame (built via `frames`) into the adapter's transport. */
  emit(frame: unknown): void
  /** Abstract-frame builders for the generic scenarios. */
  frames: ContractFrames
  /** Side-effects the adapter has issued so far (setModel / abort / writeContext). */
  recordedCalls(): RecordedCall[]
}

/** Drain an async iterable until a terminal `done` arrives (or a safety cap). */
async function collectUntilDone(
  iterable: AsyncIterable<RuntimeEvent>,
  cap = 200,
): Promise<RuntimeEvent[]> {
  const out: RuntimeEvent[] = []
  for await (const ev of iterable) {
    out.push(ev)
    if (ev.kind === 'done' || out.length >= cap) break
  }
  return out
}

export function runAdapterContract(harness: AdapterTestHarness): void {
  describe(`RuntimeAdapter contract — ${harness.label}`, () => {
    it('exposes a stable id and participantKind', () => {
      const a = harness.makeAdapter()
      expect(typeof a.id).toBe('string')
      expect(a.id.length).toBeGreaterThan(0)
      expect(['agent', 'human']).toContain(a.participantKind)
    })

    it('capabilities() returns a well-formed shape', () => {
      const caps = harness.makeAdapter().capabilities()
      expect(typeof caps.streaming).toBe('boolean')
      expect(typeof caps.mcp).toBe('boolean')
      expect(typeof caps.worktrees).toBe('boolean')
      expect(typeof caps.resume).toBe('boolean')
      expect(typeof caps.toolApproval).toBe('boolean')
      expect(Array.isArray(caps.models)).toBe(true)
    })

    it('health() resolves within 2s', async () => {
      const a = harness.makeAdapter()
      const res = await Promise.race([
        a.health(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('health() exceeded 2s')), 2000),
        ),
      ])
      expect(typeof res.ok).toBe('boolean')
    })

    it('start() returns a handle with the adapter id and an unbound runId', async () => {
      const a = harness.makeAdapter()
      const run = await harness.start(a)
      expect(run.adapterId).toBe(a.id)
      expect(run.runId).toBeNull()
      expect(typeof run.sessionKey).toBe('string')
      expect(run.sessionKey.length).toBeGreaterThan(0)
    })

    it('events() round-trips a normalized stream ending in done:success with monotonic seq', async () => {
      const a = harness.makeAdapter()
      const run = await harness.start(a)
      const iterable = a.events(run) // subscribe eagerly, before emitting
      harness.emit(harness.frames.delta('hello'))
      harness.emit(harness.frames.final('hello world'))
      const collected = await collectUntilDone(iterable)

      expect(collected.map((e) => e.kind)).toContain('text-delta')
      const last = collected[collected.length - 1]
      expect(last?.kind).toBe('done')
      if (last?.kind === 'done') expect(last.reason).toBe('success')
      for (let i = 1; i < collected.length; i += 1) {
        expect(collected[i]!.seq).toBeGreaterThan(collected[i - 1]!.seq)
      }
    })

    it('binds runId late, from the first lifecycle frame', async () => {
      const a = harness.makeAdapter()
      const run = await harness.start(a)
      expect(run.runId).toBeNull()
      const iterator = a.events(run)[Symbol.asyncIterator]()
      harness.emit(harness.frames.delta('x'))
      const first = await iterator.next()
      expect(first.done).toBe(false)
      expect(run.runId).not.toBeNull()
      await iterator.return?.()
    })

    it('abort() issues a cancel side-effect and the stream surfaces done:aborted', async () => {
      const a = harness.makeAdapter()
      const run = await harness.start(a)
      const iterable = a.events(run)
      harness.emit(harness.frames.delta('partial')) // bind a runId first
      // give the late-bind a tick to land before aborting
      await new Promise((r) => setTimeout(r, 0))
      await a.abort(run)
      harness.emit(harness.frames.aborted())
      const collected = await collectUntilDone(iterable)

      const last = collected[collected.length - 1]
      expect(last?.kind).toBe('done')
      if (last?.kind === 'done') expect(last.reason).toBe('aborted')
      expect(harness.recordedCalls().some((c) => /abort/i.test(c.method))).toBe(true)
    })

    it('setModel() issues a model-update side-effect', async () => {
      const a = harness.makeAdapter()
      const run = await harness.start(a)
      await a.setModel(run, 'contract-model-x')
      expect(
        harness.recordedCalls().some((c) => JSON.stringify(c.params).includes('contract-model-x')),
      ).toBe(true)
    })

    it('writeContext() issues a context-write side-effect', async () => {
      const a = harness.makeAdapter()
      const run = await harness.start(a)
      await a.writeContext(run, 'NOTES.md', 'contract-context-y')
      expect(
        harness
          .recordedCalls()
          .some((c) => JSON.stringify(c.params).includes('contract-context-y')),
      ).toBe(true)
    })
  })
}
