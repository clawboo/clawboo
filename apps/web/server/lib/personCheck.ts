// How the person check decides who may act as the person (lib/auth.ts
// `actsAsPerson`), read once at startup from the operator settings.
//
//   page      today's check: a person a verified token names, or the dashboard's
//             own page, recognised by the marks a browser puts on its requests
//             (lib/dashboardRequest.ts). A speed bump, not a boundary: anything
//             holding the access token can send the same marks.
//   verified  only a person a verified token names. The page's marks count for
//             nothing. It needs the sign-in proxy lane on, since the app link
//             alone signs a handful of requests, and it also covers what the
//             page check never did: the Gateway WebSocket (whose messages answer
//             OpenClaw approvals) and every route of an agent's screen.
//
// A lane in `required` mode is always `verified`, whatever the setting says:
// every request it lets through already names a verified person, and writing
// that down here keeps it true if the lane's exemptions ever change.
//
// How much `verified` proves depends on where agents run. An agent running as
// this server's own OS user can still change the database or the server's code
// directly, around every check; see docs/operating/security.md.

// No runtime imports: lib/auth.ts reads the mode on every person write. The
// setting is loaded by proxyIdentity/config.ts (`loadPersonCheck`).

export type PersonCheckMode = 'page' | 'verified'
/** Whether taking over an agent's screen needs the sign-in proxy's `control`
 *  claim (proxyIdentityControlClaim), as startup read it. */
export type ControlClaimMode = 'off' | 'required'

let mode: PersonCheckMode = 'page'
let claim: ControlClaimMode = 'off'

/**
 * The person check's mode for this server, from the setting and the sign-in
 * proxy lane's mode (null when that lane is off; the app link does not count),
 * or why the server must not start: `verified` with no sign-in proxy lane
 * would leave a dashboard that can do no person act at all.
 */
export function resolvePersonCheck(
  setting: PersonCheckMode,
  laneMode: 'on' | 'required' | null,
): { ok: true; mode: PersonCheckMode } | { ok: false; error: string } {
  if (laneMode === 'required') return { ok: true, mode: 'verified' }
  if (setting === 'verified' && laneMode === null) {
    return {
      ok: false,
      error:
        'personCheck is verified but the sign-in proxy lane (proxyIdentity) is off. Set ' +
        'proxyIdentity to on or required, so that a person acting in the dashboard sends a ' +
        'token Clawboo can verify.',
    }
  }
  return { ok: true, mode: setting }
}

/** Set once at startup, after `loadPersonCheck`. */
export function setPersonCheckMode(next: PersonCheckMode): void {
  mode = next
}

/** The mode this server runs the person check in. `page` until startup sets it. */
export function personCheckMode(): PersonCheckMode {
  return mode
}

/** Set once at startup, from the sign-in proxy lane's config. */
export function setControlClaimMode(next: ControlClaimMode): void {
  claim = next
}

/** Whether a take over, and every batch of input after, needs a `control`
 *  claim naming the agent. `off` until startup sets it. */
export function controlClaimRequired(): boolean {
  return claim === 'required'
}

/** Test seam: back to `page`, with no take-over claim. */
export function resetPersonCheckForTests(): void {
  mode = 'page'
  claim = 'off'
}

/**
 * Whether the Gateway WebSocket may open, as far as the person check goes. Its
 * messages are not checked one by one, and the dashboard answers OpenClaw
 * approvals over it, so under `verified` only a person the sign-in proxy's
 * token names opens it. The lane has already refused an app link's token and
 * set a service token's person to null.
 */
export function upgradeAllowedForPersonCheck(
  check: PersonCheckMode,
  decision: { person: unknown } | null,
): boolean {
  return check !== 'verified' || (decision !== null && decision.person != null)
}

/** One line for the startup log: what the check stops here, in plain words. */
export function personCheckLogLine(
  check: PersonCheckMode,
  isolation: 'none' | 'agent-user' | 'agent-users',
): string {
  if (check === 'page') {
    return 'Person check: page. The dashboard acts as the person from its own page. Anything holding the access token can do the same.'
  }
  const base =
    'Person check: verified. Only a person your sign-in proxy signed for can act as the person, on the Gateway WebSocket and an agent screen too.'
  // OpenClaw agents run in the Gateway as this server's user in every mode.
  if (isolation === 'agent-users' || isolation === 'agent-user') {
    return `${base} OpenClaw agents still run as this server's user and can change its database directly.`
  }
  return `${base} Agents run as this server's user and can still change its database directly; run them as users of their own (CLAWBOO_AGENT_USERS) to close that.`
}
