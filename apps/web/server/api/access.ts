/**
 * apps/web/server/api/access.ts
 *
 * POST /api/access/launch-code: a one-time code that signs a browser in.
 * GET /api/access/identity: who the sign-in proxy says sent this request.
 *
 * `clawboo open` calls it with the access token as its cookie, then opens
 * `/?access_code=<code>`; the dashboard's "Open on another device" calls it for a
 * link and a QR code. The access gate trades the code for the cookie once, on a
 * page URL, within two minutes, so the token itself never goes into a URL or an
 * opener's arguments. Like every /api/ route it sits behind the gate, so only a
 * caller that already holds the cookie can mint one.
 */
import type { Request, Response } from 'express'

import type { AccessGate } from '@clawboo/gateway-proxy'

import { actingPerson, personOf } from '../lib/auth'
import { controlClaimRequired, personCheckMode } from '../lib/personCheck'
import { appLinkOn, proxyIdentityMode, readerKeyOn } from '../lib/proxyIdentity/config'
import { accessEnded, isGuestOnly, permissionsOf, sortedPermissions } from '../lib/roles/policy'

/** The gate ../index.ts publishes on `app.locals`. */
function gateOf(req: Request): Pick<AccessGate, 'enabled' | 'mintLaunchCode'> | null {
  const gate = req.app.locals['accessGate'] as
    Pick<AccessGate, 'enabled' | 'mintLaunchCode'> | undefined
  return gate ?? null
}

export function accessLaunchCodePOST(req: Request, res: Response): void {
  res.set('Cache-Control', 'no-store')
  const minted = gateOf(req)?.mintLaunchCode() ?? null
  // No gate, no code: the plain address already opens the dashboard.
  if (minted === null) {
    res.json({ gated: false })
    return
  }
  res.json({
    gated: true,
    code: minted.code,
    expiresAt: minted.expiresAt,
    // Relative, so a browser on a machine whose clock differs can count down.
    expiresInMs: minted.expiresInMs,
  })
}

/**
 * The proxy identity lane's mode (`off`, `on` or `required`), whether the app
 * that started this engine has an app link, and the person this request's
 * verified token names, or null. An administrator checks a new proxy with it,
 * and an app its link; the dashboard can say who is signed in, and whose tasks
 * are its own.
 *
 * `personCheck` says who may act as the person: `page` (the dashboard's own page
 * too) or `verified` (only a verified token), so a page reached around the
 * sign-in proxy can say why it may not act. `controlClaim` says whether taking
 * over an agent's screen needs the proxy's `control` claim. `readerKey` says
 * whether a program running beside the server may make its own reads with a
 * key of its own (proxyIdentityReaderPublicKey).
 *
 * With roles enforced (`roles: "enforce"`) it also says what this person may do,
 * so the dashboard shows only that: their roles, their permissions (an empty
 * list for a token with no role this engine knows, or a guest whose access has
 * ended), and for a guest the teams they reach and when that ends.
 */
export function accessIdentityGET(req: Request, res: Response): void {
  res.set('Cache-Control', 'no-store')
  const enforced = req.app.locals['rolesMode'] === 'enforce'
  const access = req.access ?? null
  const now = Date.now()
  // `you` is who "Assigned to you" and the Mine filter mean: the verified person,
  // else the install's built-in one.
  res.json({
    proxyIdentity: proxyIdentityMode(),
    appLink: appLinkOn(),
    roles: enforced ? 'enforce' : 'off',
    personCheck: personCheckMode(),
    controlClaim: controlClaimRequired() ? 'required' : 'off',
    readerKey: readerKeyOn(),
    person: personOf(req),
    you: actingPerson(req),
    ...(enforced
      ? {
          // A service token's program, which is never a person.
          service: req.service ?? null,
          access: access
            ? {
                roles: access.roles,
                label: access.label,
                permissions: sortedPermissions(permissionsOf(access, now)),
                guest: isGuestOnly(access),
                teams: isGuestOnly(access) ? (access.teams ?? []) : null,
                accessUntil: isGuestOnly(access) ? access.until : null,
                ended: accessEnded(access, now),
                service: access.service,
              }
            : null,
        }
      : {}),
  })
}
