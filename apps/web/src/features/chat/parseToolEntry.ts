// Pure parser for `[[tool]]` / `[[tool-result]]` markdown lines emitted by
// `@clawboo/protocol`'s `formatToolCallMarkdown` / `formatToolResultMarkdown`.
//
// Kept in its own module (no React imports) so it can be reused outside the
// renderer without pulling in the component tree from `chatComponents.tsx`.

export interface ParsedToolEntry {
  kind: 'call' | 'result'
  /**
   * The tool identifier emitted by the protocol — typically `"<tool_name>"`
   * or `"<tool_name> (<call_id>)"`. Callers that need just the tool name
   * should `name.split(' ')[0]` (e.g. `sessions_send` from
   * `"sessions_send (call_abc)"`).
   */
  name: string
  /**
   * Everything after the tool-name line. For `kind === 'call'` this is the
   * fenced JSON params block. For `kind === 'result'` this is the tool's
   * stringified return value.
   */
  body: string
}

/** Parse [[tool]] / [[tool-result]] lines from the protocol. */
export function parseToolEntry(text: string): ParsedToolEntry | null {
  const isCall = text.startsWith('[[tool]]')
  const isResult = text.startsWith('[[tool-result]]')
  if (!isCall && !isResult) return null
  const prefix = isCall ? '[[tool]]' : '[[tool-result]]'
  const rest = text.slice(prefix.length)
  const nl = rest.indexOf('\n')
  const name = (nl === -1 ? rest : rest.slice(0, nl)).trim()
  const body = nl === -1 ? '' : rest.slice(nl + 1).trim()
  return { kind: isCall ? 'call' : 'result', name, body }
}
