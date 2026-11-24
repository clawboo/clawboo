// The computer routes: links made only by a person, answered once, reaching one
// agent only, and the live view behind both ways in. Sandboxes $HOME and
// CLAWBOO_HOME so the sqlite db is a throwaway.

import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import type { IncomingMessage } from 'node:http'
import os from 'node:os'
import path from 'node:path'

import { agents } from '@clawboo/db'
import { createAccessGate } from '@clawboo/gateway-proxy'
import { eq } from 'drizzle-orm'
import type { Request, Response } from 'express'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { getDb, resetDb } from '../../lib/db'
import { resetControlForTests } from '../../lib/desktop/control'
import { LINK_HEADER, resetLinksForTests } from '../../lib/desktop/links'
import { desktopToolsPlan } from '../../lib/desktop/tools'
import { resetLiveViewForTests, setBrowserCaptureForTests } from '../../lib/desktop/liveView'
import {
  carriesComputerLink,
  computerLinkControlPOST,
  computerLinkDELETE,
  computerLinkInfoGET,
  computerLinkLiveGET,
  computerLinksPOST,
  computerStatusGET,
  computerToolsInstallPOST,
  displaysStatus,
  forgetAgentComputer,
} from '../computer'

function mockRes() {
  let code = 200
  let payload: unknown
  const headers: Record<string, string> = {}
  const res = {
    status(c: number) {
      code = c
      return this
    },
    json(b: unknown) {
      payload = b
      return this
    },
    setHeader(name: string, value: string) {
      headers[name.toLowerCase()] = value
    },
  } as unknown as Response
  return { res, status: () => code, body: () => payload as Record<string, unknown>, headers }
}

/** A response a live view can stream into. */
function streamRes() {
  const em = new EventEmitter()
  const chunks: string[] = []
  let status = 0
  const res = Object.assign(em, {
    setHeader() {},
    writeHead(s: number) {
      status = s
    },
    flushHeaders() {},
    write(c: string) {
      chunks.push(c)
      return true
    },
    end() {
      em.emit('close')
    },
    status(c: number) {
      status = c
      return this
    },
    json(b: unknown) {
      chunks.push(JSON.stringify(b))
      return this
    },
  }) as unknown as Response
  return { res, status: () => status, text: () => chunks.join('') }
}

const DASHBOARD = { 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors' }
function req(
  over: Omit<Partial<Request>, 'headers'> & {
    hdrs?: Record<string, string>
    headers?: Record<string, string>
  } = {},
): Request {
  const { hdrs, ...rest } = over
  const headers: Record<string, string> = { ...(over.headers ?? DASHBOARD), ...(hdrs ?? {}) }
  const r = Object.assign(new EventEmitter(), {
    params: {},
    query: {},
    body: {},
    method: 'GET',
    path: '/',
    ...rest,
    headers,
    get: (name: string) => headers[name.toLowerCase()],
  })
  return r as unknown as Request
}

let home: string
let prevHome: string | undefined

beforeEach(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), 'clawboo-computer-'))
  await mkdir(path.join(home, '.clawboo'), { recursive: true })
  prevHome = process.env['HOME']
  process.env['HOME'] = home
  process.env['CLAWBOO_HOME'] = path.join(home, '.clawboo')
  const now = Date.now()
  for (const [id, name] of [
    ['a1', 'Research Boo'],
    ['a2', 'Writer Boo'],
  ] as const) {
    getDb()
      .insert(agents)
      .values({
        id,
        name,
        gatewayId: id,
        sourceId: 'native',
        sourceAgentId: id,
        identityJson: JSON.stringify({ name }),
        status: 'idle',
        createdAt: now,
        updatedAt: now,
      })
      .run()
  }
  resetLinksForTests()
  resetControlForTests()
  resetLiveViewForTests()
  setBrowserCaptureForTests(async () => null)
})

afterEach(async () => {
  resetLiveViewForTests()
  setBrowserCaptureForTests(null)
  resetDb()
  if (prevHome === undefined) delete process.env['HOME']
  else process.env['HOME'] = prevHome
  delete process.env['CLAWBOO_HOME']
  await rm(home, { recursive: true, force: true }).catch(() => {})
})

async function mint(agentId: string, kind: string) {
  const r = mockRes()
  computerLinksPOST(req({ params: { agentId }, body: { kind } }), r.res)
  return r
}

