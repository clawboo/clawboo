// OpenClaw's tools run on the computer Clawboo and its other agents use, not in
// a Docker container of OpenClaw's own. Configure writes OpenClaw's sandbox
// mode out as `off` (its default today, written so it holds whatever a later
// OpenClaw defaults to); auto-configure adds it when the config has none and
// leaves a sandbox the user set up as it is. Both run against a temp state dir.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
import { autoConfigureOpenclawPOST, configureOpenclawPOST, OPENCLAW_SANDBOX_MODE } from '../system'

const HEADERS = { 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors' }

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

describe("OpenClaw's tool sandbox", () => {
  let home: string
  let stateDir: string
  const saved: Record<string, string | undefined> = {}

  const config = (): { agents: { defaults: Record<string, unknown> } } =>
    JSON.parse(readFileSync(path.join(stateDir, 'openclaw.json'), 'utf8')) as {
      agents: { defaults: Record<string, unknown> }
    }

  beforeEach(() => {
    home = mkdtempSync(path.join(os.tmpdir(), 'clawboo-oc-sandbox-'))
    stateDir = path.join(home, '.openclaw')
    for (const k of ['CLAWBOO_HOME', 'HOME', 'OPENCLAW_STATE_DIR', 'OLLAMA_BASE_URL']) {
      saved[k] = process.env[k]
    }
    process.env['CLAWBOO_HOME'] = path.join(home, '.clawboo')
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

  it('is off: OpenClaw runs its tools on this computer', () => {
    expect(OPENCLAW_SANDBOX_MODE).toBe('off')
  })

  it('configure writes it out', async () => {
    await configureOpenclawPOST(
      {
        headers: HEADERS,
        body: { provider: 'anthropic', apiKey: 'sk-ant-x' },
      } as unknown as Request,
      res(),
    )
    expect(config().agents.defaults['sandbox']).toEqual({ mode: 'off' })
    expect(config().agents.defaults['model']).toEqual({ primary: 'anthropic/claude-sonnet-4-5' })
  })

  it('auto-configure adds it to a config that has none', async () => {
    setRuntimeSecret('ANTHROPIC_API_KEY', 'sk-ant-vault')
    await autoConfigureOpenclawPOST({ headers: HEADERS, body: {} } as unknown as Request, res())
    expect(config().agents.defaults['sandbox']).toEqual({ mode: 'off' })
  })

  it('auto-configure keeps a sandbox the user set up', async () => {
    setRuntimeSecret('ANTHROPIC_API_KEY', 'sk-ant-vault')
    mkdirSync(stateDir, { recursive: true })
    const mine = { mode: 'all', backend: 'docker', scope: 'agent' }
    writeFileSync(
      path.join(stateDir, 'openclaw.json'),
      JSON.stringify({ agents: { defaults: { sandbox: mine } } }),
    )
    await autoConfigureOpenclawPOST({ headers: HEADERS, body: {} } as unknown as Request, res())
    expect(config().agents.defaults['sandbox']).toEqual(mine)
  })
})
