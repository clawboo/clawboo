// openclaw CapabilitySource — OpenClaw is RUNTIME-OF-RECORD for its own config.
// clawboo reads the Gateway config domain over the SHARED operator connection
// (never a second Gateway connection — the slice is satisfied by
// OpenClawAgentSource) and drives enable/disable through `config.patch` (NEVER by
// editing files). read() degrades to [] + 'gateway_disconnected' when down, so
// the REST layer serves the last good table rows.
//
// CONFIDENCE NOTE: the exact config-domain shape (tools.allow/deny, mcp.servers,
// plugins, Composio connectors, auth-profiles) is read DEFENSIVELY — every field
// is optional-chained, so an unexpected shape yields fewer records, never a
// crash. Confirmed against a running Gateway: config.get returns
// { mcp: { servers } } and writes go through config.patch.

import {
  unsupported,
  type CapabilityReadResult,
  type CapabilityRecord,
  type CapabilitySource,
  type CapabilityWriteAction,
} from '@clawboo/capability-registry'
import { appendAudit, createDb, getCapability, type ClawbooDb } from '@clawboo/db'
import { encodeConfigPatchParams } from '@clawboo/gateway-client'

import { buildRecord, builtinRollup, degradedStatus, okStatus } from './helpers'

/** The operator slice OpenClawAgentSource satisfies as-is (no second connection). */
export interface OperatorConfigClientLike {
  isConnected(): boolean
  operatorCall<T>(method: string, params?: unknown): Promise<T>
}

// Shape CONFIRMED against OpenClaw 2026.5.27's own config docs (gateway/
// config-tools.md + configuration-reference.md): top-level `tools.allow`/
// `tools.deny` (id arrays, deny-wins), top-level `mcp.servers` (named map), and
// `plugins.entries.<id>` (the plugin map) gated by `plugins.allow`/`plugins.deny`.
interface GatewayConfigShape {
  tools?: { allow?: string[]; deny?: string[]; [k: string]: unknown }
  mcp?: { servers?: Record<string, unknown> }
  plugins?:
    | { allow?: string[]; deny?: string[]; entries?: Record<string, unknown>; [k: string]: unknown }
    | Array<{ id: string; enabled?: boolean }>
  [k: string]: unknown
}

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
}

/** Resolve the plugin list + enabled state from the confirmed `plugins.entries`
 *  map gated by `plugins.allow`/`plugins.deny` (an array fallback is tolerated). */
function pluginEntries(
  plugins: GatewayConfigShape['plugins'],
): Array<{ id: string; enabled: boolean }> {
  if (!plugins) return []
  if (Array.isArray(plugins)) {
    return plugins
      .filter((p) => p && typeof p.id === 'string')
      .map((p) => ({ id: p.id, enabled: p.enabled !== false }))
  }
  const allow = asStringArray(plugins.allow)
  const deny = new Set(asStringArray(plugins.deny))
  const allowSet = allow.length > 0 ? new Set(allow) : null
  const ids = plugins.entries ? Object.keys(plugins.entries) : []
  return ids.map((id) => ({ id, enabled: !deny.has(id) && (!allowSet || allowSet.has(id)) }))
}

export class OpenClawCapabilitySource implements CapabilitySource {
  readonly id = 'openclaw' as const

  constructor(
    private readonly deps: { client: OperatorConfigClientLike; getDbPath: () => string },
  ) {}

  private db(): ClawbooDb {
    return createDb(this.deps.getDbPath())
  }

