// Website logins: the logins a person saves for their agents to sign in with,
// and their 1Password connection.
//
// Every route is a person's (the one person check), and acts for that person:
// the logins it lists, changes and removes are theirs, and what it saves is
// theirs. On an install with one person that is the built-in local person.
//
// NO RESPONSE CARRIES A VALUE. A login goes in once and is never read back: the
// list says where, whose label and whether a username or one-time code is set.
// An error answer is a code from a fixed list, never the request's own text and
// never an exception's message.

import type { Request, Response } from 'express'

import { actingPerson, refuseUnlessPerson } from '../lib/auth'
import { createLogger } from '@clawboo/logger'
import { agentBrowserFillAvailable } from '../lib/logins/browserLink'
import {
  connectOnePassword,
  disconnectOnePassword,
  onePasswordStatus,
} from '../lib/logins/onePassword'
import {
  installOnePasswordSdk,
  onePasswordSdkInstalled,
  onePasswordSdkInstalling,
} from '../lib/logins/onePasswordSdk'
import {
  addSavedLogin,
  listSavedLogins,
  removeSavedLogin,
  updateSavedLogin,
  type LoginPatch,
  type LoginWriteError,
  type SavedLoginMeta,
} from '../lib/logins/store'

const log = createLogger('website-logins-api')

const WRITE_STATUS: Record<LoginWriteError, number> = {
  invalid_site: 400,
  insecure_site: 400,
  missing_password: 400,
  too_long: 400,
  invalid_one_time_code: 400,
  exists: 409,
  not_found: 404,
}

/** What the dashboard is told about a login. The owner is implied: it is the caller. */
function publicMeta(m: SavedLoginMeta): Omit<SavedLoginMeta, 'ownerId'> {
  const { ownerId: _owner, ...rest } = m
  return rest
}

function bodyOf(req: Request): Record<string, unknown> {
  const b = req.body as unknown
  return b && typeof b === 'object' && !Array.isArray(b) ? (b as Record<string, unknown>) : {}
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)

// GET /api/website-logins
export function websiteLoginsGET(req: Request, res: Response): void {
  if (refuseUnlessPerson(req, res)) return
  try {
    const ownerId = actingPerson(req).id
    res.json({
      ok: true,
      logins: listSavedLogins(ownerId).map(publicMeta),
      onePassword: {
        ...onePasswordStatus(ownerId),
        // 1Password's SDK installs once, on the first Connect (see onePasswordSdk.ts).
        sdkInstalled: onePasswordSdkInstalled(),
        sdkInstalling: onePasswordSdkInstalling(),
      },
      // Whether an agent's browser can be filled on this install right now.
      fillAvailable: agentBrowserFillAvailable(),
    })
  } catch (err) {
    log.error({ err: err instanceof Error ? err.name : 'error' }, 'could not list website logins')
    res.status(500).json({ ok: false, error: 'unavailable' })
  }
}

// POST /api/website-logins
export function websiteLoginsPOST(req: Request, res: Response): void {
  if (refuseUnlessPerson(req, res)) return
  const body = bodyOf(req)
  const site = str(body['site'])
  const password = str(body['password'])
  if (!site || password === undefined) {
    res.status(400).json({ ok: false, error: 'invalid_body' })
    return
  }
  try {
    const r = addSavedLogin({
      site,
      username: str(body['username']) ?? null,
      password,
      oneTimeCodeSecret: str(body['oneTimeCodeSecret']) ?? null,
      label: str(body['label']) ?? null,
      ownerId: actingPerson(req).id,
    })
    if (!r.ok) {
      res.status(WRITE_STATUS[r.error]).json({ ok: false, error: r.error })
      return
    }
    res.status(201).json({ ok: true, login: publicMeta(r.login) })
  } catch (err) {
    log.error({ err: err instanceof Error ? err.name : 'error' }, 'could not save a website login')
    res.status(500).json({ ok: false, error: 'unavailable' })
  }
}

