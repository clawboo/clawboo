// In-memory CodexDriver double for the adapter contract + unit tests. Mirrors
// the Claude Code / OpenClaw fakes: stores handlers, fans `emit`ed native events
// synchronously, records side-effect calls. Test-only (src/testing).

import type { RecordedCall } from '@clawboo/executor/contract'

import type { CodexDriver, CodexNativeEvent } from '../types'

export class FakeCodexDriver implements CodexDriver {
  readonly calls: RecordedCall[] = []
  private readonly handlers = new Set<(ev: CodexNativeEvent) => void>()

  async start(): Promise<void> {
    this.calls.push({ method: 'start', params: {} })
  }

  onEvent(handler: (ev: CodexNativeEvent) => void): () => void {
    this.handlers.add(handler)
    return () => this.handlers.delete(handler)
  }

  emit(ev: CodexNativeEvent): void {
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
