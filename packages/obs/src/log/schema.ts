// Structured JSON log entry — the runtime-observability shape from the
// observability discipline (component/action/durationMs/input/output/error +
// correlation ids). Machine-parseable so root cause is a deterministic lookup,
// not a console-scroll. The server emits these through the existing pino logger
// (a thin typed wrapper) only on gated paths; secrets are scrubbed before emit.

import { z } from 'zod'

export const logLevelSchema = z.enum(['debug', 'info', 'warn', 'error'])
export type LogLevel = z.infer<typeof logLevelSchema>

export const structuredLogEntrySchema = z.object({
  ts: z.number().int(),
  level: logLevelSchema,
  component: z.string(),
  action: z.string(),
  durationMs: z.number().optional(),
  input: z.unknown().optional(),
  output: z.unknown().optional(),
  error: z.string().optional(),
  correlationId: z.string(),
  traceId: z.string().nullish(),
  spanId: z.string().nullish(),
  taskId: z.string().nullish(),
  agentId: z.string().nullish(),
  runtime: z.string().nullish(),
})

export type StructuredLogEntry = z.infer<typeof structuredLogEntrySchema>
