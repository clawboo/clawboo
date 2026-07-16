// Per-run context the executor runner injects into a real RuntimeDriver. Carries
// the worktree cwd, an optional native resume handle, the model, the base URL of
// the running clawboo server (so the driver can point the runtime's MCP config at
// our hosted Tasks/Memory/Tools servers), and any provider env (API keys) for the
// spawned process. Kept minimal — each driver builds its own runtime-shaped MCP
// attach config from `mcpBaseUrl` via `@clawboo/mcp`'s `buildAttachConfig`.

export interface RuntimeRunContext {
  /** Worktree path the run executes in (file-mutating tasks). */
  cwd?: string | null
  /** Model override for this run. */
  model?: string | null
  /**
   * Provider override for a runtime that derives its provider at run time (Hermes
   * picks OpenRouter / Anthropic / OpenAI from the connected key by default). Set
   * from a per-agent model choice (execConfig.provider) to PIN the provider so the
   * chosen model runs on it. Runtimes that don't derive a provider ignore it.
   */
  providerHint?: string | null
  /** Native resume handle (session/thread id) when resuming the same runtime. */
  resume?: string | null
  /**
   * Stable per-identity home for runtimes whose integration plan resolves to a
   * persistent home (e.g. Hermes). Computed ONCE by the runner from
   * `resolveRuntimeIntegration(capabilities)` — drivers never re-derive it.
   * null/omitted ⇒ the driver provisions its own throwaway home.
   */
  homeDir?: string | null
  /** Base URL of the running clawboo server, e.g. `http://localhost:18790`. */
  mcpBaseUrl?: string | null
  /**
   * The run's authoritative memory scope (the dispatched task's team + the
   * assigned agent). Carried onto the shared Memory MCP attach so saves are
   * auto-tagged team-shared and reads stay team-limited — the model never
   * supplies (and cannot widen) it. `tenantId` is a dormant seam.
   *
   * `delegate: true` marks an ORCHESTRATOR-driven run (set exclusively by
   * `serverDeliver`) — it rides the TeamChat attach URL as `delegate=1` and
   * exposes the `team_delegate` signal tool to the run. A team-scoped run alone
   * (e.g. an executorRunner board-task run) must NOT set it: nothing observes
   * delegation there, so the tool would be a silent no-op.
   */
  memoryScope?: {
    teamId?: string | null
    agentId?: string | null
    tenantId?: string | null
    delegate?: boolean
  } | null
  /** Extra env for a spawned subprocess (provider API keys, isolated HOME, …). */
  apiKeyEnv?: Record<string, string>
}
