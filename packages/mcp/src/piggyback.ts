// Inbox piggyback — mid-run delivery over the MCP surface, for EVERY runtime.
// A running agent has no inbox stream, but it DOES call clawboo's MCP tools;
// appending its undelivered mailbox rows to the next tool response gets a peer
// update into its context within one tool call, with zero new transport. The
// update rides as a SECOND content block, so a first block that callers
// machine-parse (JSON) is untouched — and tools whose whole output is parsed
// by code (`team_chat_subscribe`) are skipped outright.
//
// Delivery is exactly-once across channels: `markInboxDelivered` only returns
// the rows THIS channel won, so a digest racing a piggyback can't double-render.

import { listUndeliveredInbox, markInboxDelivered, type ClawbooDb } from '@clawboo/db'

import type { ToolDef } from './shared'

const PIGGYBACK_LIMIT = 5

/** Wrap `tools` so each successful call appends the bound agent's undelivered
 *  mailbox rows as a trailing content block (and marks them delivered). */
export function withInboxPiggyback(
  tools: ToolDef[],
  db: ClawbooDb,
  agentId: string,
  skipNames: ReadonlySet<string>,
): ToolDef[] {
  return tools.map((tool) => {
    if (skipNames.has(tool.name)) return tool
    return {
      ...tool,
      handler: async (args: Record<string, unknown>) => {
        const res = await tool.handler(args)
        if (res.isError) return res
        try {
          const rows = listUndeliveredInbox(db, agentId, { limit: PIGGYBACK_LIMIT })
          if (rows.length === 0) return res
          const wonIds = new Set(
            markInboxDelivered(
              db,
              rows.map((r) => r.id),
              'mcp',
            ),
          )
          const won = rows.filter((r) => wonIds.has(r.id))
          if (won.length === 0) return res
          return {
            ...res,
            content: [
              ...res.content,
              {
                type: 'text' as const,
                // Leading newlines: consumers that flatten blocks by plain
                // concatenation (the native bridge) still render a clean break
                // after a JSON first block.
                text: `\n\n[team updates — delivered with this tool result]\n${won
                  .map((r) => `- ${r.body}`)
                  .join('\n')}`,
              },
            ],
          }
        } catch {
          return res // delivery is best-effort; the tool result must never break
        }
      },
    }
  })
}
