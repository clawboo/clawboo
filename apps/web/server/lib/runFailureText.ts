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

/**
 * A run whose stream died without ever reaching a terminal (a dropped connection,
 * a crashed harness). There is no reason to report because the runtime never gave
 * one, so this says exactly that rather than inventing a cause.
 */
export const RUN_ENDED_WITHOUT_RESULT =
  'The run ended without reporting a result. The connection to the runtime may have dropped; try sending again.'

/** The message to show for a failed run, given whatever reason the runtime gave. */
export function runFailureText(errorMessage: string | null | undefined): string {
  // `routeCall` throws "no provider key available (checked ANTHROPIC_API_KEY and
  // fallbacks)" when the agent's configured slot is empty, which is a setup
  // problem the user can fix rather than an error they should read raw.
  if (/no provider key/i.test(errorMessage ?? '')) {
    return 'Clawboo Native has no provider key connected. Open Settings → Runtimes → Clawboo Native to connect a provider.'
  }
  return `The run failed: ${errorMessage ?? 'unknown error'}`
}
