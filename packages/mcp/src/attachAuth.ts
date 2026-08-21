// Attach-scope authentication — making the URL binding a claim clawboo can check.
//
// THE HOLE. The MCP attach URL carries the run's identity as plain query params
// (`scopeTeamId`, `scopeAgentId`, `postAuthorAgentId`, `delegate`), and the
// loopback HTTP surface trusts them as written. The design note said "the URL is
// clawboo-written config, so the runtime can't post as a peer it isn't" — which
// holds only while the runtime uses the config it was handed. A coding runtime
// has shell access to its own home: it can read its config, edit the params, and
// reattach claiming another agent's identity, another team's board scope, or the
// `delegate` privilege it was not granted.
//
// THE FIX. Clawboo signs the scope it writes. The signature is an HMAC over the
// SEMANTIC scope fields under a per-install secret that never leaves the server's
// state; the URL carries the signature, never the secret. Verification is
// stateless — recompute and compare — so it survives restarts with no token
// table, no expiry bookkeeping, and byte-identical config files across rewrites
// (the mtime-freshness logic in the codex driver depends on that stability).
//
// A scope whose signature is absent or wrong is treated as UNBOUND, not as an
// error: the claimed identity is refused (fail closed on identity) while a bare
// external attach — which never carried scope — keeps working unchanged.
//
// This is deliberately not a session or expiry mechanism. The threat is a
// runtime editing its own config to escalate, not a network attacker: the
// surface is loopback-only and the signature stops the only party who can reach
// it from minting an identity it was not given.

import { createHmac, timingSafeEqual } from 'node:crypto'

/** The semantic fields a signature covers. `delegate` is included because it is
 *  a PRIVILEGE, not an address — leaving it outside the HMAC would let a merely
 *  team-scoped run append `delegate=1` to its signed URL and gain the
 *  `team_delegate` tool. */
export interface SignableScope {
  teamId?: string | null
  agentId?: string | null
  tenantId?: string | null
  delegate?: boolean
}

/** One canonical byte string per semantic scope, independent of which param
 *  spelling carried it (`scopeAgentId` vs `postAuthorAgentId`). `\x1f` separators
 *  cannot appear in ids, so fields can never bleed into each other. */
const canonical = (s: SignableScope): string =>
  ['v1', s.teamId ?? '', s.agentId ?? '', s.tenantId ?? '', s.delegate ? '1' : '0'].join('\x1f')

/** Sign a scope. Hex HMAC-SHA256; safe to place in a URL. */
export function signAttachScope(secret: string, scope: SignableScope): string {
  return createHmac('sha256', secret).update(canonical(scope)).digest('hex')
}

/** Verify a scope against the signature its URL carried. Constant-time; a
 *  malformed or truncated signature is simply false, never a throw. */
export function verifyAttachScope(secret: string, scope: SignableScope, sig: string): boolean {
  const expected = Buffer.from(signAttachScope(secret, scope), 'hex')
  let given: Buffer
  try {
    given = Buffer.from(sig, 'hex')
  } catch {
    return false
  }
  if (given.length !== expected.length) return false
  return timingSafeEqual(expected, given)
}
