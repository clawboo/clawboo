// The agent-isolation exposure check reads the vault; it must never write it.
// A vault with saved entries and no master key yet (the key lost, or passed
// in the environment on another start) must not get a fresh key here: that
// would change the vault's state during a check and make every saved value
// undecryptable.

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { secretValuesForExposureCheck } from '../secretsVault'

describe('the exposure check over the vault', () => {
  let home: string
  beforeEach(() => {
    home = mkdtempSync(path.join(os.tmpdir(), 'vault-exposure-'))
    vi.stubEnv('CLAWBOO_HOME', home)
    vi.stubEnv('CLAWBOO_SECRETS_MASTER_KEY', '')
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    rmSync(home, { recursive: true, force: true })
  })

  it('does not create a master key for a vault that has entries but no key', () => {
    mkdirSync(path.join(home, 'secrets'), { recursive: true, mode: 0o700 })
    writeFileSync(
      path.join(home, 'secrets', 'runtime-keys.json'),
      JSON.stringify({
        OPENAI_API_KEY: {
          iv: Buffer.alloc(12, 1).toString('base64'),
          tag: Buffer.alloc(16, 2).toString('base64'),
          ciphertext: Buffer.from('sealed').toString('base64'),
        },
      }),
    )
    expect(secretValuesForExposureCheck()).toEqual([])
    expect(existsSync(path.join(home, 'secrets', 'master.key'))).toBe(false)
  })
})