// PATCH /api/website-logins/:id
export function websiteLoginsPATCH(req: Request, res: Response): void {
  if (refuseUnlessPerson(req, res)) return
  const id = req.params['id']
  if (typeof id !== 'string' || !id) {
    res.status(400).json({ ok: false, error: 'invalid_body' })
    return
  }
  const body = bodyOf(req)
  const patch: LoginPatch = {}
  const site = str(body['site'])
  if (site !== undefined) patch.site = site
  const username = str(body['username'])
  if (username !== undefined) patch.username = username
  const password = str(body['password'])
  if (password !== undefined) patch.password = password
  if (body['oneTimeCodeSecret'] === null) patch.oneTimeCodeSecret = null
  else {
    const otp = str(body['oneTimeCodeSecret'])
    if (otp !== undefined) patch.oneTimeCodeSecret = otp
  }
  const label = str(body['label'])
  if (label !== undefined) patch.label = label
  try {
    const r = updateSavedLogin(id, actingPerson(req).id, patch)
    if (!r.ok) {
      res.status(WRITE_STATUS[r.error]).json({ ok: false, error: r.error })
      return
    }
    res.json({ ok: true, login: publicMeta(r.login) })
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.name : 'error' },
      'could not change a website login',
    )
    res.status(500).json({ ok: false, error: 'unavailable' })
  }
}

// DELETE /api/website-logins/:id
export function websiteLoginsDELETE(req: Request, res: Response): void {
  if (refuseUnlessPerson(req, res)) return
  const id = req.params['id']
  try {
    if (typeof id !== 'string' || !removeSavedLogin(id, actingPerson(req).id)) {
      res.status(404).json({ ok: false, error: 'not_found' })
      return
    }
    res.json({ ok: true })
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.name : 'error' },
      'could not remove a website login',
    )
    res.status(500).json({ ok: false, error: 'unavailable' })
  }
}

// POST /api/website-logins/sources/1password/install
// Download 1Password's SDK into the runtimes folder, once. Slow on the first call (a
// download of about 14 MB); a second call while one runs waits for the same one.
export async function onePasswordInstallPOST(req: Request, res: Response): Promise<void> {
  if (refuseUnlessPerson(req, res)) return
  try {
    const r = await installOnePasswordSdk()
    if (!r.ok) {
      res.status(502).json({ ok: false, error: r.error })
      return
    }
    res.json({ ok: true })
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.name : 'error' },
      'could not install the 1Password SDK',
    )
    res.status(500).json({ ok: false, error: 'install_failed' })
  }
}

// PUT /api/website-logins/sources/1password
export async function onePasswordPUT(req: Request, res: Response): Promise<void> {
  if (refuseUnlessPerson(req, res)) return
  const token = str(bodyOf(req)['token'])
  if (!token) {
    res.status(400).json({ ok: false, error: 'invalid_token' })
    return
  }
  try {
    const r = await connectOnePassword(actingPerson(req).id, token)
    if (!r.ok) {
      const status =
        r.error === 'invalid_token' || r.error === 'rejected'
          ? 400
          : r.error === 'sdk_missing'
            ? 409
            : 502
      res.status(status).json({ ok: false, error: r.error })
      return
    }
    res.json({ ok: true, vaults: r.vaults })
  } catch (err) {
    log.error({ err: err instanceof Error ? err.name : 'error' }, 'could not connect 1Password')
    res.status(500).json({ ok: false, error: 'unavailable' })
  }
}

// DELETE /api/website-logins/sources/1password
export function onePasswordDELETE(req: Request, res: Response): void {
  if (refuseUnlessPerson(req, res)) return
  try {
    disconnectOnePassword(actingPerson(req).id)
    res.json({ ok: true })
  } catch (err) {
    log.error({ err: err instanceof Error ? err.name : 'error' }, 'could not disconnect 1Password')
    res.status(500).json({ ok: false, error: 'unavailable' })
  }
}
