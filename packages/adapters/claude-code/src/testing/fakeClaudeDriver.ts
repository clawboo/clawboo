// In-memory ClaudeCodeDriver double for the adapter contract + unit tests.
// Mirrors the OpenClaw `FakeGatewayClient`: stores `onEvent` handlers, fans
// `emit`ed native events to them synchronously, and records every side-effect
// call for assertions. Not part of the published surface (src/testing only).

import type { SteerOptions } from '@clawboo/executor'
import type { RecordedCall } from '@clawboo/executor/contract'

import type { ClaudeCodeDriver, ClaudeNativeEvent } from '../types'

export class FakeClaudeDriver implements ClaudeCodeDriver {
  readonly calls: RecordedCall[] = []
  private readonly handlers = new Set<(ev: ClaudeNativeEvent) => void>()

  async start(): Promise<void> {
    this.calls.push({ method: 'start', params: {} })
  }

  onEvent(handler: (ev: ClaudeNativeEvent) => void): () => void {
    this.handlers.add(handler)
    return () => this.handlers.delete(handler)
  }

  /** Test-only: push a native event to every current subscriber. */
  emit(ev: ClaudeNativeEvent): void {
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

  /** What `steer` answers: true (the run took it), false (the run had ended) or
   *  an Error (the runtime refused it). */
  steerAnswer: boolean | Error = true

  async steer(text: string, opts?: SteerOptions): Promise<boolean> {
    this.calls.push({ method: 'steer', params: { text, ...(opts ? { opts } : {}) } })
    if (this.steerAnswer instanceof Error) throw this.steerAnswer
    return this.steerAnswer
  }
}
