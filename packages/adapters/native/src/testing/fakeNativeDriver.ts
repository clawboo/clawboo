// In-memory NativeDriver double for the adapter contract + unit tests.
// Mirrors the other adapters' fakes: stores `onEvent` handlers, fans `emit`ed
// native events to them synchronously, and records every side-effect call for
// assertions. Not part of the published surface (src/testing only).

import type { RecordedCall } from '@clawboo/executor/contract'

import type { NativeDriver, NativeEvent } from '../types'

export class FakeNativeDriver implements NativeDriver {
  readonly calls: RecordedCall[] = []
  private readonly handlers = new Set<(ev: NativeEvent) => void>()

  async start(): Promise<void> {
    this.calls.push({ method: 'start', params: {} })
  }

  onEvent(handler: (ev: NativeEvent) => void): () => void {
    this.handlers.add(handler)
    return () => this.handlers.delete(handler)
  }

  /** Test-only: push a native event to every current subscriber. */
  emit(ev: NativeEvent): void {
    for (const handler of [...this.handlers]) handler(ev)
  }

  async abort(): Promise<void> {
    this.calls.push({ method: 'abort', params: {} })
  }

  async setModel(model: string): Promise<void> {
    this.calls.push({ method: 'setModel', params: { model } })
  }

  async writeContext(key: string, value: string): Promise<void> {
    this.calls.push({ method: 'writeContext', params: { key, value } })
  }
}
