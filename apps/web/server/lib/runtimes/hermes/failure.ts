// Why a Hermes run failed, read from what Hermes said: the error a failed run
// reports, or the lines it printed. Two things are read from it. Whether the run
// ended on the model's context window (`context_overflow`, the code every
// runtime uses), and otherwise the cause a provider named in its error body
// (`invalid_api_key`, `insufficient_quota`, `authentication_error`, ...), which
// is what puts a refused key in Needs you with Fix sign-in. What Hermes logged
// about an overflow it got past, a sub-agent's lines and log lines below error
// level are never read as the cause.

import { isContextOverflowMessage } from '../native/providers/types'

/** Where a provider's error body starts in Hermes's output: its `error` object,
 *  printed as a Python dict or as JSON. */
const ERROR_BODY_RE = /['"]error['"]\s*:\s*\{/
/** A string-valued `code` or `type` field in that body. */
const ERROR_FIELD_RE = /['"](code|type)['"]\s*:\s*['"]([A-Za-z][\w.-]*)['"]/g
/** A string-valued `message` field, in a Python dict's quoting or JSON's. */
const ERROR_MESSAGE_RE = /['"]message['"]\s*:\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')/
/** The HTTP status in front of an error body, or a number where a `code` goes. */
const ERROR_STATUS_RE = /error code:\s*(\d{3})\D*$/i
const ERROR_NUMERIC_CODE_RE = /['"]code['"]\s*:\s*(\d{3})\b/
/** A provider's own code for a prompt over the model's context window. */
const CONTEXT_CODE_RE = /^context[_-]?(?:length|window)[_-]?exceeded$/i
/** A provider's catch-all for a refused request: says nothing about the cause. */
const GENERIC_REFUSAL_RE = /^(?:invalid_request(?:_error)?|bad_?request(?:_?error)?)$/i
/**
 * What Hermes itself says when it gives up on a context overflow, having already
 * tried to compress the conversation or been told not to (agent/conversation_loop.py,
 * 0.15.2 to 0.19.0). A quiet run prints its error as its response on stdout; ACP's
 * stderr has the `❌` and `[ERROR]` lines. Its status lines while it still works on it
 * do not match, and neither do its words for a request body too big to send ("Request
 * payload too large", "reached for payload-too-large error"): that is a size limit on
 * the request, not the model's context window.
 */
const HERMES_GAVE_UP_RE =
  /context length exceeded\b[^\n]*(?:cannot compress further|max compression attempts)|context overflow and auto-compaction is disabled|❌[^\n]*max compression attempts \(\d+\) reached\.|context compression failed after \d+ attempts/i

/** Lines of Hermes's output that state why a run failed. */
export const HERMES_ERROR_LINE_RE = /❌|\[ERROR\]|Error code:|\bError:/

/** Whether a printed line holding a provider's error body says the prompt was over the
 *  model's context window. A rate-limit status, or a specific cause of any other kind,
 *  is not an overflow. */
function bodySaysOverflow(line: string): boolean {
  const start = line.search(ERROR_BODY_RE)
  if (start < 0) return false
  const body = line.slice(start)
  const named = [...body.matchAll(ERROR_FIELD_RE)]
  const code = named.find(([, field]) => field === 'code')?.[2]
  if (code && CONTEXT_CODE_RE.test(code)) return true
  const status =
    ERROR_STATUS_RE.exec(line.slice(0, start))?.[1] ?? ERROR_NUMERIC_CODE_RE.exec(body)?.[1]
  if (status && !['400', '413', '422'].includes(status)) return false
  const cause = code ?? named.find(([, field, v]) => field === 'type' && v !== 'error')?.[2]
  if (cause && !GENERIC_REFUSAL_RE.test(cause)) return false
  const message = ERROR_MESSAGE_RE.exec(body)
  return isContextOverflowMessage(message?.[1] ?? message?.[2] ?? '')
}

/** A line a sub-agent printed (`log_prefix` in tools/delegate_tool.py). That is its own
 *  run, which the parent may well outlive, so it never speaks for the parent's. */
const SUBAGENT_LINE_RE = /\[subagent-\d+\]/
/** A log line below error level. Hermes logs each refused attempt this way, whether or
 *  not it goes on to recover, so such a line never says why a run ended. */
const LOW_LEVEL_LOG_RE = /\[(?:DEBUG|INFO|WARNING)\]/

/** The lines of a run's output that can speak for how that run ended. */
function ownLines(text: string): string[] {
  return text.split(/\r?\n/).filter((l) => !SUBAGENT_LINE_RE.test(l) && !LOW_LEVEL_LOG_RE.test(l))
}

/** Whether a line says the run's prompt was over the model's context window. */
function isOverflowLine(line: string): boolean {
  if (HERMES_GAVE_UP_RE.test(line)) return true
  return ERROR_BODY_RE.test(line) ? bodySaysOverflow(line) : isContextOverflowMessage(line)
}

/** Whether a failed Hermes run ended on the model's context window: the last error it
 *  printed of its own is Hermes giving up, or a provider's body saying so. */
function endedOnContextOverflow(text: string): boolean {
  const own = ownLines(text).filter((l) => l.trim())
  const errors = own.filter(
    (l) => HERMES_ERROR_LINE_RE.test(l) || HERMES_GAVE_UP_RE.test(l) || ERROR_BODY_RE.test(l),
  )
  const last = errors.at(-1) ?? own.at(-1) ?? ''
  return HERMES_GAVE_UP_RE.test(last) || bodySaysOverflow(last)
}

/** A run's own output with every statement about an overflow taken out, for a turn that
 *  cannot have ended on one: Hermes gives up by answering the turn. */
export function withoutOverflowLines(text: string): string {
  return ownLines(text)
    .filter((l) => !isOverflowLine(l))
    .join('\n')
}

/**
 * A failed run's own output, without what it logged about an overflow it got past. When
 * the run ended some other way those lines are not why it failed. Left in, they read as
 * its cause: to the error classes, and in the sentence a person is shown.
 */
export function withoutRecoveredOverflow(text: string): string {
  const own = ownLines(text)
  if (endedOnContextOverflow(text)) return own.join('\n')
  const kept = own.filter((l) => !isOverflowLine(l))
  return (kept.some((l) => l.trim()) ? kept : own).join('\n')
}

/**
 * The cause of a failed Hermes run, or null. `context_overflow` when it ended on the
 * model's context window, the code every runtime uses for that. Otherwise the cause a
 * provider named in the last error body Hermes printed, which is the one the run ended
 * on. The OpenAI style puts the specific cause in `code` (`invalid_api_key`,
 * `insufficient_quota`) under a broader `type`; the Anthropic style has only `type`
 * (`authentication_error`). Only the error object is read, so other JSON on the same
 * output cannot pose as the cause.
 */
export function hermesErrorCode(text: string): string | null {
  if (endedOnContextOverflow(text)) return 'context_overflow'
  const remaining = withoutRecoveredOverflow(text)
  // The first body on the last line that has one: a provider's body can nest another.
  let start = -1
  let offset = 0
  for (const line of remaining.split('\n')) {
    const at = line.search(ERROR_BODY_RE)
    if (at >= 0) start = offset + at
    offset += line.length + 1
  }
  if (start < 0) return null
  let type: string | null = null
  for (const [, field, value] of remaining.slice(start).matchAll(ERROR_FIELD_RE)) {
    if (field === 'code') return value!
    if (!type && value !== 'error') type = value!
  }
  return type
}

/** A provider's refusal as Hermes words it in a failed run's error, when Hermes
 *  did not read it as an overflow itself: `HTTP 400: This model's maximum context
 *  length ...`. */
const HTTP_REFUSAL_RE = /^HTTP (?:400|413|422):/

/** A failed run's message, with the provider's typed cause when it named one. */
export function hermesFailure(message: string): { errorMessage: string; errorCode?: string } {
  const lastLine =
    message
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .at(-1) ?? ''
  const errorCode =
    HTTP_REFUSAL_RE.test(lastLine) && isContextOverflowMessage(lastLine)
      ? 'context_overflow'
      : hermesErrorCode(message)
  return {
    errorMessage: withoutRecoveredOverflow(message).trim() || message,
    ...(errorCode ? { errorCode } : {}),
  }
}
