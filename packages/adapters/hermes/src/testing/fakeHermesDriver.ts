// In-memory HermesDriver double for the adapter contract + unit tests. Mirrors
// the other adapter fakes. Test-only (src/testing).

import type { RecordedCall } from '@clawboo/executor/contract'

import type { HermesDriver, HermesNativeEvent } from '../types'

export class FakeHermesDriver implements HermesDriver {
  readonly calls: RecordedCall[] = []
  private readonly handlers = new Set<(ev: HermesNativeEvent) => void>()

  async start(): Promise<void> {
    this.calls.push({ method: 'start', params: {} })
  }

  onEvent(handler: (ev: HermesNativeEvent) => void): () => void {
    this.handlers.add(handler)
    return () => this.handlers.delete(handler)
  }

  emit(ev: HermesNativeEvent): void {
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
