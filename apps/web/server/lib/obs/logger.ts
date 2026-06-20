// Structured JSON logging — the runtime-observability log shape, emitted through
// the existing pino logger (a thin typed wrapper; the base @clawboo/logger and its
// existing call sites are NOT modified). Used by the observability emit paths —
// notably the HARNESS-BUG alert when an unknown error class is seen. Secrets are scrubbed
// before the entry is logged.

import { scrubSecrets } from '@clawboo/db'
import { createLogger } from '@clawboo/logger'
import { structuredLogEntrySchema, type StructuredLogEntry } from '@clawboo/obs'

const log = createLogger('obs')

type LogInput = Omit<StructuredLogEntry, 'ts'> & { ts?: number }

/** Emit a validated, secret-scrubbed structured log entry. */
export function logStructured(entry: LogInput): void {
  const safe = scrubSecrets({ ...entry, ts: entry.ts ?? Date.now() })
  const parsed = structuredLogEntrySchema.safeParse(safe)
  const payload: StructuredLogEntry = parsed.success ? parsed.data : (safe as StructuredLogEntry)
  log[payload.level](payload)
}

/** Convenience: surface a classified harness bug as an error-level alert. */
export function alertHarnessBug(args: {
  component: string
  correlationId: string
  errorClass: string
  message: string
  taskId?: string | null
  agentId?: string | null
  runtime?: string | null
}): void {
  logStructured({
    level: 'error',
    component: args.component,
    action: 'harness_bug',
    error: `[${args.errorClass}] ${args.message}`,
    correlationId: args.correlationId,
    taskId: args.taskId ?? null,
    agentId: args.agentId ?? null,
    runtime: args.runtime ?? null,
  })
}
