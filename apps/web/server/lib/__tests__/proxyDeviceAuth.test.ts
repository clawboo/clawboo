// The proxy device identity file holds the Ed25519 PRIVATE signing key, so it
// must be persisted with restrictive perms (0600 file inside a 0700 dir) — the
// same posture as the secrets vault. Sandboxes CLAWBOO_HOME so the file is a
// throwaway. POSIX-only assertions (modes are advisory on Windows).

import { mkdtempSync, rmSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { loadOrCreateProxyDeviceIdentity } from '@clawboo/gateway-proxy'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const isWindows = process.platform === 'win32'

describe('proxy device identity — private key persisted with restrictive perms', () => {
  let home: string
  const prev = process.env['CLAWBOO_HOME']

  beforeEach(() => {
    home = mkdtempSync(path.join(os.tmpdir(), 'clawboo-proxyid-'))
    process.env['CLAWBOO_HOME'] = home
  })
  afterEach(() => {
    if (prev === undefined) delete process.env['CLAWBOO_HOME']
    else process.env['CLAWBOO_HOME'] = prev
    rmSync(home, { recursive: true, force: true })
  })

  it('writes proxy-device-identity.json as 0600 inside a 0700 dir', async () => {
    await loadOrCreateProxyDeviceIdentity()
    const file = path.join(home, 'proxy-device-identity.json')
    expect(statSync(file).isFile()).toBe(true)
    if (!isWindows) {
      expect(statSync(file).mode & 0o777).toBe(0o600)
      expect(statSync(home).mode & 0o777).toBe(0o700)
    }
  })
})
