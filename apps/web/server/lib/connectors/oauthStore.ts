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

/** Whether this connector has been authorized. Never returns the token itself. */
export function isAuthorized(slug: string): boolean {
  return getStoredTokens(slug)?.access_token !== undefined
}

/** Forget everything for one connector. Used by an explicit sign-out. */
export function clearOAuth(slug: string): void {
  deleteRuntimeSecret(clientSlot(slug))
  deleteRuntimeSecret(tokenSlot(slug))
}
