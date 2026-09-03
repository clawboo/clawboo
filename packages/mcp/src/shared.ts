// ─── Shared MCP server helpers ──────────────────────────────────────────────
// Centralises every @modelcontextprotocol/sdk touchpoint. We use the LOW-LEVEL
// `Server` + setRequestHandler API rather than `McpServer.registerTool`: the
// high-level API's per-tool zod-generic inference OOMs tsc (and the tsup `dts`
// build) once a server has a dozen tools. The low-level API uses plain types,
// so we validate args ourselves (zod) and emit JSON Schema for tools/list via a
// small self-contained converter (no extra dep).

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js'
import { z, type ZodTypeAny } from 'zod'

export const MCP_SERVER_VERSION = '0.1.0'

/** One block of an MCP tool result. Text is the common case; `image` exists so a
 *  tool whose whole job is to look at something can hand back what it saw. */
export type McpContentBlock =
  { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }

export interface McpToolResult {
  content: McpContentBlock[]
  isError?: boolean
  /** MCP-spec metadata channel (survives the in-memory + HTTP transports). Used to
   *  carry a TYPED denial reason — a broker policy Deny — to the caller without
   *  scraping the text, so a consumer (the native harness) can surface a
   *  `policy_denied` signal for the circuit breaker. */
  _meta?: Record<string, unknown>
}

/** Build a text tool result. `denied` (a broker policy-denial reason) rides the
 *  `_meta` metadata channel so the in-process caller can detect a denial without
 *  parsing prose. */
export function textResult(text: string, isError = false, denied?: string): McpToolResult {
  const result: McpToolResult = { content: [{ type: 'text', text }], isError }
  if (denied) result._meta = { denied }
  return result
}

/**
 * A tool result carrying images alongside its text.
 *
 * MCP content is an ARRAY of blocks, so an image needs no encoding tricks: the
 * text block stays first (it is what a text-only client reads), and the image
 * blocks follow for a client that can see them. Falls back to `textResult` when
 * there are no images, so the wire shape is unchanged for every existing tool.
 */
export function mediaResult(
  text: string,
  images: readonly { data: string; mimeType: string }[],
  isError = false,
  denied?: string,
): McpToolResult {
  if (images.length === 0) return textResult(text, isError, denied)
  const result: McpToolResult = {
    content: [
      { type: 'text', text },
      ...images.map((img) => ({ type: 'image' as const, data: img.data, mimeType: img.mimeType })),
    ],
    isError,
  }
  if (denied) result._meta = { denied }
  return result
}

export function jsonResult(value: unknown, isError = false): McpToolResult {
  return textResult(JSON.stringify(value, null, 2), isError)
}

export interface ToolDef {
  name: string
  description: string
  /** A ZodObject describing the tool's params. Used for validation + JSON Schema. */
  inputSchema: z.ZodObject<z.ZodRawShape>
  /**
   * A pre-built JSON Schema to ADVERTISE instead of deriving one from
   * `inputSchema`.
   *
   * A tool discovered from a remote MCP server arrives as JSON Schema and never
   * as zod, and the derivation below understands six leaf kinds and falls back
   * to `{}` for everything else. Round-tripping such a schema through zod would
   * therefore silently widen it: an enum becomes a string, a constrained object
   * becomes unconstrained, and the model is handed a contract looser than the
   * one the server will actually enforce.
   *
   * `inputSchema` is still REQUIRED when this is set, because it is what
   * validates arguments locally. A connector tool supplies a permissive
   * passthrough there: the remote server is the authority on its own arguments,
   * and re-deriving a stricter local guess would reject calls the server would
   * have accepted.
   */
  jsonSchema?: Record<string, unknown>
  /**
   * This tool's result is PARSED BY CODE, so it must never be trimmed.
   *
   * The size ceiling below cuts a head and a tail out of an oversized result and
   * splices a notice between them, which is right for text a model reads and
   * fatal for a payload something calls `JSON.parse` on. The native harness reads
   * `team_chat_subscribe` exactly that way, inside a try/catch whose only job is
   * to keep a subscribe failure from breaking the run: a trimmed result there
   * throws, is swallowed, and the peer cursor silently stops advancing, so peer
   * messages stop arriving with nothing anywhere reporting a fault.
   *
   * A tool that sets this owns its own size. It has to bound its result with its
   * own paging arguments, because nothing downstream will do it.
   */
  structuredResult?: boolean
  handler: (args: Record<string, unknown>) => Promise<McpToolResult> | McpToolResult
}

/**
 * Bound an oversized tool result before it reaches a model.
 *
 * Supplied by the composing server, which is what owns a database and can store
 * the full bytes. Absent means no ceiling, so a server built without one behaves
 * exactly as it did before this existed.
 */
export interface ResultCeiling {
  /**
   * TEXT bytes a single tool result may occupy in the model's context.
   *
   * Text only, and deliberately: `bound` is applied per content block and only
   * where `type === 'text'`, so image blocks pass through untouched. Trimming
   * base64 does not make a smaller image, it makes a corrupt one, so images
   * carry their own caps at the connector client (`MAX_IMAGES_PER_CALL`,
   * `MAX_IMAGE_B64_BYTES`) instead of sharing this budget. The two are not
   * comparable anyway: a screenshot costs a vision model on the order of a
   * thousand tokens, not the hundreds of thousands its byte count implies.
   */
  budgetBytes: number
  /** Store the full text and return a bounded view of it. */
  bound: (toolName: string, text: string, budgetBytes: number) => string
}

