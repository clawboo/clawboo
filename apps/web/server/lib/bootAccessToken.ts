// Which token the server locks its access gate with, decided once at boot.
// Extracted from index.ts so it is unit-testable: index.ts calls main() at module
// top level, so importing anything from it would boot the whole server.

import { AccessTokenFileError, resolveAccessToken } from '@clawboo/config'

import { accessTokenRefusal } from './accessTokenRefusal'

export type BootAccessToken =
  | {
      ok: true
      /** `env`: STUDIO_ACCESS_TOKEN. `file`: the shared per-install token. `off`: no gate. */
      source: 'env' | 'file' | 'off'
      /** Undefined for `off`. */
      token: string | undefined
    }
  | { ok: false; message: string }

/**
 * STUDIO_ACCESS_TOKEN when it is set (a blank value turns the gate off, as it
 * always has), otherwise the per-install token in `<CLAWBOO_HOME>/access-token`,
 * created on the first start.
 *
 * Fails closed: a set token the gate cannot carry, or a token file that cannot
 * be trusted, is a SECURITY refusal to log before exiting. The file is never
 * replaced: the desktop app reads the same one.
 */
export function resolveBootAccessToken(env: NodeJS.ProcessEnv = process.env): BootAccessToken {
  let resolved
  try {
    resolved = resolveAccessToken({ env })
  } catch (err) {
    if (!(err instanceof AccessTokenFileError)) throw err
    // Fail closed: never start without the gate the operator did not turn off.
    return {
      ok: false,
      message:
        `SECURITY: refusing to start. ${err.message} Starting without the token would leave ` +
        'the dashboard and every /api/* route open to every program and user account on ' +
        'this computer.',
    }
  }
  if (resolved.source === 'off') return { ok: true, source: 'off', token: undefined }
  if (resolved.source === 'env') {
    const refusal = accessTokenRefusal(resolved.token)
    if (refusal) return { ok: false, message: refusal }
  }
  return { ok: true, source: resolved.source, token: resolved.token }
}