describe('control links', () => {
  it('are refused while agents run as the server user, whose files a take over would reach', async () => {
    const r = await mint('a1', 'control')
    expect(r.status()).toBe(409)
    expect(String(r.body()['error'])).toMatch(/CLAWBOO_AGENT_USER/)
    const s = mockRes()
    computerStatusGET(req({ params: { agentId: 'a1' } }), s.res)
    expect(s.body()['controlLinks']).toMatchObject({ allowed: false })
  })

  it('are made when agents run as their own OS user', async () => {
    const prev = process.env['CLAWBOO_AGENT_USER']
    process.env['CLAWBOO_AGENT_USER'] = 'clawboo-agent'
    try {
      expect((await mint('a1', 'control')).status()).toBe(201)
    } finally {
      if (prev === undefined) delete process.env['CLAWBOO_AGENT_USER']
      else process.env['CLAWBOO_AGENT_USER'] = prev
    }
  })
})

describe('computer links', () => {
  it('are made only by a person, and the token is answered once, never cached', async () => {
    const r = await mint('a1', 'view')
    expect(r.status()).toBe(201)
    const token = r.body()['token'] as string
    expect(token).toMatch(/^cbcl_/)
    expect(r.headers['cache-control']).toBe('no-store')

    // Not listed again anywhere.
    const s = mockRes()
    computerStatusGET(req({ params: { agentId: 'a1' } }), s.res)
    expect(JSON.stringify(s.body())).not.toContain(token)
    expect((s.body()['links'] as unknown[]).length).toBe(1)

    // A request the person check does not take for the dashboard cannot make one.
    const denied = mockRes()
    computerLinksPOST(
      req({ params: { agentId: 'a1' }, body: { kind: 'view' }, headers: {} }),
      denied.res,
    )
    expect(denied.status()).toBe(403)
  })

  it('refuses a kind that is not view or control, and an unknown agent', async () => {
    expect((await mint('a1', 'admin')).status()).toBe(400)
    expect((await mint('nope', 'view')).status()).toBe(404)
  })

  it('a link reaches its own agent and says what it is, and nothing once revoked', async () => {
    const made = await mint('a1', 'view')
    const token = made.body()['token'] as string
    const linkId = (made.body()['link'] as { id: string }).id

    const info = mockRes()
    computerLinkInfoGET(req({ hdrs: { [LINK_HEADER]: token } }), info.res)
    expect(info.body()).toMatchObject({ ok: true, kind: 'view', agent: { name: 'Research Boo' } })

    // The gate's hook: admits the link, by header only.
    expect(
      carriesComputerLink({ headers: { [LINK_HEADER]: token } } as unknown as IncomingMessage),
    ).toBe(true)
    expect(
      carriesComputerLink({
        headers: { [LINK_HEADER]: token + 'x' },
      } as unknown as IncomingMessage),
    ).toBe(false)

    // Revoking it from another agent's page does nothing.
    const wrong = mockRes()
    computerLinkDELETE(req({ params: { agentId: 'a2', linkId } }), wrong.res)
    expect(wrong.status()).toBe(404)

    const revoked = mockRes()
    computerLinkDELETE(req({ params: { agentId: 'a1', linkId } }), revoked.res)
    expect(revoked.status()).toBe(200)
    const after = mockRes()
    computerLinkInfoGET(req({ hdrs: { [LINK_HEADER]: token } }), after.res)
    expect(after.status()).toBe(401)
    expect(
      carriesComputerLink({ headers: { [LINK_HEADER]: token } } as unknown as IncomingMessage),
    ).toBe(false)
  })

  it('a link opens a live view of its own agent only, and is closed by the agent going away', async () => {
    const token = (await mint('a1', 'view')).body()['token'] as string
    const s = streamRes()
    computerLinkLiveGET(req({ hdrs: { [LINK_HEADER]: token } }), s.res)
    expect(s.status()).toBe(200)
    expect(s.text()).toContain('event: hello')
    expect(s.text()).toContain('"source":"browser"')
    expect(s.text()).toContain('"canControl":false')

    forgetAgentComputer('a1')
    expect(s.text()).toContain('event: end')
    const info = mockRes()
    computerLinkInfoGET(req({ hdrs: { [LINK_HEADER]: token } }), info.res)
    expect(info.status()).toBe(401)
  })

  it('stop working when the agent is archived, or its id comes back on another agent', async () => {
    const token = (await mint('a1', 'view')).body()['token'] as string
    const asks = () => {
      const r = mockRes()
      computerLinkInfoGET(req({ hdrs: { [LINK_HEADER]: token } }), r.res)
      return r.status()
    }
    expect(asks()).toBe(200)
    getDb()
      .update(agents)
      .set({ archivedAt: Date.now(), status: 'archived' })
      .where(eq(agents.id, 'a1'))
      .run()
    expect(asks()).toBe(401)
    // Deleted, then a new agent made under the same id.
    getDb().delete(agents).where(eq(agents.id, 'a1')).run()
    getDb()
      .insert(agents)
      .values({
        id: 'a1',
        name: 'Someone Else',
        gatewayId: 'a1',
        sourceId: 'native',
        sourceAgentId: 'a1',
        identityJson: '{}',
        status: 'idle',
        createdAt: Date.now() + 5_000,
        updatedAt: Date.now() + 5_000,
      })
      .run()
    expect(asks()).toBe(401)
    expect(
      carriesComputerLink({ headers: { [LINK_HEADER]: token } } as unknown as IncomingMessage),
    ).toBe(false)
  })

  it('serves an agent brought back from archived, whose status still says archived', async () => {
    getDb()
      .update(agents)
      .set({ archivedAt: null, status: 'archived' })
      .where(eq(agents.id, 'a1'))
      .run()
    const s = mockRes()
    computerStatusGET(req({ params: { agentId: 'a1' } }), s.res)
    expect(s.status()).toBe(200)
  })

  it('answers every link route with no-store, varying on the link', async () => {
    const token = (await mint('a1', 'view')).body()['token'] as string
    const r = mockRes()
    computerLinkInfoGET(req({ hdrs: { [LINK_HEADER]: token } }), r.res)
    expect(r.headers['cache-control']).toBe('no-store')
    expect(r.headers['vary']).toBe(LINK_HEADER)
  })

  it('refuses a live view through no link or a bad one', () => {
    const headers: Record<string, string>[] = [{}, { [LINK_HEADER]: 'cbcl_nothing' }]
    for (const header of headers) {
      const s = streamRes()
      computerLinkLiveGET(req({ hdrs: header }), s.res)
      expect(s.status()).toBe(401)
      expect(s.text()).not.toContain('event: hello')
    }
  })
})

