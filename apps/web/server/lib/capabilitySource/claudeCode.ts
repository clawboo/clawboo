// claude-code CapabilitySource — Claude Code runs against the user's real
// ~/.claude (clawboo injects mcpServers per query(), never reads .claude/skills;
// the system:init event carries only session_id+model). So clawboo has NO
// persistent Claude store to manage: it surfaces the clawboo-attached MCP servers
// + Claude's built-ins, both `observe-only`. write() → unsupported.

import {
  unsupported,
  type CapabilityReadResult,
  type CapabilityRecord,
  type CapabilitySource,
  type CapabilityWriteAction,
} from '@clawboo/capability-registry'
import { MCP_SERVER_NAMES } from '@clawboo/mcp'

import { buildRecord, builtinRollup, okStatus } from './helpers'

export class ClaudeCodeCapabilitySource implements CapabilitySource {
  readonly id = 'claude-code' as const

  async read(): Promise<CapabilityReadResult> {
    const records: CapabilityRecord[] = MCP_SERVER_NAMES.map((server) =>
      buildRecord({
        sourceId: 'claude-code',
        runtime: 'claude-code',
        scope: 'global',
        kind: 'connector',
        sourceKey: `mcp:clawboo-${server}`,
        origin: 'mcp-connector',
        manageability: 'observe-only',
        name: `clawboo-${server}`,
        description: 'clawboo MCP server attached to every Claude Code run',
        available: true,
        status: 'ready',
      }),
    )
    records.push(builtinRollup('claude-code', 'claude-code', 'Claude Code'))
    return { records, status: okStatus('claude-code') }
  }

  async write(action: CapabilityWriteAction): Promise<CapabilityRecord | null> {
    unsupported('claude-code', action.kind)
  }
}
