import pino from 'pino'

import { redactObject } from './redact'

// `process` is undefined in the browser. `@clawboo/logger` is server-oriented but
// reaches the browser bundle transitively (e.g. `@clawboo/gateway-client` imports
// it), and `pino` itself ships a browser shim — so the ONLY thing that would crash
// a browser import is reading `process.env` at module-eval time. Read it once
// behind a `typeof` guard; in the browser this is an empty object and the logger
// falls back to its defaults (no pino-pretty transport).
const env: Record<string, string | undefined> =
  typeof process !== 'undefined' && process.env ? process.env : {}

// Log level defaults to `info` (production-appropriate; `debug` is too noisy for a
// shipped product). Overridable per-process via the standard LOG_LEVEL env var.
const LOG_LEVEL = env['LOG_LEVEL']?.trim() || 'info'

export const logger = pino({
  name: 'clawboo',
  level: LOG_LEVEL,
  // Redact credential-looking keys/values from EVERY log record (defense in depth
  // alongside the storage-layer scrub + the API-response redaction). Numeric token
  // counts and cost survive — see redact.ts SAFE_COUNT_KEYS.
  formatters: {
    log(obj: Record<string, unknown>): Record<string, unknown> {
      return redactObject(obj)
    },
  },
  transport:
    env['NODE_ENV'] !== 'production'
      ? { target: 'pino-pretty', options: { colorize: true } }
      : undefined,
})

export const createLogger = (module: string) => logger.child({ module })

export type Logger = ReturnType<typeof logger.child>

export { redactObject, redactValue, redactJsonString, REDACTION_MASK } from './redact'
