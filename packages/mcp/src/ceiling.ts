// One size ceiling, built the same way for every clawboo MCP server.
//
// WHY ONLY THE TOOLS SERVER USES IT. The ceiling cuts a head and a tail out of a
// result and splices a notice between them, which is right for the arbitrary text
// a connector returns and wrong for a JSON document. The tasks, memory and
// teamchat servers answer with `jsonResult` throughout, and a trimmed JSON array
// is not a smaller answer, it is an unparseable one: wiring the ceiling into
// those three broke `list_tasks` on the first run, which is exactly the failure
// it would have caused in production for anything parsing that payload.
//
// Those three bound themselves the way a structured API should, with their own
// `limit` arguments. The tools server is the one that hands over whatever a
// remote server said, which is why it is the one that needs a ceiling, and it is
// also where the measured problem was.

import { buildCeilingView, putToolResult, type ClawbooDb } from '@clawboo/db'

import type { ResultCeiling } from './shared'

/**
 * How many bytes one tool result may occupy in a model's context.
 *
 * A STATIC DEFAULT, and deliberately so. Scaling this to the model's context
 * window would be better, and clawboo cannot: only the native and claude-code
 * adapters declare a window at all, and an OpenClaw session is unbound by
 * construction, so it carries no agent identity to resolve a model from. A
 * number that silently means "the floor" on four of five runtimes is worse than
 * a number that plainly is one.
 *
 * 16 KiB is roughly 4,300 tokens at the 3.785 bytes-per-token measured on a real
 * install. It is above anything an ordinary tool returns and below the runaway
 * results that motivated this: the inbox search that came back 16,822 bytes and
 * took 19% of that request's whole prompt is the case this is sized to catch.
 */
export const DEFAULT_TOOL_RESULT_BUDGET_BYTES = 16 * 1024

export interface CeilingContext {
  agentId?: string | null
  tenantId?: string | null
  budgetBytes?: number
}

/** The ceiling to hand `buildServer`. */
export function makeResultCeiling(db: ClawbooDb, ctx: CeilingContext = {}): ResultCeiling {
  const budgetBytes = ctx.budgetBytes ?? DEFAULT_TOOL_RESULT_BUDGET_BYTES
  return {
    budgetBytes,
    bound: (toolName, text, budget) => {
      if (new TextEncoder().encode(text).length <= budget) return text
      // Stored FIRST, so the trim below is lossless by reference. A store failure
      // is not fatal: the view still cuts, and its notice then says honestly that
      // nothing is retrievable rather than handing out a handle that resolves to
      // nothing.
      let handle: string | null = null
      try {
        handle = putToolResult(db, {
          toolName,
          agentId: ctx.agentId ?? null,
          tenantId: ctx.tenantId ?? null,
          text,
        }).handle
      } catch {
        handle = null
      }
      return buildCeilingView(text, { budgetBytes: budget, handle, toolName }).text
    },
  }
}