// ─── Minimal zod → JSON Schema (covers the primitives our tools use) ─────────

function leafToJson(schema: ZodTypeAny): { json: Record<string, unknown>; optional: boolean } {
  if (schema instanceof z.ZodOptional || schema instanceof z.ZodDefault) {
    const inner = leafToJson((schema._def as { innerType: ZodTypeAny }).innerType)
    return { json: inner.json, optional: true }
  }
  if (schema instanceof z.ZodString) return { json: { type: 'string' }, optional: false }
  if (schema instanceof z.ZodBoolean) return { json: { type: 'boolean' }, optional: false }
  if (schema instanceof z.ZodNumber) {
    const checks = (schema._def as { checks?: { kind: string }[] }).checks ?? []
    const isInt = checks.some((c) => c.kind === 'int')
    return { json: { type: isInt ? 'integer' : 'number' }, optional: false }
  }
  if (schema instanceof z.ZodEnum) {
    return {
      json: { type: 'string', enum: (schema._def as { values: string[] }).values },
      optional: false,
    }
  }
  if (schema instanceof z.ZodArray) {
    const items = leafToJson((schema._def as { type: ZodTypeAny }).type).json
    return { json: { type: 'array', items }, optional: false }
  }
  return { json: {}, optional: false } // fallback: unconstrained
}

export function zodObjectToJsonSchema(obj: z.ZodObject<z.ZodRawShape>): {
  type: 'object'
  properties: Record<string, unknown>
  required?: string[]
} {
  const properties: Record<string, unknown> = {}
  const required: string[] = []
  for (const [key, sub] of Object.entries(obj.shape)) {
    const { json, optional } = leafToJson(sub as ZodTypeAny)
    properties[key] = json
    if (!optional) required.push(key)
  }
  return { type: 'object' as const, properties, ...(required.length ? { required } : {}) }
}

/**
 * Build a low-level MCP Server that lists `tools` and dispatches tools/call to
 * the matching handler (validating args with the tool's zod schema first).
 */
/**
 * A live tool list, or a fixed one.
 *
 * A function is what makes `listChanged` mean anything: the list has to be
 * recomputed when a client re-lists, or the notification tells it to go and
 * fetch the same stale array again.
 */
export type ToolSource = ToolDef[] | (() => ToolDef[])

export function buildServer(
  name: string,
  toolsOrSource: ToolSource,
  ceiling?: ResultCeiling,
): Server {
  const readTools = (): ToolDef[] =>
    typeof toolsOrSource === 'function' ? toolsOrSource() : toolsOrSource
  // `listChanged: true` is a CAPABILITY DECLARATION, not a promise that we push
  // on every change: a client that does not see it will never listen, so it must
  // be declared before any notification can matter. Without it, a connector
  // granted mid-session stays invisible to an attached runtime until it
  // reconnects, and a revoked one keeps being called until the model gives up.
  const server = new Server(
    { name, version: MCP_SERVER_VERSION },
    { capabilities: { tools: { listChanged: true } } },
  )

  // Dispatch below is `tools.find(...)`: FIRST match wins, silently. That is
  // fine while every ToolDef is ours, and becomes a shadowing bug the moment a
  // third-party tool set is composed in: the duplicate would render in tools/list
  // and never be the one that runs. Assert uniqueness here, at the seam where a
  // duplicate can first be introduced, rather than discovering it at call time.
  // Checked against the list AS IT IS AT BUILD TIME. A live source can change
  // afterwards, and the composer that feeds it is responsible for not producing
  // duplicates -- this catches the static mistake, which is the common one.
  const seen = new Set<string>()
  for (const t of readTools()) {
    if (seen.has(t.name)) {
      throw new Error(
        `duplicate MCP tool name "${t.name}" in server "${name}": ` +
          'namespace one of them before composing the tool set.',
      )
    }
    seen.add(t.name)
  }

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: readTools().map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.jsonSchema ?? zodObjectToJsonSchema(t.inputSchema),
    })),
  }))

  server.setRequestHandler(CallToolRequestSchema, async (req): Promise<CallToolResult> => {
    // Resolved at CALL time, not at build time. A tool that appeared after this
    // session started has to be callable, and one that disappeared has to stop
    // being callable, or `listChanged` would advertise a list the dispatcher
    // could not honour.
    const tool = readTools().find((t) => t.name === req.params.name)
    if (!tool) return textResult(`unknown tool: ${req.params.name}`, true) as CallToolResult
    const parsed = tool.inputSchema.safeParse(req.params.arguments ?? {})
    if (!parsed.success)
      return textResult(`invalid args: ${parsed.error.message}`, true) as CallToolResult
    const result = await tool.handler(parsed.data as Record<string, unknown>)

    // THE ONE PLACE EVERY RUNTIME CROSSES. Native reaches this over the in-memory
    // transport and openclaw, claude-code, codex and hermes over Streamable HTTP,
    // for every tool on every clawboo MCP server, so a ceiling here cannot be
    // forgotten at a call site the way a per-tool or per-runtime one can.
    //
    // Applied per CONTENT BLOCK rather than to a joined string, so a multi-block
    // result keeps its block structure, and skipped entirely for a tool whose
    // result is machine-parsed (see `structuredResult`).
    if (ceiling && !tool.structuredResult && !result.isError) {
      for (const block of result.content) {
        if (block.type === 'text') {
          block.text = ceiling.bound(tool.name, block.text, ceiling.budgetBytes)
        }
      }
    }
    return result as CallToolResult
  })

  return server
}

export type { Server }
