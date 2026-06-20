// Neutral, clawboo-native registry record types. These are the shapes the rest of
// the codebase reads (via `AgentSource` / the `/api/agents` REST surface) — NOT the
// OpenClaw protocol shapes. `OpenClawAgentSource` adapts the Gateway in both
// directions. Each field is documented with its source-of-truth: Gateway-synced
// (overwritten on every sync) vs SQLite-native (clawboo-owned, preserved across
// re-sync). The `participantKind`, `runtime`, and `tenantId` fields are open-set /
// dormant seams for future sessions (human teammates, native runtime, multi-tenant).

/** Open-set participant kind. 'human' is a dormant seam (no human path yet). */
export type ParticipantKind = 'agent' | 'human'

/** Open-set runtime id. 'openclaw' is the only live value today. */
export type RuntimeId = 'openclaw' | 'claude-code' | 'codex' | 'hermes' | (string & {})

/** clawboo-native agent status. Superset of the Gateway's AgentStatus, plus the
 *  'archived' tombstone clawboo owns. */
export type AgentRecordStatus = 'idle' | 'running' | 'error' | 'sleeping' | 'archived'

export interface AgentRecord {
  // ── Identity ────────────────────────────────────────────────
  /** clawboo's stable PK. In Phase A == sourceAgentId (one source) but logically distinct. SQLite-native. */
  id: string
  /** Which AgentSource owns the upstream record. SQLite-native (set at sync). */
  sourceId: RuntimeId
  /** Upstream id within that source (== the OpenClaw agent id). Gateway-synced. */
  sourceAgentId: string

  // ── Display (merged) ────────────────────────────────────────
  /** Resolved name: Boo-Zero override (settings) ▸ Gateway identity.name ▸ Gateway name ▸ id. */
  displayName: string
  /** Gateway identity emoji. Gateway-synced. */
  emoji: string | null
  /** Gateway identity avatar URL. Gateway-synced. */
  avatarUrl: string | null
  /** boo-avatar generation seed. SQLite-native. */
  avatarSeed: string | null

  // ── Live runtime state (Gateway-synced; may be stale when the connection is down) ──
  status: AgentRecordStatus
  /** Session key for the agent's main session. Gateway-synced (defaultId agent uses mainKey). */
  sessionKey: string | null
  /** true when sourceAgentId === the source's defaultId (Boo Zero). Gateway-synced. */
  isDefault: boolean

  // ── clawboo-native config (SQLite-native, preserved across re-sync) ──
  teamId: string | null
  personalityConfig: unknown | null
  execConfig: unknown | null

  // ── Classification (dormant seams) ──────────────────────────
  participantKind: ParticipantKind
  runtime: RuntimeId
  capabilities: unknown | null
  /** Multi-tenant seam — null = single implicit tenant. */
  tenantId: string | null

  // ── Lifecycle ───────────────────────────────────────────────
  /** Soft-delete tombstone (epoch ms). null = live. SQLite-native. */
  archivedAt: number | null
  createdAt: number
  updatedAt: number
}

export interface TeamRecord {
  id: string
  name: string
  icon: string
  color: string
  colorCollectionId: string | null
  templateId: string | null
  leaderAgentId: string | null
  isArchived: boolean
  /** Computed member count (mirrors the existing teamsGET subquery). */
  agentCount: number
  /** Multi-tenant seam — null = single implicit tenant. */
  tenantId: string | null
  createdAt: number
  updatedAt: number
}

export interface SessionRecord {
  id: string
  sourceId: RuntimeId
  /** Upstream session id (the OpenClaw session key). */
  sourceSessionId: string
  agentId: string
  teamId: string | null
  status: 'active' | 'idle' | 'closed'
  createdAt: number | null
  updatedAt: number | null
}
