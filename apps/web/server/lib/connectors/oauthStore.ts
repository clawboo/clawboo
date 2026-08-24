// Where a remote connector's OAuth material lives.
//
// IN THE VAULT, all of it. The access and refresh tokens are obviously secret.
// The dynamically-registered client_id is less obviously so, but it is minted
// per install and identifies this clawboo to the provider, so it goes in the
// same place rather than in a settings row anyone can read.
//
// Namespaced per connector for the same reason credentials are: two connectors
// can be registered with the same authorization server and must not share a
// registration, and deleting one must not disturb the other.

import { deleteRuntimeSecret, getRuntimeSecret, setRuntimeSecret } from '../secretsVault'

export interface StoredClient {
  client_id: string
  client_secret?: string
  /**
   * The redirect this registration was made with.
   *
   * Load-bearing rather than bookkeeping. Dynamic registration PINS a
   * redirect_uri, and ours carries an ephemeral port, so a later sign-in that
   * reuses this registration from a different port is refused by the provider
   * for redirect_uri mismatch. Recording it is what lets the flow notice and
   * re-register instead of failing on every retry.
   */
  redirect_uri?: string
}

export interface StoredTokens {
  access_token: string
  refresh_token?: string
  /** Epoch ms. Absent when the provider did not say, which we treat as "unknown"
   *  rather than "never expires": a 401 is then the only signal, and the refresh
   *  path handles it. */
  expires_at?: number
  scope?: string
}

function clientSlot(slug: string): string {
  return `connector-oauth-client:${slug}`
}
function tokenSlot(slug: string): string {
  return `connector-oauth-tokens:${slug}`
}

function read<T>(slot: string): T | null {
  const raw = getRuntimeSecret(slot)
  if (!raw) return null
  try {
    return JSON.parse(raw) as T
  } catch {
    // A corrupt blob is treated as absent rather than fatal: the worst outcome
    // is one more sign-in, and throwing here would break a connect the user
    // could otherwise repair themselves.
    return null
  }
}

export function getStoredClient(slug: string): StoredClient | null {
  return read<StoredClient>(clientSlot(slug))
}
export function saveStoredClient(slug: string, client: StoredClient): void {
  setRuntimeSecret(clientSlot(slug), JSON.stringify(client))
}

export function getStoredTokens(slug: string): StoredTokens | null {
  return read<StoredTokens>(tokenSlot(slug))
}
export function saveStoredTokens(slug: string, tokens: StoredTokens): void {
  setRuntimeSecret(tokenSlot(slug), JSON.stringify(tokens))
}

/**
 * Whether this connector holds an authorization that could still be used.
 *
 * "Could still be used" rather than "exists", because the connect route decides
 * the same question by actually resolving a token, and the two answers have to
 * agree. A stored token that has expired with NO refresh token is dead: reporting
 * it as authorized left the panel showing a Connect button that the server then
 * refused, with no sign-in offered and no way back.
 *
 * What this cannot see is a refresh token the provider has revoked on their
 * side. That takes a network round-trip, which this read must not make, so the
 * connect route reports `remote-needs-oauth` and the panel offers sign-in again.
 */
export function isAuthorized(slug: string): boolean {
  const tokens = getStoredTokens(slug)
  if (!tokens?.access_token) return false
  if (tokens.expires_at === undefined) return true
  return tokens.expires_at > Date.now() || tokens.refresh_token !== undefined
}

/** Forget everything for one connector. Used by an explicit sign-out. */
export function clearOAuth(slug: string): void {
  deleteRuntimeSecret(clientSlot(slug))
  deleteRuntimeSecret(tokenSlot(slug))
}
