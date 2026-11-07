// The user-facing sentence for a run that failed before it said anything.
//
// A run that dies mid-reply leaves the partial text it already streamed, which
// speaks for itself. A run that dies BEFORE its first token leaves nothing, and
// without this it is a silent non-response: an optimistic bubble, a brief
// Working badge, then nothing at all. The most common cause is also the most
// fixable (no provider key), so it gets the sentence that says where to fix it.
//
// Shared by the 1:1 chat drain (`agentChat/driveAgentChat.ts`) and the team-chat
// drain (`teamChat/serverDeliver.ts`) so the two surfaces cannot drift.

import { classifyError, isAccountError, isTransientError } from '@clawboo/obs'

import { getDescriptor, isRuntimeId } from './runtimes/descriptor'
import { OLLAMA_FALLBACK_MODEL, ollamaPullCommand } from './runtimes/native/ollamaModels'
import { readsAsContextOverflow } from './runtimes/native/providers/types'

/**
 * A run whose stream died without ever reaching a terminal (a dropped connection,
 * a crashed harness). There is no reason to report because the runtime never gave
 * one, so this says exactly that rather than inventing a cause.
 */
export const RUN_ENDED_WITHOUT_RESULT =
  'The run ended without reporting a result. The connection to the runtime may have dropped; try sending again.'

/**
 * What a 1:1 chat shows when a context overflow costs the agent the conversation: its
 * saved session was dropped, and nothing else is said about that turn. Worded as the
 * `/reset` divider is, since the same thing has happened.
 */
export const SESSION_DROPPED_TEXT =
  "This conversation outgrew the model's context window, so your next message starts fresh. Everything above stays for you to read. Your boo is no longer carrying the conversation, though it still has anything it saved to memory."

/** The same, when the session could not be dropped: the next turn may fail the same way. */
export const SESSION_NOT_DROPPED_TEXT =
  "This conversation outgrew the model's context window, and Clawboo could not clear its session, so your next message may fail the same way. Type /reset to start fresh."

/**
 * A Clawboo Native turn that overflowed where trimming can make room. The session is
 * kept, and the next resume drops its oldest turns, so the agent loses those without
 * losing the conversation.
 */
export const CONVERSATION_TRIMMED_TEXT =
  "This turn did not fit in the model's context window, so it stopped before finishing. Your boo keeps this conversation, but from your next message it carries only the most recent part, so it may not remember the oldest messages."

/**
 * A 1:1 turn that overflowed with no earlier conversation behind it: a first turn, or the
 * first after a reset. The agent lost nothing it was carrying, so saying it had would be
 * untrue, and starting fresh is no remedy when its instructions and tools alone fill the
 * window, in which case every message ends here.
 */
export const TURN_TOO_LARGE_TEXT =
  "This turn did not fit in the model's context window, so it stopped before finishing, and your next message starts fresh. Try a smaller request, or a model with a larger window. If every message does this, this agent's instructions and tools may be too large for the model."

/**
 * Whether a run's typed cause is one that passes by itself (a rate limit, an overload, a
 * provider outage). Such a failure says nothing about the session it was resuming, so
 * that session stays.
 */
export function isPassingCause(code: string | null | undefined): boolean {
  return !!code && isTransientError(classifyError(code))
}

/**
 * Whether a provider refused a run's request as sent, so that sending it again can only
 * fail the same way. A `bad_request` is that, unless it is about something other than
 * the request: a model that is gone or cannot use tools, a refused account, or a limit
 * that passes. Comma-grouped numbers go first: a token count is not a status.
 */
export function isRefusedRequest(
  code: string | null | undefined,
  message: string | null | undefined,
): boolean {
  if (code !== 'bad_request' || !message) return false
  if (/^\s*404\b|does not support tools/i.test(message)) return false
  const cls = classifyError(code, message.replace(/\d{1,3}(?:,\d{3})+/g, 'N'))
  return !isAccountError(cls) && !isTransientError(cls)
}

/**
 * A 1:1 notice for a resumed Clawboo Native turn the provider refused, when trimming
 * cannot change what a resume sends. Its wording may be one nobody has seen, so this
 * gives the provider's reason and does not claim to know the cause.
 */
export function refusedSessionDroppedText(reason: string): string {
  return `The run failed: ${reason.trim().replace(/\.+$/, '')}. Resuming this conversation would send the same request again, so your next message starts fresh. Everything above stays for you to read. Your boo is no longer carrying the conversation, though it still has anything it saved to memory.`
}

/**
 * Team chat's notices for the same two cases, naming the agent: a room has several, and
 * only this one is affected. `wasResuming`: it had a session to lose.
 */
export function teamOverflowText(
  agentName: string | null | undefined,
  wasResuming: boolean,
): string {
  const who = agentName?.trim() || 'This agent'
  return wasResuming
    ? `${who} outgrew the model's context window, so it starts fresh on its next turn. Everything above stays for you to read, and it still has anything it saved to memory.`
    : `${who}'s turn did not fit in the model's context window, so it stopped before finishing, and it starts fresh on its next turn. Try a smaller request, or a model with a larger window.`
}

/** Team chat's notice when the session could not be dropped: its next turn resumes it. */
export function teamOverflowNotClearedText(agentName: string | null | undefined): string {
  return `${agentName?.trim() || 'This agent'} outgrew the model's context window, and Clawboo could not clear its session, so its next turn may fail the same way. Type /reset to start fresh.`
}