describe('connectorPlaceRefusal', () => {
  it('refuses a Linux-only driver elsewhere, without agent users, and before it is installed', async () => {
    const { connectorPlaceRefusal } = await import('../connectors')
    const { connectorBySlug } = await import('@clawboo/connector-catalog')
    const def = connectorBySlug('cua-driver')!
    expect(connectorPlaceRefusal(def, 'darwin')).toMatchObject({ reason: 'unsupported-platform' })
    // Its typing would reach a browser that runs as the person running Clawboo.
    expect(connectorPlaceRefusal(def, 'linux', false)).toMatchObject({
      reason: 'needs-agent-user',
      error: expect.stringMatching(/CLAWBOO_AGENT_USER/),
    })
    // The test runtimes folder is empty and nothing named cua-driver is on PATH.
    expect(connectorPlaceRefusal(def, 'linux', true)).toMatchObject({ reason: 'not-installed' })

    // Installed, but agents get no screen here (no Xvnc on this test machine):
    // every call would fail, so it is not connected.
    const runtimes = path.join(home, 'rt')
    process.env['CLAWBOO_RUNTIMES_DIR'] = runtimes
    try {
      const rf = await import('../../lib/runtimeFolder')
      const folder = rf.newInstallFolder('desktop')
      const bin = path.join(folder, 'cua-driver')
      await writeFile(bin, '#!/bin/sh\n', { mode: 0o755 })
      rf.commitRuntimeInstall('desktop', {
        folder,
        version: 'cua-driver 0.38.0',
        source: 'test',
        launchers: { 'cua-driver': { command: bin, args: [] } },
      })
      expect(connectorPlaceRefusal(def, 'linux', true)).toMatchObject({
        reason: 'no-display',
        error: expect.stringMatching(/agents get none here/),
      })
    } finally {
      delete process.env['CLAWBOO_RUNTIMES_DIR']
    }
    expect(connectorPlaceRefusal(connectorBySlug('playwright')!, 'darwin')).toBeNull()
  })

  it('takes the driver an administrator named in place of an install, and refuses one that fails its check', async () => {
    const { connectorPlaceRefusal } = await import('../connectors')
    const { connectorBySlug } = await import('@clawboo/connector-catalog')
    const screens = await import('../../lib/desktop/screenSettings')
    const def = connectorBySlug('cua-driver')!
    const named = '/opt/cua-driver/cua-driver'
    process.env['CLAWBOO_CUA_DRIVER_PATH'] = named
    const trusted = {
      lstat: (p: string) =>
        ({
          uid: 0,
          mode: 0o755,
          isFile: () => p === named,
          isDirectory: () => p !== named,
        }) as never,
      realpath: (p: string) => p,
      canExecute: () => true,
      uid: 0,
    }
    try {
      // Nothing installed: the named driver passes the install check (and stops
      // only at "no screen here", since this test machine has no Xvnc).
      screens.setProgramCheckDepsForTests(trusted)
      expect(connectorPlaceRefusal(def, 'linux', true)).toMatchObject({ reason: 'no-display' })
      screens.setProgramCheckDepsForTests({ ...trusted, realpath: () => '/tmp/other' })
      expect(connectorPlaceRefusal(def, 'linux', true)).toMatchObject({
        reason: 'named-program-refused',
        error: expect.stringMatching(/administrator named may not run.*is a link/),
      })
    } finally {
      screens.setProgramCheckDepsForTests(null)
      delete process.env['CLAWBOO_CUA_DRIVER_PATH']
    }
  })
})

