import type { AgentsListResult, EventFrame, SessionPatchResult } from '@clawboo/gateway-client'

/**
 * The structural slice of the Gateway client the OpenClaw adapter uses. The
 * concrete `GatewayClient` class is assignable to this (it has a superset of
 * these members), and tests pass a lightweight in-memory double — so the
 * adapter depends on this shape, not on the class.
 */
export interface OpenClawGatewayClient {
  /** Global stream of every event frame; returns an unsubscribe fn. */
  onEvent(handler: (frame: EventFrame) => void): () => void
  /** Raw RPC (used for `chat.send`, which has no typed helper). */
  call<T = unknown>(method: string, params?: unknown): Promise<T>
  readonly agents: {
    list(): Promise<AgentsListResult>
    readonly files: {
      set(agentId: string, name: string, content: string): Promise<void>
    }
  }
  readonly sessions: {
    patch(key: string, updates: { model?: string | null }): Promise<SessionPatchResult>
    abort(
      key: string,
      runId?: string,
    ): Promise<{ ok: boolean; abortedRunId?: string | null; status?: string }>
  }
  readonly chat: {
    abort(
      sessionKey: string,
      runId: string,
    ): Promise<{ ok: boolean; abortedRunId?: string | null; status?: string }>
  }
}
