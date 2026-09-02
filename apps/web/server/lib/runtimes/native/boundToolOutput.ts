// Bound one native tool result before it enters the model transcript.
//
// WHY THIS EXISTS SEPARATELY. Every other clawboo tool result crosses the MCP
// seam, where a single ceiling in `packages/mcp` stores the full bytes and hands
// back a bounded view. The native runtime's LOCAL tools never cross it: they are
// dispatched in-process, so they were the one path with no limit at all. That is
// not theoretical, `list_files` returns one line per directory entry with no cap,
// so a single call against a dependency directory could put a hundred thousand
// lines into a prompt that is then re-sent on every turn.
//
// Same contract as the MCP ceiling, deliberately: store whole, show a bounded
// view, and put the handle plus the literal next call in the notice. A truncation
// that cannot be undone is a silent lie, because the model reads the surviving
// prefix as the complete answer.

import { buildCeilingView, putToolResult, type ClawbooDb } from '@clawboo/db'

/**
 * Bytes one local tool result may occupy.
 *
 * Matches the MCP seam's default so a tool does not behave differently depending
 * on which side of the process boundary it happens to live on.
 */
const LOCAL_RESULT_BUDGET_BYTES = 16 * 1024

/** Store the full result and return the bounded view, or the text unchanged. */
export function boundToolOutput(db: ClawbooDb, toolName: string, text: string): string {
  if (new TextEncoder().encode(text).length <= LOCAL_RESULT_BUDGET_BYTES) return text
  // Stored FIRST, so the trim below is recoverable. A store failure is not fatal:
  // the view still cuts, and its notice then says honestly that nothing can be
  // retrieved rather than handing out a handle that resolves to nothing.
  let handle: string | null = null
  try {
    handle = putToolResult(db, { toolName, text }).handle
  } catch {
    handle = null
  }
  return buildCeilingView(text, { budgetBytes: LOCAL_RESULT_BUDGET_BYTES, handle, toolName }).text
}