/**
 * The message to show for a failed run, given whatever reason the runtime gave.
 *
 * `runtime` names the runtime that failed, so the remediation points at the one
 * the user actually has to fix. Team delivery drives four runtimes through this,
 * and only the native one raises the missing-key error today, but a hardcoded
 * destination would quietly start misdirecting the moment another one did.
 *
 * `provider` is a native agent's provider. Ollama's model errors are only read as
 * Ollama's when the agent runs on it: other OpenAI-compatible servers word a
 * missing model the same way, and the fix there is not `ollama pull`.
 */
export function runFailureText(
  errorMessage: string | null | undefined,
  runtime?: string | null,
  provider?: string | null,
): string {
  // `routeCall` throws "no provider key available (checked ANTHROPIC_API_KEY and
  // fallbacks)" when the agent's configured slot is empty, which is a setup
  // problem the user can fix rather than an error they should read raw.
  if (/no provider key/i.test(errorMessage ?? '')) {
    const name = runtime && isRuntimeId(runtime) ? getDescriptor(runtime).name : null
    return name
      ? `${name} has no provider key connected. Open Settings → Runtimes → ${name} to connect a provider.`
      : 'This runtime has no provider key connected. Open Settings → Runtimes to connect a provider.'
  }
  // A CONTEXT-OVERFLOW LABEL IS RARELY ABOUT AN OVERSIZED PROMPT, and passing it
  // through verbatim sent an operator round the same loop five times.
  //
  // The message a coding runtime emits here reads "prompt too large for the
  // model. Try /reset (or /new)". On the install this was traced through, the
  // prompt was ~32,000 tokens against a model with a 204,800-token window, so it
  // was nowhere near too large. What had happened is that the runtime resolved a
  // context budget of 32,768 (the model's max COMPLETION tokens, not its context
  // window), decided at 32,106 that it had to compact, and then could not: tool
  // definitions were 50,405 bytes of every prompt and compaction cannot reach
  // those, and what remained was smaller than the 20,000-token window compaction
  // protects, so its summarizer was handed an empty conversation and returned a
  // "conversation is empty" template. Nothing was freed, the turn produced no
  // text, and it repeated until the run gave up.
  //
  // `/reset` clears the conversation, which is the one part that was not the
  // problem, so the advice sends the operator somewhere that cannot help. What
  // fixes it permanently is telling the runtime the model's real window.
  //
  // That is OpenClaw's story, where a Gateway resolves its own budget. A runtime
  // Clawboo runs itself gets a plain sentence: the drains that drop its session say so
  // instead of this (see SESSION_DROPPED_TEXT), and this covers an overflow they could
  // not confirm.
  if (readsAsContextOverflow(errorMessage ?? '')) {
    if (runtime && isRuntimeId(runtime)) {
      return "This run outgrew the model's context window and stopped before it finished."
    }
    return (
      'This run stopped because the runtime believed it was out of context room. ' +
      'That is usually a wrong context-window setting rather than a genuinely oversized prompt: ' +
      'a runtime that resolves a small budget starts compacting early, and compaction cannot shrink ' +
      'tool definitions, so it frees nothing and the turn fails again. ' +
      "Check the model's real context window in Settings → Runtimes, and reduce how many connectors " +
      'this agent is granted if its tool list has grown. Starting a fresh session clears the ' +
      'conversation but not the cause.'
    )
  }

  const ollama = provider === 'ollama' ? ollamaModelFailureText(errorMessage ?? '') : null
  if (ollama) return ollama

  return `The run failed: ${errorMessage ?? 'unknown error'}`
}

// Ollama's own words for the two ways a local model refuses a run before its
// first token. Current versions say `model 'llama3.2' not found` and
// `"gemma2" does not support tools`; older ones said `model "llama3.2" not found,
// try pulling it first` and `registry.ollama.ai/library/gemma2:latest does not
// support tools`.
const OLLAMA_NOT_PULLED_RE = /model ['"]?([^'"\s]+)['"]? not found(?:, try pulling it first)?/i
const OLLAMA_NO_TOOLS_RE = /['"]?([^'"\s]+)['"]? does not support tools/i

function ollamaModelName(raw: string): string {
  return (raw.split('/').pop() ?? raw).replace(/:latest$/, '')
}

/** The fix for a local model that can't run, or null when it isn't one. */
function ollamaModelFailureText(message: string): string | null {
  const missing = OLLAMA_NOT_PULLED_RE.exec(message)
  if (missing?.[1]) {
    const model = ollamaModelName(missing[1])
    return (
      `Ollama doesn't have ${model} yet, so this run couldn't start. ` +
      `Pull it with "${ollamaPullCommand(model)}", or pick a model you have pulled in this agent's settings.`
    )
  }
  const noTools = OLLAMA_NO_TOOLS_RE.exec(message)
  if (noTools?.[1]) {
    const model = ollamaModelName(noTools[1])
    return (
      `${model} can't use tools, and this agent needs them. Pick a model that can in this ` +
      `agent's settings, or pull one with "${ollamaPullCommand(OLLAMA_FALLBACK_MODEL)}".`
    )
  }
  return null
}
