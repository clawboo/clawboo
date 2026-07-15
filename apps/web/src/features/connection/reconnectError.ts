// Classifies a failed Gateway reconnect so the banner can offer an action that
// can actually FIX it.
//
// The distinction that matters: an AUTH failure is NOT a reachability failure.
// When the Gateway answers and REJECTS us (a stale token it loaded at ITS boot,
// an unapproved device), "Could not reach the Gateway. Try again" is wrong on
// both counts — the Gateway is reachable, and retrying re-sends the same token,
// so it can never succeed. That dead-ends the user on the one button that looks
// like the way out.
//
// The Gateway reads its token ONCE at boot, so a token regenerated afterwards
// leaves it holding a stale one. Only a Gateway RESTART reloads it — which is
// why `auth` swaps the banner's primary action from Retry to Restart Gateway.

import { GatewayResponseError, isAuthConnectError } from '@clawboo/gateway-client'

export type ReconnectErrorKind =
  /** Device isn't approved — the remedy lives in Settings, not a retry. */
  | 'not-paired'
  /** The Gateway rejected our token. Retrying re-sends it; a restart reloads it. */
  | 'auth'
  /** Genuinely unreachable (down / wrong port). Retrying is legitimate. */
  | 'unreachable'

export interface ReconnectErrorInfo {
  kind: ReconnectErrorKind
  message: string
}

export function classifyReconnectError(err: unknown): ReconnectErrorInfo {
  // NOT_PAIRED is auth-class too, so it MUST be checked before the generic auth
  // branch — it has its own, more specific remedy (approve the device).
  if (err instanceof GatewayResponseError && err.code === 'NOT_PAIRED') {
    return {
      kind: 'not-paired',
      message: 'This device needs approval. Open Settings to approve it.',
    }
  }
  if (isAuthConnectError(err)) {
    return {
      kind: 'auth',
      message: 'The Gateway rejected clawboo’s token. Restart it to reload the token.',
    }
  }
  return {
    kind: 'unreachable',
    message: 'Could not reach the Gateway. Try again, or set it up in Settings.',
  }
}