  async read(): Promise<CapabilityReadResult> {
    if (!this.deps.client.isConnected()) {
      return { records: [], status: degradedStatus('openclaw', 'gateway_disconnected') }
    }

    let config: GatewayConfigShape
    try {
      // `config.get` returns a SNAPSHOT WRAPPER — the live config sits under
      // `.config` (older shapes spread it to the top level too). Mirror
      // `registerSharedMcpServers`'s unwrap; reading top-level directly silently
      // misses `mcp.servers` / `tools` / `plugins` (they'd all be undefined),
      // leaving OpenClaw agents with only the "Built-in tools" rollup.
      const snapshot = await this.deps.client.operatorCall<
        { config?: GatewayConfigShape } & GatewayConfigShape
      >('config.get')
      config = (snapshot.config ?? snapshot) as GatewayConfigShape
    } catch (err) {
      return {
        records: [],
        status: degradedStatus('openclaw', err instanceof Error ? err.message : String(err)),
      }
    }

    const records: CapabilityRecord[] = []
    const allow = asStringArray(config.tools?.allow)
    const deny = asStringArray(config.tools?.deny)

    for (const name of allow) {
      records.push(this.toolRecord(name, true))
    }
    for (const name of deny) {
      if (allow.includes(name)) continue
      records.push(this.toolRecord(name, false))
    }

    for (const name of Object.keys(config.mcp?.servers ?? {})) {
      const isClawbooSpine = name.startsWith('clawboo-')
      records.push(
        buildRecord({
          sourceId: 'openclaw',
          runtime: 'openclaw',
          scope: 'global',
          kind: 'connector',
          sourceKey: `mcp:${name}`,
          origin: isClawbooSpine ? 'mcp-connector' : 'openclaw-extension',
          // clawboo's own spine is not user-removable here; other servers are
          // Gateway-owned (runtime-of-record).
          manageability: isClawbooSpine ? 'observe-only' : 'runtime-of-record',
          name,
          description: isClawbooSpine
            ? 'clawboo MCP server (Gateway-registered)'
            : 'Gateway MCP server',
          available: true,
          status: 'ready',
          // write() can only toggle tools.allow/deny today; an mcp connector's
          // config.patch is a follow-up, so it's NOT writable — no dead button.
          writable: false,
        }),
      )
    }

    for (const plugin of pluginEntries(config.plugins)) {
      records.push(
        buildRecord({
          sourceId: 'openclaw',
          runtime: 'openclaw',
          scope: 'global',
          kind: 'connector',
          sourceKey: `plugin:${plugin.id}`,
          origin: 'openclaw-extension',
          manageability: 'runtime-of-record',
          name: plugin.id,
          description: 'OpenClaw plugin',
          available: true,
          status: plugin.enabled ? 'ready' : 'disabled',
          // Plugin enable/disable via config.patch is a follow-up — not writable yet.
          writable: false,
        }),
      )
    }

    records.push(builtinRollup('openclaw', 'openclaw', 'OpenClaw'))
    return { records, status: okStatus('openclaw') }
  }

  private toolRecord(name: string, enabled: boolean): CapabilityRecord {
    return buildRecord({
      sourceId: 'openclaw',
      runtime: 'openclaw',
      scope: 'global',
      kind: 'tool',
      sourceKey: name,
      origin: 'openclaw-extension',
      manageability: 'runtime-of-record',
      name,
      description: 'OpenClaw Gateway tool',
      available: true,
      status: enabled ? 'ready' : 'disabled',
    })
  }

  async write(action: CapabilityWriteAction): Promise<CapabilityRecord | null> {
    if (action.kind === 'install') unsupported('openclaw', action.kind)
    if (!this.deps.client.isConnected()) throw new Error('gateway_disconnected')

    const row = getCapability(this.db(), action.id)
    if (!row) unsupported('openclaw', action.kind)
    // Only the Gateway tools.allow/deny surface is a confirmed runtime-of-record
    // write; mcp/plugin enable/disable through config.patch is a documented
    // follow-up (needs the live-spike-confirmed plugin config shape).
    if (row.origin !== 'openclaw-extension' || row.kind !== 'tool') {
      unsupported('openclaw', action.kind)
    }
    const enable = action.kind === 'enable'
    const config = await this.deps.client.operatorCall<
      GatewayConfigShape & { hash?: string; baseHash?: string }
    >('config.get')
    const tools = { ...(config.tools ?? {}) }
    const allow = new Set(asStringArray(tools.allow))
    const deny = new Set(asStringArray(tools.deny))
    if (enable) {
      allow.add(row.sourceKey)
      deny.delete(row.sourceKey)
    } else {
      deny.add(row.sourceKey)
      allow.delete(row.sourceKey)
    }
    tools.allow = [...allow]
    tools.deny = [...deny]
    // OpenClaw 2026.5.x's `config.patch` wants a `{ raw: <json>, baseHash }`
    // envelope (it deep-merges the parsed partial + enforces the snapshot hash) —
    // `encodeConfigPatchParams` does the wire encoding, carrying the hash from the
    // `config.get` above. The full allow/deny arrays are re-asserted, so the merge
    // replaces them wholesale (the intended set), not appends.
    await this.deps.client.operatorCall(
      'config.patch',
      encodeConfigPatchParams({ tools }, config.hash ?? config.baseHash),
    )
    appendAudit(this.db(), {
      eventType: 'install',
      summary: { action: action.kind, capability: row.name, runtime: 'openclaw' },
    })
    return null
  }
}
