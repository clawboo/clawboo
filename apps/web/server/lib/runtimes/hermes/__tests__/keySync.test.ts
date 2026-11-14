// A key change reaches Hermes's profiles as the keys stand when each profile is
// written, so a refresh begun before a Disconnect cannot write the removed key
// back after it.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { deleteRuntimeSecret, setRuntimeSecret } from '../../../secretsVault'
import { syncHermesProfileKeys } from '../index'
import { hermesGatewayHome, renderProfileEnv } from '../profiles'

const SAVED = [
  'CLAWBOO_HOME',
  'CLAWBOO_RUNTIMES_DIR',
  'CLAWBOO_WORK_DIR',
  'CLAWBOO_AGENT_USER',
  'OPENCLAW_STATE_DIR',
  'HERMES_HOME',
  'OPENROUTER_API_KEY',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
] as const

describe('syncHermesProfileKeys', () => {
  let root: string
  const prev: Record<string, string | undefined> = {}

  beforeEach(() => {
    for (const k of SAVED) prev[k] = process.env[k]
    for (const k of SAVED) delete process.env[k]
    root = mkdtempSync(path.join(os.tmpdir(), 'clawboo-hermes-keysync-'))
    process.env['CLAWBOO_HOME'] = path.join(root, 'data')
    // Keeps OpenClaw's own .env (a key fallback) out of reach.
    process.env['OPENCLAW_STATE_DIR'] = path.join(root, 'openclaw')
    process.env['HERMES_HOME'] = path.join(root, 'hermes')
  })
  afterEach(() => {
    for (const k of SAVED) {
      if (prev[k] === undefined) delete process.env[k]
      else process.env[k] = prev[k]
    }
    rmSync(root, { recursive: true, force: true })
  })

  it('writes the keys held when the write runs, not when the sync began', async () => {
    const dir = path.join(hermesGatewayHome(), 'profiles', 'cb-agent-1')
    mkdirSync(dir, { recursive: true })
    const env = path.join(dir, '.env')
    writeFileSync(
      env,
      renderProfileEnv({
        key: 'k'.repeat(64),
        cwd: null,
        providerEnv: { OPENROUTER_API_KEY: 'sk-or-removed' },
      }),
    )
    setRuntimeSecret('OPENROUTER_API_KEY', 'sk-or-removed')
    // A sync begun while the key was held (a Connect), then the key removed
    // before that sync reached the profile (a Disconnect).
    const pending = syncHermesProfileKeys()
    deleteRuntimeSecret('OPENROUTER_API_KEY')
    await pending
    expect(readFileSync(env, 'utf8')).not.toContain('sk-or-removed')
  })
})
