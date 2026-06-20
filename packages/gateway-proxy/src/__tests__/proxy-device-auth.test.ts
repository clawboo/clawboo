// The proxy device-identity file holds an Ed25519 PRIVATE key. The create path
// writes it 0600; this suite proves the LOAD path re-hardens a file that was left
// world-readable by an older code path (or loosened on disk), so the key never
// lingers readable after an upgrade. Real path: drives loadOrCreateProxyDeviceIdentity.

import { chmodSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { getProxyDeviceIdentityPath, loadOrCreateProxyDeviceIdentity } from '../proxy-device-auth'

const itPosix = process.platform === 'win32' ? it.skip : it

describe('proxy device-identity perms', () => {
  let home: string
  let prevHome: string | undefined

  beforeEach(() => {
    home = mkdtempSync(path.join(os.tmpdir(), 'clawboo-devauth-'))
    prevHome = process.env['CLAWBOO_HOME']
    process.env['CLAWBOO_HOME'] = home
  })

  afterEach(() => {
    if (prevHome === undefined) delete process.env['CLAWBOO_HOME']
    else process.env['CLAWBOO_HOME'] = prevHome
    rmSync(home, { recursive: true, force: true })
  })

  itPosix('writes the identity file 0600 on create', async () => {
    await loadOrCreateProxyDeviceIdentity()
    const file = getProxyDeviceIdentityPath()
    expect(statSync(file).mode & 0o777).toBe(0o600)
  })

  itPosix('re-hardens a world-readable identity file to 0600 on load', async () => {
    // Create, then simulate a pre-fix world-readable file on disk.
    const first = await loadOrCreateProxyDeviceIdentity()
    const file = getProxyDeviceIdentityPath()
    chmodSync(file, 0o644)
    expect(statSync(file).mode & 0o777).toBe(0o644)

    // The load path must bring it back to 0600 (and return the same identity).
    const second = await loadOrCreateProxyDeviceIdentity()
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(second.deviceId).toBe(first.deviceId)
    expect(second.publicKey).toBe(first.publicKey)
  })
})
