// Setting OpenClaw up reuses a provider key the person SAVED. A key the server's
// environment supplies now shows as connected on the Providers screen, but it is
// never copied into OpenClaw's .env: that would write the secret to disk unasked.

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
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

import { ENV_KEY_MAP } from '../../lib/openclawEnv'
import { providerStatus } from '../../lib/providerKeys'
import { setRuntimeSecret } from '../../lib/secretsVault'
import { autoConfigureOpenclawPOST } from '../system'

describe('POST /api/system/auto-configure-openclaw with a key from the environment', () => {
  let home: string
  let stateDir: string
  const saved: Record<string, string | undefined> = {}
  const PROVIDER_VARS = [...new Set(Object.values(ENV_KEY_MAP))]

  async function autoConfigure(): Promise<Record<string, unknown>> {
    let payload: unknown
    const res = {
      status() {
        return this
      },
      json(b: unknown) {
        payload = b
        return this
      },
    } as unknown as Response
    const headers = { 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors' }
    await autoConfigureOpenclawPOST({ headers, body: {} } as unknown as Request, res)
    return payload as Record<string, unknown>
  }

  const openclawEnv = (): string => {
    const file = path.join(stateDir, '.env')
    return existsSync(file) ? readFileSync(file, 'utf8') : ''
  }

  beforeEach(() => {
    home = mkdtempSync(path.join(os.tmpdir(), 'clawboo-auto-envkey-'))
    stateDir = path.join(home, '.openclaw')
    for (const k of [
      'CLAWBOO_HOME',
      'HOME',
      'OPENCLAW_STATE_DIR',
      'OLLAMA_BASE_URL',
      ...PROVIDER_VARS,
    ]) {
      saved[k] = process.env[k]
    }
    process.env['CLAWBOO_HOME'] = path.join(home, '.clawboo')
    process.env['HOME'] = home
    process.env['OPENCLAW_STATE_DIR'] = stateDir
    delete process.env['OLLAMA_BASE_URL']
    for (const k of PROVIDER_VARS) delete process.env[k]
  })
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    rmSync(home, { recursive: true, force: true })
  })

  it('asks for a key rather than copy one only the environment holds', async () => {
    process.env['GROQ_API_KEY'] = 'gsk-from-the-environment'
    expect(providerStatus().find((p) => p.id === 'groq')?.connected).toBe(true)
    expect(await autoConfigure()).toEqual({ ok: false, needsKey: true })
    expect(openclawEnv()).not.toContain('gsk-from-the-environment')
  })

  it('still reuses a saved key', async () => {
    process.env['GROQ_API_KEY'] = 'gsk-from-the-environment'
    setRuntimeSecret('ANTHROPIC_API_KEY', 'sk-ant-saved')
    const body = await autoConfigure()
    expect(body['ok']).toBe(true)
    expect(openclawEnv()).toContain('ANTHROPIC_API_KEY=sk-ant-saved')
    expect(openclawEnv()).not.toContain('gsk-from-the-environment')
  })
})
