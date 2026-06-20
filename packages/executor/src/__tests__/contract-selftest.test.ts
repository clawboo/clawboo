// Self-test: a minimal in-memory adapter that must satisfy the SAME
// `runAdapterContract` suite the real adapters use. This proves the contract
// harness is sound independently of any runtime, and doubles as the smallest
// possible reference implementation of the trait.

import {
  createAsyncQueue,
  type AsyncQueue,
  type RunHandle,
  type RuntimeAdapter,
  type RuntimeEvent,
} from '../index'
import { runAdapterContract, type AdapterTestHarness, type RecordedCall } from '../contract'

type NativeFrame =
  | { type: 'delta'; text: string }
  | { type: 'toolCall'; name: string; input: unknown }
  | { type: 'final'; summary: string }
  | { type: 'aborted' }
  | { type: 'error'; message: string }

interface Subscriber {
  queue: AsyncQueue<RuntimeEvent>
  run: RunHandle
  seq: number
}

class InMemoryAdapter implements RuntimeAdapter {
  readonly id = 'in-memory'
  readonly participantKind = 'agent' as const
  readonly calls: RecordedCall[] = []
  private readonly subscribers = new Set<Subscriber>()
  private runCounter = 0

  capabilities() {
    return {
      streaming: true,
      mcp: false,
      worktrees: false,
      resume: false,
      toolApproval: false,
      models: [],
    }
  }

  async health() {
    return { ok: true }
  }

  async start(_task: { taskId?: string | null }, opts: { sessionKey: string }): Promise<RunHandle> {
    return { adapterId: this.id, sessionKey: opts.sessionKey, runId: null }
  }

  events(run: RunHandle): AsyncIterable<RuntimeEvent> {
    const queue = createAsyncQueue<RuntimeEvent>()
    const sub: Subscriber = { queue, run, seq: 0 }
    this.subscribers.add(sub)
    const subscribers = this.subscribers
    return {
      [Symbol.asyncIterator](): AsyncIterator<RuntimeEvent> {
        const inner = queue[Symbol.asyncIterator]()
        return {
          next: () => inner.next(),
          return: () => {
            subscribers.delete(sub)
            return inner.return!()
          },
        }
      },
    }
  }

  /** Test-only: translate an abstract frame into normalized events for all observers. */
  inject(frame: NativeFrame): void {
    for (const sub of this.subscribers) {
      if (!sub.run.runId) sub.run.runId = `run-${++this.runCounter}` // late-bind
      const base = () => ({
        runId: sub.run.runId as string,
        sessionId: sub.run.sessionKey,
        ts: 1,
        seq: ++sub.seq,
      })
      switch (frame.type) {
        case 'delta':
          sub.queue.push({ ...base(), kind: 'text-delta', text: frame.text })
          break
        case 'toolCall':
          sub.queue.push({
            ...base(),
            kind: 'tool-call',
            toolCallId: 'tc-1',
            name: frame.name,
            input: frame.input,
            partial: false,
          })
          break
        case 'final':
          sub.queue.push({ ...base(), kind: 'done', reason: 'success', summary: frame.summary })
          break
        case 'aborted':
          sub.queue.push({ ...base(), kind: 'done', reason: 'aborted', summary: '' })
          break
        case 'error':
          sub.queue.push({
            ...base(),
            kind: 'error',
            code: null,
            message: frame.message,
            fatal: true,
          })
          sub.queue.push({ ...base(), kind: 'done', reason: 'error', summary: frame.message })
          break
      }
    }
  }

  async abort(run: RunHandle): Promise<void> {
    this.calls.push({ method: 'abort', params: { sessionKey: run.sessionKey, runId: run.runId } })
  }

  async setModel(run: RunHandle, model: string): Promise<void> {
    this.calls.push({ method: 'setModel', params: { sessionKey: run.sessionKey, model } })
  }

  async writeContext(run: RunHandle, key: string, value: string): Promise<void> {
    this.calls.push({ method: 'writeContext', params: { sessionKey: run.sessionKey, key, value } })
  }
}

function makeInMemoryHarness(): AdapterTestHarness {
  let adapter = new InMemoryAdapter()
  return {
    label: 'in-memory',
    makeAdapter() {
      adapter = new InMemoryAdapter()
      return adapter
    },
    start(a) {
      return (a as InMemoryAdapter).start({}, { sessionKey: 'session-1' })
    },
    emit(frame) {
      adapter.inject(frame as NativeFrame)
    },
    frames: {
      delta: (text) => ({ type: 'delta', text }),
      toolCall: (name, input) => ({ type: 'toolCall', name, input }),
      final: (summary) => ({ type: 'final', summary }),
      aborted: () => ({ type: 'aborted' }),
      error: (message) => ({ type: 'error', message }),
    },
    recordedCalls() {
      return adapter.calls
    },
  }
}

runAdapterContract(makeInMemoryHarness())
