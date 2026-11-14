// The website-login routes: a person's own, and no response body ever carries a
// username, password, one-time-code secret or 1Password token, success or error.

import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import type { Request, Response } from 'express'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { setOnePasswordClientFactory } from '../../lib/logins/onePassword'
import { setOnePasswordSdkInstallForTests } from '../../lib/logins/onePasswordSdk'
import { loginSecretFor } from '../../lib/logins/store'
import {
  onePasswordDELETE,
  onePasswordInstallPOST,
  onePasswordPUT,
  websiteLoginsDELETE,
  websiteLoginsGET,
  websiteLoginsPATCH,
  websiteLoginsPOST,
} from '../websiteLogins'

const DASHBOARD = { 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors' }
const ADA = { id: 'user-ada', name: 'Ada', role: 'member' }
const USERNAME = 'route.tester@example.com'
const PASSWORD = 'route-test-password-55aa66bb'
const OTP = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP'
const TOKEN = 'ops_route-test-token-0123456789abcdef'

function mockRes() {
  let status = 200
  let payload: unknown
  const res = {
    status(c: number) {
      status = c
      return this
    },
    json(b: unknown) {
      payload = b
      return this
    },
  } as unknown as Response
  return { res, code: () => status, body: () => payload as Record<string, unknown> }
}

const req = (over: {
  params?: Record<string, string>
  body?: unknown
  headers?: Record<string, string>
  person?: typeof ADA | null
}): Request =>
  ({
    params: {},
    query: {},
    body: {},
    headers: DASHBOARD,
    person: null,
    app: { locals: {} },
    get: () => undefined,
    socket: {},
    ...over,
  }) as unknown as Request

/** Every body the routes answered, to look for a value in. */
const answered: unknown[] = []
async function call(
  handler: (rq: Request, rs: Response) => void | Promise<void>,
  over: Parameters<typeof req>[0] = {},
) {
  const r = mockRes()
  await handler(req(over), r.res)
  answered.push(r.body())
  return r
}

let home: string
const prev: Record<string, string | undefined> = {}
beforeEach(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), 'clawboo-login-routes-'))
  for (const name of ['HOME', 'CLAWBOO_HOME', 'CLAWBOO_SECRETS_MASTER_KEY']) {
    prev[name] = process.env[name]
  }
  process.env['HOME'] = home
  process.env['CLAWBOO_HOME'] = home
  delete process.env['CLAWBOO_SECRETS_MASTER_KEY']
  answered.length = 0
})
afterEach(async () => {
  setOnePasswordClientFactory(null)
  setOnePasswordSdkInstallForTests(null)
  for (const [name, value] of Object.entries(prev)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  await rm(home, { recursive: true, force: true })
})

describe('website-login routes', () => {
  it('refuse a caller that may not act as a person', async () => {
    for (const handler of [
      websiteLoginsGET,
      websiteLoginsPOST,
      websiteLoginsPATCH,
      websiteLoginsDELETE,
      onePasswordPUT,
      onePasswordDELETE,
    ]) {
      const r = await call(handler, {
        headers: {},
        body: { site: 'a.example', password: PASSWORD },
      })
      expect(r.code()).toBe(403)
      expect(r.body()).toEqual({ ok: false, error: 'person_only' })
    }
    expect(loginSecretFor('https://a.example', 'local')).toBeNull()
  })

  it('save, list, edit and remove a login without ever answering with a value', async () => {
    const saved = await call(websiteLoginsPOST, {
      body: {
        site: 'bank.example',
        username: USERNAME,
        password: PASSWORD,
        oneTimeCodeSecret: OTP,
        label: 'Bank',
      },
    })
    expect(saved.code()).toBe(201)
    const id = (saved.body()['login'] as { id: string }).id

    const listed = await call(websiteLoginsGET)
    expect(listed.body()).toMatchObject({
      ok: true,
      logins: [
        {
          id,
          origin: 'https://bank.example',
          label: 'Bank',
          hasUsername: true,
          hasOneTimeCode: true,
        },
      ],
      onePassword: { connected: false },
      fillAvailable: false,
    })
    expect(JSON.stringify(listed.body())).not.toContain('ownerId')

    const edited = await call(websiteLoginsPATCH, {
      params: { id },
      body: { label: 'Main', oneTimeCodeSecret: null },
    })
    expect(edited.body()).toMatchObject({
      ok: true,
      login: { label: 'Main', hasOneTimeCode: false },
    })
    expect(loginSecretFor('https://bank.example', 'local')?.password).toBe(PASSWORD)

    const dup = await call(websiteLoginsPOST, {
      body: { site: 'https://bank.example', password: PASSWORD },
    })
    expect(dup.code()).toBe(409)
    expect(dup.body()).toEqual({ ok: false, error: 'exists' })

    const bad = await call(websiteLoginsPOST, {
      body: { site: 'http://plain.example', password: PASSWORD },
    })
    expect(bad.body()).toEqual({ ok: false, error: 'insecure_site' })

    const removed = await call(websiteLoginsDELETE, { params: { id } })
    expect(removed.body()).toEqual({ ok: true })
    expect((await call(websiteLoginsGET)).body()['logins']).toEqual([])

    const all = JSON.stringify(answered)
    for (const v of [USERNAME, PASSWORD, OTP]) expect(all).not.toContain(v)
  })

  it("act for the vouched person: one person's logins are not another's", async () => {
    await call(websiteLoginsPOST, {
      person: ADA,
      headers: {},
      body: { site: 'bank.example', password: PASSWORD },
    })
    expect(loginSecretFor('https://bank.example', ADA.id)?.password).toBe(PASSWORD)
    expect((await call(websiteLoginsGET)).body()['logins']).toEqual([])
    const adas = (await call(websiteLoginsGET, { person: ADA, headers: {} })).body()['logins'] as {
      id: string
    }[]
    expect(adas).toHaveLength(1)
    const stolen = await call(websiteLoginsDELETE, { params: { id: adas[0]!.id } })
    expect(stolen.code()).toBe(404)
  })

  it('connect 1Password after checking the token, and never answer with it', async () => {
    setOnePasswordClientFactory(async (token) => {
      if (token !== TOKEN) throw new Error(`invalid service account token ${token}`)
      return {
        listVaultIds: async () => ['v1', 'v2'],
        listLoginItems: async () => [],
        getItem: async () => ({ fields: [] }),
      }
    })
    const wrong = await call(onePasswordPUT, { body: { token: `${TOKEN}-wrong` } })
    expect(wrong.code()).toBe(400)
    expect(wrong.body()).toEqual({ ok: false, error: 'rejected' })

    const ok = await call(onePasswordPUT, { body: { token: TOKEN } })
    expect(ok.body()).toEqual({ ok: true, vaults: 2 })
    expect((await call(websiteLoginsGET)).body()['onePassword']).toMatchObject({ connected: true })

    await call(onePasswordDELETE)
    expect((await call(websiteLoginsGET)).body()['onePassword']).toMatchObject({ connected: false })
    expect(JSON.stringify(answered)).not.toContain(TOKEN)
  })

  it('an unreachable 1Password is a 502 that saves nothing and quotes nothing', async () => {
    setOnePasswordClientFactory(async () => {
      throw new Error(`connect ETIMEDOUT while sending ${TOKEN}`)
    })
    const r = await call(onePasswordPUT, { body: { token: TOKEN } })
    expect(r.code()).toBe(502)
    expect(r.body()).toEqual({ ok: false, error: 'unreachable' })
    expect((await call(websiteLoginsGET)).body()['onePassword']).toMatchObject({ connected: false })
    expect(JSON.stringify(answered)).not.toContain(TOKEN)
  })

  it('installs 1Password support on request and says why it could not', async () => {
    let installed = false
    let answer: { ok: true } | { ok: false; error: 'install_offline' | 'install_failed' } = {
      ok: false,
      error: 'install_offline',
    }
    setOnePasswordSdkInstallForTests({
      install: async () => {
        if (answer.ok) installed = true
        return answer
      },
      installed: () => installed,
    })
    expect((await call(websiteLoginsGET)).body()['onePassword']).toMatchObject({
      sdkInstalled: false,
      sdkInstalling: false,
    })
    const offline = await call(onePasswordInstallPOST)
    expect(offline.code()).toBe(502)
    expect(offline.body()).toEqual({ ok: false, error: 'install_offline' })
    answer = { ok: true }
    const ok = await call(onePasswordInstallPOST)
    expect(ok.body()).toEqual({ ok: true })
    expect((await call(websiteLoginsGET)).body()['onePassword']).toMatchObject({
      sdkInstalled: true,
    })
    const refused = await call(onePasswordInstallPOST, { headers: {} })
    expect(refused.code()).toBe(403)
  })
})