describe('displaysStatus', () => {
  const tools = { xvnc: '/usr/bin/Xvnc', windowManager: null, dbusDaemon: null }
  const noXvnc = { ok: false as const, code: 'no-xvnc' as const, reason: 'No Xvnc' }

  it('offers the install only where it would give agents a screen', () => {
    const x64 = desktopToolsPlan('linux', 'x64')
    const arm = desktopToolsPlan('linux', 'arm64')
    const none = desktopToolsPlan('darwin', 'arm64')
    expect(displaysStatus(noXvnc, x64, null, false)).toMatchObject({ installable: true })
    // TigerVNC has no arm64 build: installing would add Cua Driver and no screen.
    expect(displaysStatus(noXvnc, arm, null, false)).toMatchObject({ installable: false })
    // An operator turned displays off: installing changes nothing.
    expect(
      displaysStatus({ ok: false, code: 'off', reason: 'off' }, x64, null, false),
    ).toMatchObject({ installable: false })
    expect(
      displaysStatus({ ok: false, code: 'platform', reason: 'Linux only' }, none, null, false),
    ).toMatchObject({ installable: false })
  })

  it('offers Cua Driver alone where displays work and it is not installed', () => {
    const arm = desktopToolsPlan('linux', 'arm64')
    expect(displaysStatus({ ok: true, tools }, arm, null, false, true)).toMatchObject({
      available: true,
      driverInstallable: true,
    })
    expect(displaysStatus({ ok: true, tools }, arm, null, true, true)).toMatchObject({
      driverInstallable: false,
    })
    // Without agents on their own OS user the driver may not run: not offered.
    expect(displaysStatus({ ok: true, tools }, arm, null, false, false)).toMatchObject({
      driverInstallable: false,
    })
  })
})

