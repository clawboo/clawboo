// OpenClawAgentSource — the server-side AgentSource that wraps a GatewayClient and
// makes SQLite the agent-registry of record. Reads come from SQLite (so they work
// when the Gateway is down); the sync mirrors `agents.list()` IN (Gateway-owned
// columns only — SQLite-native columns are preserved across re-sync); writes +
// file I/O + sessions delegate to the Gateway and require a live connection.
//
// The Gateway client is injected via `makeClient` (the registry wires the real
// GatewayClient + the proxy-device `signConnect`; tests pass a fake). This is the
// "who exists" layer — it never touches RuntimeAdapter ("how they run").

import {
  agents,
  approvalHistory,
  costRecords,
  createDb,
  getSetting,
  settings,
  teams,
  type ClawbooDb,
  type DbAgent,
} from '@clawboo/db'
import type {
  AgentEvent,
  AgentFileName,
  AgentRecord,
  AgentRecordStatus,
  AgentSource,
  CreateAgentInput,
  HealthResult,
  SessionRecord,
  SyncResult,
  TeamRecord,
  UpdateAgentInput,
} from '@clawboo/agent-registry'
import type { OpenClawGatewayClient } from '@clawboo/adapter-openclaw'
import { authRetryAfterMs, isAuthConnectError } from '@clawboo/gateway-client'
import { mcpHttpUrl } from '@clawboo/mcp'
import { and, eq, inArray, isNull, sql } from 'drizzle-orm'

// ── The subset of GatewayClient this source uses (the real client satisfies it;
//    tests pass a fake). ──
export interface OpenClawClientLike {
  connect(url: string, options: Record<string, unknown>): Promise<void>
  disconnect(): void
  onStatus(cb: (status: string) => void): () => void
  onEvent(cb: (frame: { event: string; payload?: unknown }) => void): () => void
  /** Raw operator WS-RPC (cron.*, chat.send, …). The real GatewayClient has it. */
  call<T = unknown>(method: string, params?: unknown): Promise<T>
  agents: {
    list(): Promise<{
      defaultId?: string
      mainKey?: string
      scope?: string
      agents: AgentListEntryLike[]
    }>
    create(config: { name: string; workspace: string }): Promise<{ agentId: string }>
    delete(id: string): Promise<void>
    files: {
      read(agentId: string, name: string): Promise<string>
      set(agentId: string, name: string, content: string): Promise<void>
    }
  }
  sessions: { list(agentId: string): Promise<Array<{ key: string; agentId: string }>> }
  config: {
    get(): Promise<{ path?: string }>
    /** Live operator config patch (Partial<GatewayConfig>; the loose Gateway
     *  shape accepts arbitrary nested keys). Used to register clawboo's MCP
     *  servers in the top-level `mcp.servers`. `baseHash` is the optimistic-
     *  concurrency token from `config.get`, required by OpenClaw 2026.5.x. */
    patch(updates: Record<string, unknown>, baseHash?: string): Promise<void>
  }
}

export interface AgentListEntryLike {
  id: string
  name?: string
  identity?: { name?: string; theme?: string; emoji?: string; avatar?: string; avatarUrl?: string }
}

export interface OpenClawAgentSourceDeps {
  getDbPath: () => string
  loadSettings: () => { gatewayUrl?: string; gatewayToken?: string }
  /** Construct a fresh Gateway client (the registry injects the real one + signer). */
  makeClient: () => OpenClawClientLike
  /** Connect options the registry supplies (token + signConnect). */
  connectOptions: () => Record<string, unknown>
  /** Base URL of the running clawboo server (e.g. `http://127.0.0.1:18790`) so
   *  the shared MCP servers can be registered in the Gateway config. Null until
   *  the port is resolved at boot — registration is a best-effort no-op then. */
  mcpBaseUrl?: () => string | null
  log?: (level: 'info' | 'warn' | 'error', obj: object, msg: string) => void
}

/** The persisted Gateway `defaultId` (the teamless default agent = Boo Zero). Exported
 *  so the server team orchestrator can identify Boo Zero for OpenClaw teams. */
export const SETTING_DEFAULT_ID = 'agent-source:openclaw:defaultId'
const SETTING_MAIN_KEY = 'agent-source:openclaw:mainKey'
const SETTING_SCOPE = 'agent-source:openclaw:scope'
const SETTING_LAST_SYNCED = 'agent-source:openclaw:lastSyncedAt'

