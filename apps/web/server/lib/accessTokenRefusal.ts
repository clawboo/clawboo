// Boot policy for a STUDIO_ACCESS_TOKEN the access gate cannot use. Extracted from
// index.ts so it is unit-testable: index.ts calls main() at module top level, so
// importing anything from it would boot the whole server.

import { ACCESS_TOKEN_CHARSET, findUnsupportedTokenChar } from '@clawboo/gateway-proxy'

/**
 * The SECURITY error to log before refusing to start, or null when the token is
 * usable or unset.
 *
 * A set token with a character the gate cannot carry is always a refusal, on every
 * bind. Starting without the gate would serve every /api/* route unauthenticated,
 * and the wide-bind refusal does not catch the loopback bind behind a same-host
 * reverse proxy. CLAWBOO_ALLOW_INSECURE does not apply: it allows running with NO
 * token, and an operator who set one asked for the gate.
 */
export function accessTokenRefusal(token: string | undefined): string | null {
  const bad = findUnsupportedTokenChar(token)
  if (bad === null) return null
  return (
    `SECURITY: refusing to start. STUDIO_ACCESS_TOKEN contains an unsupported character ` +
    `(${JSON.stringify(bad)}); the access gate accepts only [${ACCESS_TOKEN_CHARSET}]. ` +
    'Starting without the gate would leave the dashboard and every /api/* route ' +
    'UNAUTHENTICATED to anyone who can reach this server, including through a reverse ' +
    'proxy. Fix one of: replace the token with one from that set, e.g. ' +
    'STUDIO_ACCESS_TOKEN="$(openssl rand -hex 24)" (base64 output contains "+", "/" and ' +
    '"="); or unset STUDIO_ACCESS_TOKEN to run without a token. CLAWBOO_ALLOW_INSECURE=1 ' +
    'does not skip this check.'
  )
}
