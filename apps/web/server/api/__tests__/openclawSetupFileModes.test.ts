// The OpenClaw setup routes write the gateway token and provider keys owner-only:
// `.env` and Clawboo's settings.json are 0600, and a state dir they create is 0700.
// Drives the real handlers against a sandboxed home. POSIX-only: Windows has no
// group/other bits for chmod to clear.

import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import type { Request, Response } from 'express'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../lib/runtimes/codexAuth', () => ({
  isCodexLoggedIn: () => Promise.resolve(false),
  invalidateCodexAuthCache: () => {},
  userCodexHome: () => '/nonexistent/.codex',
  userCodexAuthPath: () => '/nonexistent/.codex/auth.json',
}))

import { setRuntimeSecret } from '../../lib/secretsVault'
import { autoConfigureOpenclawPOST, configureOpenclawPOST } from '../system'

const modeOf = (p: string): number => statSync(p).mode & 0o777

function res(): Response {
  return {
    status() {
      return this
    },
    json() {
      return this
    },
  } as unknown as Response
}

describe.skipIf(process.platform === 'win32')('OpenClaw setup file modes', () => {
  let home: string
  let clawbooDir: string
  let stateDir: string
  const saved: Record<string, string | undefined> = {}

  beforeEach(() => {
    home = mkdtempSync(path.join(os.tmpdir(), 'clawboo-setup-modes-'))
    clawbooDir = path.join(home, '.clawboo')
    stateDir = path.join(home, '.openclaw')
    for (const k of ['CLAWBOO_HOME', 'HOME', 'OPENCLAW_STATE_DIR', 'OLLAMA_BASE_URL']) {
      saved[k] = process.env[k]
    }
    process.env['CLAWBOO_HOME'] = clawbooDir
    process.env['HOME'] = home
    process.env['OPENCLAW_STATE_DIR'] = stateDir
    delete process.env['OLLAMA_BASE_URL']
  })
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    rmSync(home, { recursive: true, force: true })
  })

  it('configure-openclaw: a fresh install gets a 0700 state dir, a 0600 .env and settings.json', async () => {
    await configureOpenclawPOST(
      { body: { provider: 'anthropic', apiKey: 'sk-ant-test' } } as unknown as Request,
      res(),
    )
    expect(modeOf(stateDir)).toBe(0o700)
    expect(modeOf(path.join(stateDir, '.env'))).toBe(0o600)
    expect(modeOf(path.join(clawbooDir, 'settings.json'))).toBe(0o600)
  })

  it('configure-openclaw: a world-readable .env is narrowed before the new key lands', async () => {
    mkdirSync(stateDir)
    const envPath = path.join(stateDir, '.env')
    writeFileSync(envPath, 'GATEWAY_AUTH_TOKEN=old\n')
    chmodSync(envPath, 0o644)
    await configureOpenclawPOST(
      { body: { provider: 'anthropic', apiKey: 'sk-ant-test' } } as unknown as Request,
      res(),
    )
    expect(modeOf(envPath)).toBe(0o600)
  })

  it('auto-configure-openclaw: the .env and settings.json it writes are 0600', async () => {
    setRuntimeSecret('ANTHROPIC_API_KEY', 'sk-ant-vault')
    mkdirSync(stateDir)
    const envPath = path.join(stateDir, '.env')
    writeFileSync(envPath, 'SOME_OTHER=1\n')
    chmodSync(envPath, 0o644)
    await autoConfigureOpenclawPOST({ body: {} } as unknown as Request, res())
    expect(modeOf(envPath)).toBe(0o600)
    expect(modeOf(path.join(clawbooDir, 'settings.json'))).toBe(0o600)
  })
})