describe("computerLinks, the administrator's switch for links", () => {
  const ENV = 'CLAWBOO_COMPUTER_LINKS'
  let prevAgentUser: string | undefined
  beforeEach(() => {
    prevAgentUser = process.env['CLAWBOO_AGENT_USER']
  })
  afterEach(() => {
    delete process.env[ENV]
    if (prevAgentUser === undefined) delete process.env['CLAWBOO_AGENT_USER']
    else process.env['CLAWBOO_AGENT_USER'] = prevAgentUser
  })

  /** A cookieless request to the access gate, from another machine, with a link. */
  function gateReq(url: string, token: string): IncomingMessage {
    return {
      url,
      method: 'GET',
      headers: { host: 'dash.local', [LINK_HEADER]: token },
      socket: { remoteAddress: '203.0.113.7' },
    } as unknown as IncomingMessage
  }
  function gateRes() {
    const res = { statusCode: 200, setHeader() {}, end() {} }
    return res as unknown as import('node:http').ServerResponse & { statusCode: number }
  }
  const linkReq = (token: string) =>
    ({ headers: { [LINK_HEADER]: token } }) as unknown as IncomingMessage

  it('off: no link is made, and one made before opens nothing, at the access gate too', async () => {
    const token = (await mint('a1', 'view')).body()['token'] as string
    const gate = createAccessGate({
      token: 'operator-token-0123456789',
      authorizeLink: carriesComputerLink,
    })
    // On: the gate admits it without the cookie.
    expect(gate.handleHttp(gateReq('/api/computer-link/info', token), gateRes())).toBe(false)

    process.env[ENV] = 'off'
    expect(carriesComputerLink(linkReq(token))).toBe(false)
    for (const url of [
      '/api/computer-link/info',
      '/api/computer-link/live',
      '/api/computer-link/input',
    ]) {
      const res = gateRes()
      expect(gate.handleHttp(gateReq(url, token), res)).toBe(true)
      expect(res.statusCode).toBe(401)
    }
    // With the gate off (no access token), the route refuses the link itself.
    const info = mockRes()
    computerLinkInfoGET(req({ headers: { [LINK_HEADER]: token } }), info.res)
    expect(info.status()).toBe(401)
    const live = streamRes()
    computerLinkLiveGET(req({ headers: { [LINK_HEADER]: token } }), live.res)
    expect(live.status()).toBe(401)

    process.env['CLAWBOO_AGENT_USER'] = 'clawboo-agent'
    for (const kind of ['view', 'control']) {
      const r = await mint('a1', kind)
      expect(r.status()).toBe(403)
      expect(String(r.body()['error'])).toMatch(/CLAWBOO_COMPUTER_LINKS=off/)
    }
    const s = mockRes()
    computerStatusGET(req({ params: { agentId: 'a1' } }), s.res)
    expect(s.body()['viewLinks']).toMatchObject({ allowed: false })
    expect(s.body()['controlLinks']).toMatchObject({ allowed: false })
  })

  it('view: control links are neither made nor honoured, and view links still work', async () => {
    process.env['CLAWBOO_AGENT_USER'] = 'clawboo-agent'
    const control = (await mint('a1', 'control')).body()['token'] as string
    const view = (await mint('a1', 'view')).body()['token'] as string

    process.env[ENV] = 'view'
    expect(carriesComputerLink(linkReq(control))).toBe(false)
    expect(carriesComputerLink(linkReq(view))).toBe(true)
    const take = mockRes()
    computerLinkControlPOST(
      req({
        method: 'POST',
        headers: { [LINK_HEADER]: control },
        body: { viewerId: 'v1', action: 'take' },
      }),
      take.res,
    )
    expect(take.status()).toBe(401)

    const refused = await mint('a1', 'control')
    expect(refused.status()).toBe(403)
    expect(String(refused.body()['error'])).toMatch(/CLAWBOO_COMPUTER_LINKS=view/)
    expect((await mint('a1', 'view')).status()).toBe(201)
    const s = mockRes()
    computerStatusGET(req({ params: { agentId: 'a1' } }), s.res)
    expect(s.body()['viewLinks']).toMatchObject({ allowed: true })
    expect(s.body()['controlLinks']).toMatchObject({ allowed: false })
  })

  it('a value it cannot read turns links off rather than on', async () => {
    const token = (await mint('a1', 'view')).body()['token'] as string
    process.env[ENV] = 'sometimes'
    expect(carriesComputerLink(linkReq(token))).toBe(false)
  })
})

describe("the administrator's download switch", () => {
  const tools = { xvnc: '/usr/bin/Xvnc', windowManager: null, dbusDaemon: null }
  const noXvnc = { ok: false as const, code: 'no-xvnc' as const, reason: 'No Xvnc' }
  afterEach(() => {
    delete process.env['CLAWBOO_DISABLE_DESKTOP_TOOLS_INSTALL']
    delete process.env['CLAWBOO_XVNC_PATH']
    delete process.env['CLAWBOO_CUA_DRIVER_PATH']
  })

  it('offers no download when turned off, or of a tool whose program is named', () => {
    const x64 = desktopToolsPlan('linux', 'x64')
    process.env['CLAWBOO_DISABLE_DESKTOP_TOOLS_INSTALL'] = '1'
    expect(displaysStatus(noXvnc, x64, null, false)).toMatchObject({ installable: false })
    expect(displaysStatus({ ok: true, tools }, x64, null, false, true)).toMatchObject({
      driverInstallable: false,
    })
    delete process.env['CLAWBOO_DISABLE_DESKTOP_TOOLS_INSTALL']
    process.env['CLAWBOO_XVNC_PATH'] = '/opt/vnc/bin/Xvnc'
    expect(displaysStatus(noXvnc, x64, null, false)).toMatchObject({ installable: false })
    process.env['CLAWBOO_CUA_DRIVER_PATH'] = '/opt/cua/cua-driver'
    expect(displaysStatus({ ok: true, tools }, x64, null, false, true)).toMatchObject({
      driverInstallable: false,
    })
  })

  it('refuses the install route outright when turned off', async () => {
    process.env['CLAWBOO_DISABLE_DESKTOP_TOOLS_INSTALL'] = 'true'
    const r = mockRes()
    await computerToolsInstallPOST(req({ method: 'POST' }), r.res)
    expect(r.status()).toBe(403)
    expect(r.body()).toMatchObject({ ok: false, code: 'TURNED_OFF' })
  })
})
