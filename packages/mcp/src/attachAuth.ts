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
// This is deliberately not a session or expiry mechanism. The threat a scope
// signature answers is a runtime editing its own config to escalate. Whether a
// caller may reach the surface AT ALL is a separate question, answered by the
// access token at the bottom of this file: "loopback-only" turned out not to
// hold, because a same-host reverse proxy delivers every remote request from
// 127.0.0.1.

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
  return sameHex(signAttachScope(secret, scope), sig)
}

/** The Memory URL's provenance stamps. They never widen what a session can see,
 *  but the learning overlay counts distinct (agent, task) reporters as
 *  corroborators, so a task id a runtime could edit would let one agent mint
 *  independent-looking evidence for a fact. `agentId` is included so a stamp
 *  signed for one agent cannot be replayed onto another's URL. */
export interface SignableProvenance {
  agentId?: string | null
  runtime?: string | null
  taskId?: string | null
  sessionKey?: string | null
}

/** A different leading tag from `canonical()`, so a scope signature can never
 *  verify as a provenance signature or the reverse. */
const canonicalProvenance = (p: SignableProvenance): string =>
  ['prov-v1', p.agentId ?? '', p.runtime ?? '', p.taskId ?? '', p.sessionKey ?? ''].join('\x1f')

export function signAttachProvenance(secret: string, prov: SignableProvenance): string {
  return createHmac('sha256', secret).update(canonicalProvenance(prov)).digest('hex')
}

export function verifyAttachProvenance(
  secret: string,
  prov: SignableProvenance,
  sig: string,
): boolean {
  return sameHex(signAttachProvenance(secret, prov), sig)
}

/** Its own domain tag, with none of the separators `canonical()` and
 *  `canonicalProvenance()` always contain, so the access token can never verify
 *  as a scope or provenance signature, or the reverse. */
const ACCESS_DOMAIN = 'access-v1'

/**
 * The control-plane ACCESS token: proof that a request comes from a runtime this
 * server spawned, rather than from anything that can reach the port.
 *
 * A scope signature cannot answer that. It falls back to UNBOUND when absent, by
 * design, so an unsigned attach still gets served. The access gate used to answer
 * it from the TCP peer address (loopback ⇒ our own runtime), and a same-host
 * reverse proxy defeats that, since every request it forwards arrives from
 * 127.0.0.1. This token answers it instead. The server writes it into every attach
 * URL it mints, scoped or not, and nothing else holds it.
 *
 * One value per install, derived from the secret so the secret itself never
 * leaves the server. Stateless for the same reasons as the scope signature.
 */
export function signAttachAccess(secret: string): string {
  return createHmac('sha256', secret).update(ACCESS_DOMAIN).digest('hex')
}

/** Constant-time; a malformed or truncated token is simply false, never a throw. */
export function verifyAttachAccess(secret: string, token: string): boolean {
  return sameHex(signAttachAccess(secret), token)
}

function sameHex(expectedHex: string, sig: string): boolean {
  const expected = Buffer.from(expectedHex, 'hex')
  let given: Buffer
  try {
    given = Buffer.from(sig, 'hex')
  } catch {
    return false
  }
  if (given.length !== expected.length) return false
  return timingSafeEqual(expected, given)
}
