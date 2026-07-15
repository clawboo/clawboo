// The OpenClaw Gateway always exposes a built-in default agent (`mainKey`,
// usually `"main"`). It's Gateway plumbing, not a user-created team member, and
// clawboo mirrors every Gateway agent into the registry — so it enters the fleet.
//
// Pre-native-first it was ABSORBED as Boo Zero (resolveBooZero fell back to the
// Gateway default), so it rendered as the crowned leader. Native-first flipped
// Boo Zero to the native agent, leaving the Gateway default a teamless,
// non-Boo-Zero OpenClaw agent that floats into the Atlas graph + the sidebar.
//
// Fix: hide it at the DISPLAY layer (graph + sidebar) only — it MUST stay in the
// fleet store, since event routing, exec-approval routing, and 1:1-chat
// resolution all resolve agents from the store. The guard is load-bearing: hide
// it ONLY when it isn't the identified Boo Zero, so a PURE-OpenClaw install
// (where the Gateway default legitimately IS Boo Zero) keeps it visible as the
// leader.

/**
 * True when `agent` is the OpenClaw Gateway's default system agent (`mainKey`)
 * AND is NOT the identified Boo Zero — i.e. a redundant Gateway artifact that
 * should be hidden from the graph + sidebar.
 *
 * Returns false (keep visible) when the Gateway default id is unknown, when Boo
 * Zero hasn't been identified yet (`booZeroAgentId == null` — avoids hiding
 * `main` before identification lands, which would flash it out then back in the
 * pure-OpenClaw case), or when the agent IS the identified Boo Zero.
 */
export function isHiddenGatewayDefault(
  agent: { id: string },
  gatewayMainAgentId: string | null,
  booZeroAgentId: string | null,
): boolean {
  if (gatewayMainAgentId == null || booZeroAgentId == null) return false
  return agent.id === gatewayMainAgentId && agent.id !== booZeroAgentId
}
