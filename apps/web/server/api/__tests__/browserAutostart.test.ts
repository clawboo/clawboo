// The browsers a fresh install starts at boot, and the opt-out for them. Each
// one is a resident process, and on a machine with no browser installed they
// cannot browse anyway.
//
// `connectConnector` is replaced so nothing here downloads or runs an MCP
// server: the question is only whether the boot step asks for one.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const connectState = vi.hoisted(() => ({ slugs: [] as string[] }))
vi.mock('../../lib/connectors/supervisor', async (orig) => ({
  ...(await orig<typeof import('../../lib/connectors/supervisor')>()),
  connectConnector: async (_db: unknown, def: { slug: string }) => {
    connectState.slugs.push(def.slug)
    return { connector: {}, display: '' }
  },
}))

import { getDb, resetDb } from '../../lib/db'
import { saveUserSetting } from '../../lib/operatorSettings'
import { ensureBrowserConnectedAtBoot } from '../connectors'

describe('ensureBrowserConnectedAtBoot', () => {
  let home: string

  beforeEach(() => {
    connectState.slugs = []
    home = mkdtempSync(path.join(os.tmpdir(), 'clawboo-autostart-'))
    vi.stubEnv('CLAWBOO_HOME', home)
    resetDb()
    getDb()
  })
  afterEach(() => {
    resetDb()
    vi.unstubAllEnvs()
    rmSync(home, { recursive: true, force: true })
  })

  it('starts both browsers on an install that has never had one', async () => {
    await expect(ensureBrowserConnectedAtBoot(getDb())).resolves.toBe(2)
    expect(connectState.slugs.sort()).toEqual(['chrome-devtools', 'playwright'])
  })

  it('starts nothing with CLAWBOO_DISABLE_BROWSER_AUTOSTART=1', async () => {
    vi.stubEnv('CLAWBOO_DISABLE_BROWSER_AUTOSTART', '1')
    await expect(ensureBrowserConnectedAtBoot(getDb())).resolves.toBe(0)
    expect(connectState.slugs).toEqual([])
  })

  it('starts nothing when the operator file turns it off', async () => {
    writeFileSync(path.join(home, 'operator.json'), '{ "disableBrowserAutostart": true }')
    await expect(ensureBrowserConnectedAtBoot(getDb())).resolves.toBe(0)
    expect(connectState.slugs).toEqual([])
  })

  it("starts nothing when the person turned it off, and the operator's pin wins over them", async () => {
    saveUserSetting('disableBrowserAutostart', true, getDb())
    await expect(ensureBrowserConnectedAtBoot(getDb())).resolves.toBe(0)

    vi.stubEnv('CLAWBOO_DISABLE_BROWSER_AUTOSTART', '0')
    await expect(ensureBrowserConnectedAtBoot(getDb())).resolves.toBe(2)
  })
})
