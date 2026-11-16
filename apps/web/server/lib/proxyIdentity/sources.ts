// The issuers the identity lane trusts, each with its verifier, built the way
// the server builds them (index.ts): every verifier records the request-bound
// tokens it accepts in the database (seenTokens.ts), so a token stays used
// across a restart, and beside a sign-in proxy that publishes a JWKS URL (whose
// keys startup cannot compare with the reader key, config.ts) the reader key's
// verifier refuses every token while the set that URL serves holds the reader
// key, and the proxy's verifier refuses any token the reader key signed. The
// two share one fetched, cached key set.

import type { ClawbooDb } from '@clawboo/db'

import { issuerOf, type ProxyIdentityConfig } from './config'
import type { LaneSource } from './lane'
import { createSeenTokenStore, type SeenTokenStoreOptions } from './seenTokens'
import { createAssertionVerifier, currentKeySet, remoteKeySet } from './verifier'

export interface IdentitySourceOptions {
  /** The connection the records go to. Defaults to the server's (`getDb`). */
  db?: () => ClawbooDb
  /** Told when a record cannot be written or swept. Never given the token. */
  onStoreError?: SeenTokenStoreOptions['onError']
}

/**
 * One lane source per config (identityConfigs' list), in order. `proxy` is the
 * sign-in proxy's own config, null when that lane is off.
 */
export function identitySources(
  configs: readonly ProxyIdentityConfig[],
  proxy: ProxyIdentityConfig | null,
  opts: IdentitySourceOptions = {},
): LaneSource[] {
  const remote = proxy?.keys.source === 'jwks-url' ? remoteKeySet(proxy.keys.url) : null
  // The reader's own keys, which the proxy's verifier refuses beside a JWKS URL:
  // a set that came to hold one would otherwise let the reader key sign a person.
  const reader = configs.find((c) => c.reader)
  const readerKeys = reader?.keys.source === 'public-key' ? reader.keys.jwks : null
  return configs.map((config) => ({
    config,
    verifier: createAssertionVerifier(config, {
      seen: createSeenTokenStore(issuerOf(config), {
        ...(opts.db ? { db: opts.db } : {}),
        ...(opts.onStoreError ? { onError: opts.onStoreError } : {}),
      }),
      ...(remote && issuerOf(config) === 'proxy' ? { getKey: remote } : {}),
      ...(remote && readerKeys && issuerOf(config) === 'proxy' ? { refuseKeysIn: readerKeys } : {}),
      ...(remote && config.reader ? { personKeySet: () => currentKeySet(remote) } : {}),
    }),
  }))
}
