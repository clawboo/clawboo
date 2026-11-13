// 1Password's SDK installs on first use into the runtimes folder and loads from
// there. A stand-in package committed with the runtimes folder's own functions
// proves the loader end to end with no network; the installer is replaced.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { commitRuntimeInstall, newInstallFolder } from '../../runtimeFolder'
import {
  connectOnePassword,
  onePasswordLoginFor,
  setOnePasswordClientFactory,
} from '../onePassword'
import {
  installOnePasswordSdk,
  ONE_PASSWORD_SDK,
  onePasswordSdkInstalled,
  ownOnePasswordSdkDir,
  sdkInstallErrorOf,
  setOnePasswordSdkInstallForTests,
} from '../onePasswordSdk'

const TOKEN = 'ops_stand-in-token-for-the-loader-test-0123456789'

let root: string
const prev: Record<string, string | undefined> = {}

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'clawboo-1p-sdk-'))
  for (const name of [
    'HOME',
    'CLAWBOO_HOME',
    'CLAWBOO_RUNTIMES_DIR',
    'CLAWBOO_WORK_DIR',
    'CLAWBOO_SECRETS_MASTER_KEY',
  ])
    prev[name] = process.env[name]
  process.env['HOME'] = root
  process.env['CLAWBOO_HOME'] = path.join(root, 'data')
  process.env['CLAWBOO_RUNTIMES_DIR'] = path.join(root, 'runtimes')
  process.env['CLAWBOO_WORK_DIR'] = path.join(root, 'work')
  delete process.env['CLAWBOO_SECRETS_MASTER_KEY']
  mkdirSync(path.join(root, 'data'), { recursive: true })
})

afterEach(() => {
  setOnePasswordSdkInstallForTests(null)
  setOnePasswordClientFactory(null)
  for (const [name, value] of Object.entries(prev)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  rmSync(root, { recursive: true, force: true })
})

/** A stand-in for @1password/sdk, installed the way an npm install leaves it. */
function installStandIn(): void {
  const folder = newInstallFolder(ONE_PASSWORD_SDK.id)
  const pkg = path.join(folder, 'node_modules', '@1password', 'sdk')
  mkdirSync(pkg, { recursive: true })
  writeFileSync(
    path.join(pkg, 'package.json'),
    JSON.stringify({ name: '@1password/sdk', version: '0.5.0', main: 'index.mjs', type: 'module' }),
  )
  writeFileSync(
    path.join(pkg, 'index.mjs'),
    `export async function createClient(config) {
  if (config.auth !== ${JSON.stringify(TOKEN)}) throw new Error('invalid service account token')
  return {
    vaults: { list: async () => [{ id: 'v1', title: 'Agents' }] },
    items: {
      list: async () => [{ id: 'i1', category: 'Login', websites: [{ url: 'https://shop.example', autofillBehavior: 'AnywhereOnWebsite' }] }],
      get: async () => ({ fields: [
        { id: 'username', title: 'username', fieldType: 'Text', value: 'stand-in-user' },
        { id: 'password', title: 'password', fieldType: 'Concealed', value: 'stand-in-password-value' },
      ] }),
    },
  }
}
`,
  )
  commitRuntimeInstall(ONE_PASSWORD_SDK.id, {
    folder,
    version: '0.5.0',
    source: ONE_PASSWORD_SDK.spec,
    launchers: {},
  })
}

describe("1Password's SDK in the runtimes folder", () => {
  it('pins the exact release', () => {
    expect(ONE_PASSWORD_SDK).toEqual({
      id: '1password-sdk',
      spec: '@1password/sdk@0.5.0',
      bins: [],
    })
  })

  it('without an install, connecting says the SDK is missing and saves nothing', async () => {
    expect(onePasswordSdkInstalled()).toBe(false)
    expect(await connectOnePassword('local', TOKEN)).toEqual({ ok: false, error: 'sdk_missing' })
  })

  it('loads the installed copy from the runtimes folder and uses it', async () => {
    installStandIn()
    expect(ownOnePasswordSdkDir()).toContain(path.join('runtimes', '1password-sdk'))
    expect(onePasswordSdkInstalled()).toBe(true)
    expect(await connectOnePassword('local', TOKEN)).toEqual({ ok: true, vaults: 1 })
    const found = await onePasswordLoginFor('https://shop.example', 'local')
    expect(found).toEqual({
      kind: 'found',
      login: { username: 'stand-in-user', password: 'stand-in-password-value', oneTimeCode: null },
    })
  })

  it('installs once however many people press Connect together', async () => {
    let calls = 0
    let done = false
    let release: () => void = () => undefined
    const gate = new Promise<void>((r) => (release = r))
    setOnePasswordSdkInstallForTests({
      install: async () => {
        calls += 1
        await gate
        done = true
        return { ok: true }
      },
      installed: () => done,
    })
    const a = installOnePasswordSdk()
    const b = installOnePasswordSdk()
    release()
    expect(await Promise.all([a, b])).toEqual([{ ok: true }, { ok: true }])
    expect(calls).toBe(1)
    expect(await installOnePasswordSdk()).toEqual({ ok: true })
    expect(calls).toBe(1)
  })

  it('tells a download the network stopped from any other failure', () => {
    for (const code of ['ENOTFOUND', 'ETIMEDOUT', 'E407', 'SELF_SIGNED_CERT_IN_CHAIN', 'EAI_AGAIN'])
      expect(sdkInstallErrorOf(code)).toBe('install_offline')
    for (const code of ['NPM_MISSING', 'RUNTIMES_DIR_REFUSED', 'EACCES', 'EXIT_1'])
      expect(sdkInstallErrorOf(code)).toBe('install_failed')
  })
})