const RESYNC_DEBOUNCE_MS = 750
const BACKOFF_BASE_MS = 2_000
const BACKOFF_CAP_MS = 60_000
// Floor between retries after an AUTH-class connect failure (bad token / unpaired
// device / bad connect params / a "too many failed authentication attempts" lockout).
// The fast transient backoff (2s → 60s) is what trips + re-trips the Gateway's
// failed-auth lockout, so we back WAY off — slow enough never to accumulate a
// lockout, still self-healing once the credentials/pairing are fixed or the lockout
// window clears. Honours the Gateway's own `retryAfterMs` when it sends one.
const AUTH_RETRY_FLOOR_MS = 120_000

// OpenClaw's native sub-agent-spawning tools. Clawboo's team model forbids agents
// from spawning their own throwaway sub-agents (they must delegate to the EXISTING
// team via `<delegate>`, which the board orchestrator drives) — the anti-sub-agent
// invariant. These are added to the Gateway's `tools.deny` on connect so the
// enforcement is at the runtime level, not just a prompt the model may ignore.
const SUBAGENT_SPAWN_TOOLS = ['sessions_spawn', 'sessions_yield'] as const

function parseJson(value: string | null): unknown | null {
  if (!value) return null
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

export class OpenClawAgentSource implements AgentSource {
  readonly id = 'openclaw'

  private client: OpenClawClientLike | null = null
  private unsubStatus: (() => void) | null = null
  private unsubEvent: (() => void) | null = null
  private connection: HealthResult['connection'] = 'disconnected'
  private connecting = false
  private stopped = false
  // Set when the last connect failed for an AUTH-class reason. Suppresses the
  // per-delivery `reconnectAndWait` re-attempt (the amplifier that hammers the
  // Gateway) and routes the retry to the long AUTH_RETRY_FLOOR_MS backoff. Cleared
  // on a successful connect or an explicit `reconnect()` (settings change / gateway
  // start = "the credentials may have changed, try now").
  private authBlocked = false
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private resyncTimer: ReturnType<typeof setTimeout> | null = null
  private retries = 0
  private readonly listeners = new Set<(e: AgentEvent) => void>()
  // Reconnect-stable broadcast fan-out: the client (and its onEvent
  // subscription) is torn down per connection; this listener set is not.
  private readonly broadcastListeners = new Set<
    (frame: { event: string; payload?: unknown }) => void
  >()

  constructor(private readonly deps: OpenClawAgentSourceDeps) {}

  private db(): ClawbooDb {
    return createDb(this.deps.getDbPath())
  }

  private log(level: 'info' | 'warn' | 'error', obj: object, msg: string): void {
    this.deps.log?.(level, obj, msg)
  }

  private emit(event: AgentEvent): void {
    for (const fn of this.listeners) {
      try {
        fn(event)
      } catch {
        /* a listener throwing must not break the source */
      }
    }
  }

  isConnected(): boolean {
    return this.connection === 'connected'
  }

  /** True while the last connect failed for an auth-class reason (bad token /
   *  unpaired device / lockout). Diagnostic — the source is on a long backoff and
   *  is deliberately NOT hammering the Gateway. */
  isAuthBlocked(): boolean {
    return this.authBlocked
  }

  // ── Operator surface (the connected-substrate dispatch + cron seam) ────────

  /** Raw operator WS-RPC passthrough on the server-held PAIRED connection
   *  (operator-write scope). Throws `gateway_disconnected` when down. */
  async operatorCall<T>(method: string, params?: unknown): Promise<T> {
    return this.requireClient().call<T>(method, params)
  }

  /** Subscribe to Gateway broadcast frames (e.g. the `cron` event family).
   *  Survives reconnects — the fan-out set outlives any single client. */
  onGatewayBroadcast(cb: (frame: { event: string; payload?: unknown }) => void): () => void {
    this.broadcastListeners.add(cb)
    return () => this.broadcastListeners.delete(cb)
  }

  /**
   * The live operator connection typed as the adapter slice (null when the
   * Gateway is down). The injected client IS a real GatewayClient, which
   * carries the full method superset; OpenClawClientLike narrows it for this
   * source, so widening back to the adapter slice is a cast, not a lie.
   */
  operatorClient(): OpenClawGatewayClient | null {
    return this.client && this.isConnected()
      ? (this.client as unknown as OpenClawGatewayClient)
      : null
  }

  /**
   * Best-effort: register clawboo's shared Memory (+ Tasks) MCP servers in the
   * Gateway config over the live operator connection, so OpenClaw agents can
   * read/write the one shared team memory. Idempotent (re-applied on reconnect,
   * since the Gateway may reset config across restarts). The fact scope is
   * GLOBAL — OpenClaw agents are cross-team, so a Gateway-global registration
   * can't carry a per-run team scope (the other four runtimes get per-run scope
   * via their attach URLs). Read-merge-patch preserves existing `mcp.servers`
   * entries regardless of the Gateway's patch-merge semantics. Never throws.
   *
   * Config shape confirmed against OpenClaw 2026.5.27's own config docs: the
   * registry lives at the TOP-LEVEL `mcp.servers` key (not `tools.mcp.servers`),
   * and a Streamable-HTTP server entry is `{ url, transport: 'streamable-http' }`.
   */
  private async registerSharedMcpServers(): Promise<void> {
    const baseUrl = this.deps.mcpBaseUrl?.()
    const client = this.client
    if (!baseUrl || !client || !this.isConnected()) return
    try {
      // `config.get` returns a SNAPSHOT wrapper — the live config sits under
      // `.config` (older shapes spread it to the top level too); read both
      // defensively so the idempotency check below sees the real servers.
      const snapshot = (await client.config.get()) as {
        config?: {
          mcp?: { servers?: Record<string, { url?: string }> }
          tools?: { deny?: unknown }
        }
        mcp?: { servers?: Record<string, { url?: string }> }
        tools?: { deny?: unknown }
        hash?: string
        baseHash?: string
      }
      const current = snapshot.config?.mcp?.servers ?? snapshot.mcp?.servers ?? {}
      // OpenClaw 2026.5.x's config.patch requires the snapshot hash (optimistic
      // concurrency). config.get returns it as `hash` (defensively also `baseHash`).
      const baseHash = snapshot.hash ?? snapshot.baseHash

      // Anti-sub-agent enforcement (a Tier-1 team invariant): deny the OpenClaw
      // tools that spawn throwaway sub-agents. Without this, a spawn-happy model
      // (e.g. a weak OpenRouter model) ignores the prompt-level "delegate, don't
      // spawn" rule and loops on `sessions_spawn`, creating its own sub-agents that
      // bypass the real team + Clawboo's board (observed: 51 spawn calls in one run).
      // Clawboo owns openclaw.json (it also patches mcp.servers here); `tools.deny`
      // is a top-level id array under `tools` (deny-wins). Re-asserted as the union
      // with any user-set deny entries so we never drop the user's own denials.
      const rawDeny = (snapshot.config?.tools?.deny ?? snapshot.tools?.deny) as unknown
      const currentDeny = Array.isArray(rawDeny) ? rawDeny.filter((x): x is string => typeof x === 'string') : []
      const desiredDeny = Array.from(new Set([...currentDeny, ...SUBAGENT_SPAWN_TOOLS]))
      const denyOk = SUBAGENT_SPAWN_TOOLS.every((t) => currentDeny.includes(t))
      const entry = (server: 'memory' | 'tasks') => ({
        url: mcpHttpUrl(baseUrl, server),
        transport: 'streamable-http' as const,
      })
      // TeamChat is DELIBERATELY NOT registered for OpenClaw. The Gateway config
      // is process-wide, so a single static URL cannot carry a per-run author
      // binding — registering the team_chat tool unbound would let an OpenClaw
      // agent post as ANY author (identity from tool args), breaking the
      // load-bearing anti-spoof property. Instead, an OpenClaw agent's room
      // participation is fully SERVER-MEDIATED through the team exchange, which
      // posts the agent's drained turn with the AUTHORITATIVE bound identity and
      // injects new room posts back as evidence — POST + LISTEN with no spoofable
      // tool. Memory stays global-scoped for OpenClaw (its agents are cross-team;
      // an in-Gateway autonomous tool call can't be per-run scoped without
      // reaching into the Gateway) — an organizational, not security, boundary
      // for the local-first single-user model; the multi-tenant horizon is parked.
      const desired = {
        'clawboo-memory': entry('memory'),
        'clawboo-tasks': entry('tasks'),
      }
      // Idempotent: skip the patch when the MCP servers are registered AND the
      // sub-agent tools are already denied. This fires on EVERY reconnect, and the
      // Gateway rate-limits control-plane writes to 3 per 60s — re-patching
      // unchanged config would burn that budget (and spam the log) for nothing.
      const alreadyRegistered = Object.entries(desired).every(
        ([name, e]) => current[name]?.url === e.url,
      )
      if (alreadyRegistered && denyOk) return
      // The Gateway deep-merges partials, so unrelated config — the user's own MCP
      // servers, other `mcp.*` keys, existing `tools.*` — is preserved; we re-assert
      // `current` (servers) + the deny UNION to keep the merge explicit.
      const servers = { ...current, ...desired }
      await client.config.patch({ mcp: { servers }, tools: { deny: desiredDeny } }, baseHash)
      this.log(
        'info',
        { baseUrl, denied: SUBAGENT_SPAWN_TOOLS },
        'agent-source: registered clawboo MCP servers + denied sub-agent tools in Gateway config',
      )
    } catch (err) {
      this.log('warn', { err: String(err) }, 'agent-source: MCP registration failed (non-blocking)')
    }
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    this.stopped = false
    await this.openConnection()
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.retryTimer) clearTimeout(this.retryTimer)
    if (this.resyncTimer) clearTimeout(this.resyncTimer)
    this.retryTimer = null
    this.resyncTimer = null
    this.teardownClient()
    this.setConnection('disconnected')
  }

  /** Re-read settings + reconnect (called when settings change or the gateway starts).
   *  Clears any auth block: an explicit reconnect means "the credentials/pairing may
   *  have changed — try again now" (the recovery path out of the long auth backoff). */
  async reconnect(): Promise<void> {
    this.authBlocked = false
    await this.stop()
    await this.start()
  }

  /** Ensure the operator client is live, reconnecting + WAITING (bounded) if it is
   *  not — so a caller (a team-chat delivery) recovers a transient down-state on the
   *  spot instead of failing and making the user resend. Returns whether the operator
   *  is usable by the deadline. Fast path: already-connected returns immediately. If
   *  the Gateway itself is down the reconnect can't succeed and this returns false. */
  async reconnectAndWait(timeoutMs = 8000): Promise<boolean> {
    if (this.operatorClient()) return true
    // Auth-blocked: the Gateway is rejecting our credentials/pairing. Re-attempting
    // here — which happens per team-chat delivery — is exactly what accumulates its
    // "too many failed authentication attempts" lockout. Report the operator
    // unusable; recovery comes from the slow auth backoff or an explicit reconnect()
    // (a settings change / gateway restart), never from this hot path.
    if (this.authBlocked) return false
    await this.reconnect().catch(() => undefined)
    if (this.operatorClient()) return true
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline && !this.operatorClient()) {
      await new Promise((r) => setTimeout(r, 300))
    }
    return this.operatorClient() != null
  }

  private teardownClient(): void {
    try {
      this.unsubStatus?.()
      this.unsubEvent?.()
      this.client?.disconnect()
    } catch {
      /* best-effort */
    }
    this.unsubStatus = null
    this.unsubEvent = null
    this.client = null
  }

  private setConnection(c: HealthResult['connection']): void {
    if (this.connection === c) return
    this.connection = c
    this.emit({ kind: 'connection', at: Date.now(), connection: c })
  }

  private async openConnection(): Promise<void> {
    if (this.stopped || this.connecting || this.client) return
    const { gatewayUrl } = this.deps.loadSettings()
    if (!gatewayUrl?.trim()) {
      // Not configured yet — reads still serve SQLite; nothing to connect to.
      this.setConnection('disconnected')
      return
    }
    this.connecting = true
    this.setConnection('connecting')
    let client: OpenClawClientLike
    try {
      client = this.deps.makeClient()
      this.client = client
      this.unsubStatus = client.onStatus((status) => this.onStatus(status))
      this.unsubEvent = client.onEvent((frame) => this.onGatewayEvent(frame))
      await client.connect(gatewayUrl, this.deps.connectOptions())
      this.connecting = false
      this.retries = 0
      this.authBlocked = false
      this.setConnection('connected')
      // Attach the shared Memory/Tasks MCP servers in the Gateway config (best
      // effort; idempotent on reconnect — see registerSharedMcpServers).
      void this.registerSharedMcpServers()
      await this.sync().catch((err) =>
        this.log('warn', { err: String(err) }, 'agent-source: initial sync failed'),
      )
    } catch (err) {
      this.connecting = false
      this.teardownClient()
      this.setConnection('disconnected')
      // A permanent auth failure (bad token / unpaired device / bad connect params)
      // or a rate-limit lockout ("too many failed authentication attempts") must NOT
      // be fast-retried — doing so is what trips and re-trips the Gateway lockout.
      // Back off to a long floor (honouring the Gateway's retryAfterMs) and mark the
      // source auth-blocked so the per-delivery reconnect path stops re-attempting.
      const authClass = isAuthConnectError(err)
      this.authBlocked = authClass
      this.scheduleRetry(
        authClass ? Math.max(authRetryAfterMs(err) ?? 0, AUTH_RETRY_FLOOR_MS) : undefined,
      )
      this.log(
        'warn',
        { err: String(err), authClass },
        authClass
          ? 'agent-source: auth-class connect failure — backing off (long) to avoid a Gateway lockout'
          : 'agent-source: connect failed, will retry',
      )
    }
  }

  // Reconnect-regime ownership (read alongside GatewayClient.scheduleReconnect):
  // this owns ONLY the INITIAL-connect-failure case (openConnection() threw),
  // 2s → 60s. Once a connection has opened, the GatewayClient's own reconnect
  // loop (800ms → 15s) owns post-open drops. The two are gated on disjoint
  // conditions, so they never run concurrently for the same connection.
  private scheduleRetry(minDelayMs?: number): void {
    if (this.stopped || this.retryTimer) return
    const base = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** this.retries)
    // An auth-class failure passes a long floor so the retry never lands in the fast
    // window; a transient failure uses the plain exponential backoff.
    const delay = minDelayMs != null ? Math.max(minDelayMs, base) : base
    this.retries += 1
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      void this.openConnection()
    }, delay)
    this.retryTimer.unref?.()
  }

  private onStatus(status: string): void {
    if (status === 'connected') {
      this.setConnection('connected')
      // Re-register on an auto-reconnect (the Gateway may reset config on restart).
      void this.registerSharedMcpServers()
      this.scheduleResync()
    } else if (status === 'reconnecting') {
      this.setConnection('reconnecting')
    } else if (status === 'disconnected') {
      this.setConnection('disconnected')
    }
  }

  private onGatewayEvent(frame: { event: string; payload?: unknown }): void {
    for (const fn of this.broadcastListeners) {
      try {
        fn(frame)
      } catch {
        /* a broadcast listener throwing must not break the source */
      }
    }
    if (frame.event === 'presence' || frame.event === 'heartbeat' || frame.event === 'agent') {
      this.scheduleResync()
    }
  }

  private scheduleResync(): void {
    if (this.stopped) return
    if (this.resyncTimer) clearTimeout(this.resyncTimer)
    this.resyncTimer = setTimeout(() => {
      this.resyncTimer = null
      void this.sync().catch((err) =>
        this.log('warn', { err: String(err) }, 'agent-source: resync failed'),
      )
    }, RESYNC_DEBOUNCE_MS)
    this.resyncTimer.unref?.()
  }

  // ── Sync (Gateway → SQLite, idempotent, native columns preserved) ──────────

  async sync(): Promise<SyncResult> {
    const started = Date.now()
    if (!this.client || !this.isConnected()) {
      throw new Error('gateway_disconnected')
    }
    const result = await this.client.agents.list()
    const upserted = this.upsertFromList(result.agents, {
      defaultId: result.defaultId ?? '',
      mainKey: (result.mainKey ?? '').trim() || 'main',
      scope: result.scope ?? '',
    })
    const sync: SyncResult = {
      upserted: upserted.upserted,
      archived: upserted.archived,
      durationMs: Date.now() - started,
      at: Date.now(),
    }
    this.emit({ kind: 'sync-complete', at: sync.at, result: sync })
    return sync
  }

  /** The pure upsert: GATEWAY-OWNED columns only in the `set` clause; SQLite-native
   *  columns are never touched (the idempotency invariant). Also archives rows gone
   *  upstream and persists list-level defaultId/mainKey/scope. One transaction. */
  upsertFromList(
    entries: AgentListEntryLike[],
    meta: { defaultId: string; mainKey: string; scope: string },
  ): { upserted: number; archived: number } {
    const db = this.db()
    const now = Date.now()
    let archived = 0

    db.transaction((tx) => {
      const liveIds = new Set<string>()
      for (const entry of entries) {
        const id = entry.id
        if (!id) continue
        liveIds.add(id)
        const displayName = entry.identity?.name?.trim() || entry.name?.trim() || id
        const identityJson = JSON.stringify(entry.identity ?? {})
        tx.insert(agents)
          .values({
            id,
            name: displayName,
            gatewayId: id,
            sourceId: 'openclaw',
            sourceAgentId: id,
            identityJson,
            status: 'idle',
            participantKind: 'agent',
            runtime: 'openclaw',
            createdAt: now,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: agents.id,
            // GATEWAY-OWNED columns ONLY — never teamId / personality / execConfig /
            // avatarSeed / participantKind / runtime / capabilities / tenantId.
            set: {
              name: displayName,
              gatewayId: id,
              sourceAgentId: id,
              identityJson,
              archivedAt: null, // revive if it had been archived
              updatedAt: now,
            },
          })
          .run()
      }

      // Archive rows present in SQLite (live) but gone upstream.
      const localRows = tx
        .select({ id: agents.id })
        .from(agents)
        .where(and(eq(agents.sourceId, 'openclaw'), isNull(agents.archivedAt)))
        .all()
      const missing = localRows.map((r) => r.id).filter((id) => !liveIds.has(id))
      if (missing.length > 0) {
        tx.update(agents)
          .set({ archivedAt: now, status: 'archived', updatedAt: now })
          .where(inArray(agents.id, missing))
          .run()
        archived = missing.length
        for (const id of missing) this.emit({ kind: 'agent-archived', at: now, agentId: id })
      }

      // List-level metadata (inline upsert — `tx` isn't typed as ClawbooDb so we
      // can't reuse setSetting() here).
      const putSetting = (key: string, value: string): void => {
        tx.insert(settings)
          .values({ key, value, updatedAt: now })
          .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: now } })
          .run()
      }
      putSetting(SETTING_DEFAULT_ID, meta.defaultId)
      putSetting(SETTING_MAIN_KEY, meta.mainKey)
      putSetting(SETTING_SCOPE, meta.scope)
      putSetting(SETTING_LAST_SYNCED, String(now))
    })

    return { upserted: entries.length, archived }
  }

  // ── Reads (SQLite-backed) ──────────────────────────────────────────────────

  private mapRow(row: DbAgent, defaultId: string, mainKey: string): AgentRecord {
    const sourceAgentId = row.sourceAgentId ?? row.gatewayId
    const identity = (parseJson(row.identityJson) ?? {}) as {
      name?: string
      emoji?: string
      avatarUrl?: string
    }
    return {
      id: row.id,
      sourceId: row.sourceId,
      sourceAgentId,
      displayName: identity.name?.trim() || row.name || row.id,
      emoji: identity.emoji ?? null,
      avatarUrl: identity.avatarUrl ?? null,
      avatarSeed: row.avatarSeed ?? null,
      status: row.status as AgentRecordStatus,
      sessionKey: `agent:${sourceAgentId}:${mainKey}`,
      isDefault: !!defaultId && sourceAgentId === defaultId,
      teamId: row.teamId ?? null,
      personalityConfig: parseJson(row.personalityConfig),
      execConfig: parseJson(row.execConfig),
      participantKind: (row.participantKind as 'agent' | 'human') ?? 'agent',
      runtime: row.runtime,
      capabilities: parseJson(row.capabilities),
      tenantId: row.tenantId ?? null,
      archivedAt: row.archivedAt ?? null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }
  }

  private listMeta(db: ClawbooDb): { defaultId: string; mainKey: string } {
    return {
      defaultId: getSetting(db, SETTING_DEFAULT_ID) ?? '',
      mainKey: (getSetting(db, SETTING_MAIN_KEY) ?? '').trim() || 'main',
    }
  }

  async listAgents(opts?: { includeArchived?: boolean; teamId?: string }): Promise<AgentRecord[]> {
    const db = this.db()
    const meta = this.listMeta(db)
    let rows = db.select().from(agents).where(eq(agents.sourceId, 'openclaw')).all()
    if (!opts?.includeArchived) rows = rows.filter((r) => r.archivedAt == null)
    if (opts?.teamId) rows = rows.filter((r) => r.teamId === opts.teamId)
    return rows.map((r) => this.mapRow(r, meta.defaultId, meta.mainKey))
  }

  async getAgent(id: string): Promise<AgentRecord | null> {
    const db = this.db()
    const meta = this.listMeta(db)
    const row = db.select().from(agents).where(eq(agents.id, id)).get()
    return row ? this.mapRow(row, meta.defaultId, meta.mainKey) : null
  }

  async listTeams(opts?: { includeArchived?: boolean }): Promise<TeamRecord[]> {
    const db = this.db()
    const rows = db.select().from(teams).all()
    const filtered = opts?.includeArchived ? rows : rows.filter((t) => !t.isArchived)
    return filtered.map((t) => {
      const count = db
        .select({ c: sql<number>`COUNT(*)` })
        .from(agents)
        .where(and(eq(agents.teamId, t.id), isNull(agents.archivedAt)))
        .get()
      return {
        id: t.id,
        name: t.name,
        icon: t.icon,
        color: t.color,
        colorCollectionId: t.colorCollectionId ?? null,
        templateId: t.templateId ?? null,
        leaderAgentId: t.leaderAgentId ?? null,
        isArchived: !!t.isArchived,
        agentCount: count?.c ?? 0,
        tenantId: t.tenantId ?? null,
        createdAt: t.createdAt,
        updatedAt: t.updatedAt,
      }
    })
  }

  /** OpenClaw sessions are runtime-live — delegate to the Gateway (no SQLite). */
  async listSessions(agentId: string): Promise<SessionRecord[]> {
    if (!this.client || !this.isConnected()) throw new Error('gateway_disconnected')
    const rows = await this.client.sessions.list(agentId)
    return rows.map((s) => ({
      id: s.key,
      sourceId: 'openclaw',
      sourceSessionId: s.key,
      agentId: s.agentId,
      teamId: null,
      status: 'active',
      createdAt: null,
      updatedAt: null,
    }))
  }

  // ── Writes (require a live Gateway) ────────────────────────────────────────

  private requireClient(): OpenClawClientLike {
    if (!this.client || !this.isConnected()) throw new Error('gateway_disconnected')
    return this.client
  }

  async createAgent(input: CreateAgentInput): Promise<AgentRecord> {
    const client = this.requireClient()
    const snapshot = await client.config.get()
    const configPath = typeof snapshot.path === 'string' ? snapshot.path.trim() : ''
    if (!configPath) throw new Error('Gateway did not return a config path.')
    const stateDir = dirnameLike(configPath)
    if (!stateDir) throw new Error(`Config path "${configPath}" has no directory component.`)
    const workspace = joinPathLike(stateDir, `workspace-${slugifyName(input.name)}`)

    const created = await client.agents.create({ name: input.name, workspace })
    const agentId = created.agentId.trim()
    if (!agentId) throw new Error('Gateway did not return an agentId for the created agent.')

    const files = input.files ?? {}
    for (const name of ['SOUL.md', 'IDENTITY.md', 'TOOLS.md', 'AGENTS.md'] as const) {
      const content = files[name]
      if (content) await client.agents.files.set(agentId, name, content)
    }
    // CLAWBOO.md best-effort (older Gateways reject non-allowlisted filenames).
    if (files['CLAWBOO.md']) {
      try {
        await client.agents.files.set(agentId, 'CLAWBOO.md', files['CLAWBOO.md'])
      } catch {
        /* allowlist rejection — preamble injection delivers it at runtime */
      }
    }

    const db = this.db()
    const now = Date.now()
    db.insert(agents)
      .values({
        id: agentId,
        name: input.name,
        gatewayId: agentId,
        sourceId: 'openclaw',
        sourceAgentId: agentId,
        status: 'idle',
        participantKind: 'agent',
        runtime: 'openclaw',
        teamId: input.teamId ?? null,
        personalityConfig:
          input.personalityConfig != null ? JSON.stringify(input.personalityConfig) : null,
        execConfig: input.execConfig != null ? JSON.stringify(input.execConfig) : null,
        avatarSeed: input.avatarSeed ?? null,
        // Insert-branch only — the conflict `set` is Gateway-owned columns ONLY, so a
        // re-create never re-stamps an existing row's tenant (mirrors upsertFromList).
        tenantId: input.tenantId ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: agents.id,
        set: { name: input.name, gatewayId: agentId, sourceAgentId: agentId, updatedAt: now },
      })
      .run()

    const record = await this.getAgent(agentId)
    if (!record) throw new Error('createAgent: row not found after insert')
    this.emit({ kind: 'agent-upserted', at: now, agent: record })
    return record
  }

  async updateAgent(id: string, patch: UpdateAgentInput): Promise<AgentRecord> {
    const db = this.db()
    const now = Date.now()
    const set: Record<string, unknown> = { updatedAt: now }
    if (patch.teamId !== undefined) set['teamId'] = patch.teamId
    if (patch.personalityConfig !== undefined)
      set['personalityConfig'] =
        patch.personalityConfig != null ? JSON.stringify(patch.personalityConfig) : null
    if (patch.execConfig !== undefined)
      set['execConfig'] = patch.execConfig != null ? JSON.stringify(patch.execConfig) : null
    if (patch.avatarSeed !== undefined) set['avatarSeed'] = patch.avatarSeed
    if (patch.status !== undefined) set['status'] = patch.status
    if (patch.displayName !== undefined) set['name'] = patch.displayName
    db.update(agents).set(set).where(eq(agents.id, id)).run()
    const record = await this.getAgent(id)
    if (!record) throw new Error(`updateAgent: agent ${id} not found`)
    this.emit({ kind: 'agent-upserted', at: now, agent: record })
    return record
  }

  /** Hard delete: remove upstream (requires a live Gateway) + the SQLite row and
   *  its FK children. (The reversible `archivedAt` tombstone is for sync-detected
   *  upstream absence, a different path.) */
  async archiveAgent(id: string): Promise<void> {
    const client = this.requireClient()
    const db = this.db()
    const row = db.select().from(agents).where(eq(agents.id, id)).get()
    const upstreamId = row?.sourceAgentId ?? row?.gatewayId ?? id
    await client.agents.delete(upstreamId)
    db.delete(costRecords).where(eq(costRecords.agentId, id)).run()
    db.delete(approvalHistory).where(eq(approvalHistory.agentId, id)).run()
    db.delete(settings)
      .where(inArray(settings.key, [`boo-zero:display-name:${id}`]))
      .run()
    db.delete(agents).where(eq(agents.id, id)).run()
    this.emit({ kind: 'agent-archived', at: Date.now(), agentId: id })
  }

  // ── Files (delegate to the Gateway) ────────────────────────────────────────

  async readFile(agentId: string, name: AgentFileName): Promise<string> {
    const client = this.requireClient()
    return client.agents.files.read(agentId, name)
  }

  async writeFile(agentId: string, name: AgentFileName, content: string): Promise<void> {
    const client = this.requireClient()
    await client.agents.files.set(agentId, name, content)
  }

  // ── Observability ──────────────────────────────────────────────────────────

  async health(): Promise<HealthResult> {
    const db = this.db()
    const last = getSetting(db, SETTING_LAST_SYNCED)
    return {
      ok: this.connection === 'connected',
      connection: this.connection,
      lastSyncedAt: last ? Number(last) : null,
    }
  }

  events(): AsyncIterable<AgentEvent> {
    const listeners = this.listeners
    return {
      [Symbol.asyncIterator]: () => {
        const queue: AgentEvent[] = []
        let resolveNext: ((r: IteratorResult<AgentEvent>) => void) | null = null
        let done = false
        const listener = (e: AgentEvent): void => {
          if (resolveNext) {
            resolveNext({ value: e, done: false })
            resolveNext = null
          } else {
            queue.push(e)
          }
        }
        listeners.add(listener)
        return {
          next(): Promise<IteratorResult<AgentEvent>> {
            if (queue.length > 0) return Promise.resolve({ value: queue.shift()!, done: false })
            if (done) return Promise.resolve({ value: undefined, done: true })
            return new Promise((resolve) => {
              resolveNext = resolve
            })
          },
          return(): Promise<IteratorResult<AgentEvent>> {
            done = true
            listeners.delete(listener)
            if (resolveNext) {
              resolveNext({ value: undefined, done: true })
              resolveNext = null
            }
            return Promise.resolve({ value: undefined, done: true })
          },
        }
      },
    }
  }
}

// ── Path helpers (server-side; Node could use node:path but these match the
//    browser createAgent.ts semantics exactly). ──
function dirnameLike(p: string): string {
  const idx = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  return idx < 0 ? '' : p.slice(0, idx)
}
function joinPathLike(dir: string, leaf: string): string {
  const sep = dir.includes('\\') ? '\\' : '/'
  const d = dir.endsWith('/') || dir.endsWith('\\') ? dir.slice(0, -1) : dir
  return `${d}${sep}${leaf}`
}
function slugifyName(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug || 'agent'
}
