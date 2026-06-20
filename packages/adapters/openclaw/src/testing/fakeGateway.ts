// In-memory Gateway client double for the adapter contract + unit tests. Stores
// `onEvent` handlers and fans `emit`ed frames to them synchronously; records
// every RPC/helper call for assertions. Not part of the published surface — it
// lives under src/testing and is imported only by tests.

import type { AgentsListResult, EventFrame, SessionPatchResult } from '@clawboo/gateway-client'
import type { RecordedCall } from '@clawboo/executor/contract'

import type { OpenClawGatewayClient } from '../types'

export class FakeGatewayClient implements OpenClawGatewayClient {
  readonly calls: RecordedCall[] = []
  private readonly handlers = new Set<(frame: EventFrame) => void>()

  onEvent(handler: (frame: EventFrame) => void): () => void {
    this.handlers.add(handler)
    return () => this.handlers.delete(handler)
  }

  /** Test-only: push a frame to every current subscriber. */
  emit(frame: EventFrame): void {
    for (const handler of [...this.handlers]) handler(frame)
  }

  async call<T = unknown>(method: string, params?: unknown): Promise<T> {
    this.calls.push({ method, params })
    return undefined as T
  }

  readonly agents = {
    list: async (): Promise<AgentsListResult> => {
      this.calls.push({ method: 'agents.list', params: {} })
      return { defaultId: 'agent-1', mainKey: 'agent:agent-1:main', agents: [] }
    },
    files: {
      set: async (agentId: string, name: string, content: string): Promise<void> => {
        this.calls.push({ method: 'agents.files.set', params: { agentId, name, content } })
      },
    },
  }

  readonly sessions = {
    patch: async (key: string, updates: { model?: string | null }): Promise<SessionPatchResult> => {
      this.calls.push({ method: 'sessions.patch', params: { key, ...updates } })
      return { ok: true, key }
    },
    abort: async (
      key: string,
      runId?: string,
    ): Promise<{ ok: boolean; abortedRunId?: string | null; status?: string }> => {
      this.calls.push({ method: 'sessions.abort', params: { key, runId } })
      return { ok: true, abortedRunId: runId ?? null }
    },
  }

  readonly chat = {
    abort: async (
      sessionKey: string,
      runId: string,
    ): Promise<{ ok: boolean; abortedRunId?: string | null; status?: string }> => {
      this.calls.push({ method: 'chat.abort', params: { sessionKey, runId } })
      return { ok: true, abortedRunId: runId }
    },
  }
}
