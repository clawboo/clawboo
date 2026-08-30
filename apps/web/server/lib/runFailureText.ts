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

import { getDescriptor, isRuntimeId } from './runtimes/descriptor'
import { isContextOverflowMessage } from './runtimes/native/providers/types'

/**
 * A run whose stream died without ever reaching a terminal (a dropped connection,
 * a crashed harness). There is no reason to report because the runtime never gave
 * one, so this says exactly that rather than inventing a cause.
 */
export const RUN_ENDED_WITHOUT_RESULT =
  'The run ended without reporting a result. The connection to the runtime may have dropped; try sending again.'

/**
 * The message to show for a failed run, given whatever reason the runtime gave.
 *
 * `runtime` names the runtime that failed, so the remediation points at the one
 * the user actually has to fix. Team delivery drives four runtimes through this,
 * and only the native one raises the missing-key error today, but a hardcoded
 * destination would quietly start misdirecting the moment another one did.
 */
export function runFailureText(
  errorMessage: string | null | undefined,
  runtime?: string | null,
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
  if (isContextOverflowMessage(errorMessage ?? '')) {
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

  return `The run failed: ${errorMessage ?? 'unknown error'}`
}
