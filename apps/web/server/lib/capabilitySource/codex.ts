// codex CapabilitySource — Codex's home is an ephemeral per-run mkdtemp, and its
// connector writes are live-blocked until interactive `codex login` (the 0.136
// Responses-API-over-WS auth — a raw key isn't attached). So clawboo surfaces the
// clawboo-attached MCP servers as `external-write` BUT with
// status:'manageable-but-pending-auth' — REAL + manageable in principle, just
// auth-blocked (the dashboard renders a disabled "pending auth — run codex login"
// row). Built-ins are observe-only. write() → unsupported (no durable home + auth).

import {
  unsupported,
  type CapabilityReadResult,
  type CapabilityRecord,
  type CapabilitySource,
  type CapabilityWriteAction,
} from '@clawboo/capability-registry'
import { MCP_SERVER_NAMES } from '@clawboo/mcp'

import { buildRecord, builtinRollup, okStatus } from './helpers'

export class CodexCapabilitySource implements CapabilitySource {
  readonly id = 'codex' as const

  async read(): Promise<CapabilityReadResult> {
    const records: CapabilityRecord[] = MCP_SERVER_NAMES.map((server) =>
      buildRecord({
        sourceId: 'codex',
        runtime: 'codex',
        scope: 'global',
        kind: 'connector',
        sourceKey: `mcp:clawboo-${server}`,
        origin: 'mcp-connector',
        manageability: 'external-write',
        name: `clawboo-${server}`,
        description: 'clawboo MCP server (Codex stdio attach)',
        available: true,
        status: 'manageable-but-pending-auth',
        // The auth affordance rides the record, so the panel never hardcodes it.
        hint: 'pending auth — run `codex login`',
      }),
    )
    records.push(builtinRollup('codex', 'codex', 'Codex'))
    return { records, status: okStatus('codex') }
  }

  async write(action: CapabilityWriteAction): Promise<CapabilityRecord | null> {
    // External-write in principle, but the live write is auth-blocked (codex
    // login) + the home is ephemeral — surfaced as pending-auth in the UI, which
    // disables the action. Defense-in-depth: refuse here too.
    unsupported('codex', action.kind)
  }
}
