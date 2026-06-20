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

export interface McpToolResult {
  content: { type: 'text'; text: string }[]
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

export function jsonResult(value: unknown, isError = false): McpToolResult {
  return textResult(JSON.stringify(value, null, 2), isError)
}

export interface ToolDef {
  name: string
  description: string
  /** A ZodObject describing the tool's params. Used for validation + JSON Schema. */
  inputSchema: z.ZodObject<z.ZodRawShape>
  handler: (args: Record<string, unknown>) => Promise<McpToolResult> | McpToolResult
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
export function buildServer(name: string, tools: ToolDef[]): Server {
  const server = new Server({ name, version: MCP_SERVER_VERSION }, { capabilities: { tools: {} } })

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: zodObjectToJsonSchema(t.inputSchema),
    })),
  }))

  server.setRequestHandler(CallToolRequestSchema, async (req): Promise<CallToolResult> => {
    const tool = tools.find((t) => t.name === req.params.name)
    if (!tool) return textResult(`unknown tool: ${req.params.name}`, true) as CallToolResult
    const parsed = tool.inputSchema.safeParse(req.params.arguments ?? {})
    if (!parsed.success)
      return textResult(`invalid args: ${parsed.error.message}`, true) as CallToolResult
    const result = await tool.handler(parsed.data as Record<string, unknown>)
    return result as CallToolResult
  })

  return server
}

export type { Server }
