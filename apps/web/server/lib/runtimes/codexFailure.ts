// The reason a failed Codex run reports, shared by the app-server driver and the
// `codex exec` fallback.
//
// The backend decides which models a ChatGPT login may use, and it refuses the
// rest with "The '<model>' model is not supported when using Codex with a ChatGPT
// account". A run that pinned no model and still got that refusal ran the CLI's
// OWN default: the CLI predates the account's current models (an old CLI cannot
// decode the live list and falls back to the catalog it shipped with), so the fix
// is updating it. The message says so instead of passing on a log line.

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
  const update = getDescriptor('codex').installCommand ?? 'npm install -g @openai/codex@0'
  return `${reason} The installed Codex CLI is too old for your ChatGPT plan's current models. Update it with \`${update}\`, then retry.`
}
