// The reason a failed Codex run reports, shared by the app-server driver and the
// `codex exec` fallback.
//
// The backend decides which models a ChatGPT login may use, and it refuses the
// rest with "The '<model>' model is not supported when using Codex with a ChatGPT
// account". A run that pinned no model and still got that refusal ran the CLI's
// OWN default: the CLI predates the account's current models (an old CLI cannot
// decode the live list and falls back to the catalog it shipped with), so the fix
// is updating it. The message says so instead of passing on a log line.

import { ownedRuntimeBin } from '../runtimeFolder'
import { getDescriptor } from './descriptor'

const asRecord = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
const asStr = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() ? v : undefined

/** A stream error's readable text. The CLI forwards the backend's response body as
 *  a JSON STRING (`{"type":"error","status":400,"error":{"message":"…"}}`); keep its
 *  `error.message`, else the string as given. */
export function backendErrorText(raw: string): string {
  try {
    const body = asRecord(JSON.parse(raw))
    return asStr(asRecord(body?.['error'])?.['message']) ?? asStr(body?.['message']) ?? raw
  } catch {
    return raw
  }
}

/** The backend's refusal of a model for a ChatGPT-subscription login. */
const MODEL_REFUSED_RE = /model is not supported when using Codex with a ChatGPT account/i

/**
 * The reason a failed run reports. The run's own error (the JSON stream's, or the
 * app-server's turn error) wins over stderr, which is the CLI's log and can bury
 * the cause under unrelated lines; `fallback` (default: the exit code) is the last
 * resort. A refused model is explained: a pinned one points at the model, an
 * unpinned one at updating the CLI.
 */
export function codexFailureMessage(opts: {
  streamError?: string | null
  stderr: string
  code?: number | null
  /** Used when there is neither a run error nor stderr. */
  fallback?: string
  modelPinned: boolean
}): string {
  const streamError = opts.streamError ? backendErrorText(opts.streamError).trim() : ''
  const reason =
    streamError || opts.stderr.trim() || opts.fallback || `codex exited with code ${opts.code}`
  if (!MODEL_REFUSED_RE.test(reason)) return reason
  if (opts.modelPinned) {
    return `${reason} Pick a model your ChatGPT plan offers, or clear the model to use the plan's default.`
  }
  // A Codex Clawboo installed is updated where it was installed: from Clawboo.
  if (ownedRuntimeBin('codex')) {
    return `${reason} The installed Codex CLI is too old for your ChatGPT plan's current models. Update it in Settings, Runtimes, then retry.`
  }
  const update = getDescriptor('codex').installCommand ?? 'npm install -g @openai/codex@0'
  return `${reason} The installed Codex CLI is too old for your ChatGPT plan's current models. Update it with \`${update}\`, then retry.`
}

/**
 * A plain `codexErrorInfo` cause, as an error code. Where Claude Code's SDK names
 * the same cause, the code is its name (`authentication_failed`, `rate_limit`,
 * `overloaded`, ...), so one cause reads the same on every runtime. Never
 * `unauthorized`: the task runner reads that code as a policy denial.
 */
const CODEX_CAUSE_CODE: Record<string, string> = {
  unauthorized: 'authentication_failed',
  usageLimitExceeded: 'usage_limit_exceeded',
  contextWindowExceeded: 'context_overflow',
  serverOverloaded: 'overloaded',
  internalServerError: 'server_error',
  badRequest: 'invalid_request',
  sandboxError: 'sandbox_error',
  cyberPolicy: 'cyber_policy',
}

/** A connection-level cause, by name, when it carried no telling HTTP status. */
const CODEX_CONNECTION_CODE: Record<string, string> = {
  httpConnectionFailed: 'connection_failed',
  responseStreamConnectionFailed: 'connection_failed',
  responseStreamDisconnected: 'stream_disconnected',
  responseTooManyFailedAttempts: 'too_many_failed_attempts',
}

/**
 * The error code for the app-server's typed failure cause (`codexErrorInfo` on a
 * turn error or an error notification), or null when it names none. A connection
 * failure that carries the backend's HTTP status is read by that status, so a
 * 401 behind a dropped stream still reads as a refused sign-in.
 */
export function codexErrorCode(info: unknown): string | null {
  if (typeof info === 'string') return CODEX_CAUSE_CODE[info] ?? null
  const variant = asRecord(info)
  if (!variant) return null
  for (const [name, code] of Object.entries(CODEX_CONNECTION_CODE)) {
    const detail = asRecord(variant[name])
    if (!detail) continue
    const status = detail['httpStatusCode']
    if (status === 401 || status === 403) return 'authentication_failed'
    if (status === 402) return 'billing_error'
    if (status === 429) return 'rate_limit'
    return code
  }
  return null
}
