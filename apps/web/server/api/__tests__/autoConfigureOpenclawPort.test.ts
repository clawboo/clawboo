// POST /api/system/auto-configure-openclaw keeps a gateway.port the user already
// set, so the Gateway URL it returns and saves into Clawboo's settings must name
// that port too. It follows the Gateway route's own port rule (a managed
// Gateway's PID file, then openclaw.json, then 18789), so setup, start and
// connect all agree.

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
import { autoConfigureOpenclawPOST } from '../system'

describe('POST /api/system/auto-configure-openclaw: the Gateway port', () => {
  let home: string
  let clawbooDir: string
  let stateDir: string
  const saved: Record<string, string | undefined> = {}

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
    await autoConfigureOpenclawPOST({ body: {} } as unknown as Request, res)
    return payload as Record<string, unknown>
  }

  const savedGatewayUrl = (): unknown =>
    (
      JSON.parse(readFileSync(path.join(clawbooDir, 'settings.json'), 'utf8')) as {
        gateway: { url: unknown }
      }
    ).gateway.url
  const configPort = (): unknown =>
    (
      JSON.parse(readFileSync(path.join(stateDir, 'openclaw.json'), 'utf8')) as {
        gateway: { port: unknown }
      }
    ).gateway.port

  function writeConfig(config: unknown): void {
    mkdirSync(stateDir, { recursive: true })
    writeFileSync(path.join(stateDir, 'openclaw.json'), JSON.stringify(config))
  }

  beforeEach(() => {
    home = mkdtempSync(path.join(os.tmpdir(), 'clawboo-auto-port-'))
    clawbooDir = path.join(home, '.clawboo')
    stateDir = path.join(home, '.openclaw')
    for (const k of ['CLAWBOO_HOME', 'HOME', 'OPENCLAW_STATE_DIR', 'OLLAMA_BASE_URL']) {
      saved[k] = process.env[k]
    }
    process.env['CLAWBOO_HOME'] = clawbooDir
    process.env['HOME'] = home
    process.env['OPENCLAW_STATE_DIR'] = stateDir
    delete process.env['OLLAMA_BASE_URL']
    setRuntimeSecret('ANTHROPIC_API_KEY', 'sk-ant-vault')
  })
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    rmSync(home, { recursive: true, force: true })
  })

  it('a fresh install gets the default port in the config, the response and the settings', async () => {
    const body = await autoConfigure()
    expect(body['gatewayUrl']).toBe('ws://localhost:18789')
    expect(configPort()).toBe(18789)
    expect(savedGatewayUrl()).toBe('ws://localhost:18789')
  })

  it('a gateway.port the user set is kept and is the one returned and saved', async () => {
    writeConfig({ gateway: { mode: 'local', port: 19123 } })
    const body = await autoConfigure()
    expect(configPort()).toBe(19123)
    expect(body['gatewayUrl']).toBe('ws://localhost:19123')
    expect(savedGatewayUrl()).toBe('ws://localhost:19123')
  })

  it("a managed Gateway's PID-file port wins, as it does for the Gateway route", async () => {
    writeConfig({ gateway: { mode: 'local', port: 19123 } })
    mkdirSync(clawbooDir, { recursive: true })
    writeFileSync(
      path.join(clawbooDir, 'gateway.pid'),
      JSON.stringify({ pid: 4242, port: 19555, startedAt: 1_700_000_000_000 }),
    )
    const body = await autoConfigure()
    expect(body['gatewayUrl']).toBe('ws://localhost:19555')
    expect(savedGatewayUrl()).toBe('ws://localhost:19555')
  })

  it('a kept port the Gateway route would not use falls back to the default URL', async () => {
    writeConfig({ gateway: { mode: 'local', port: 0 } })
    const body = await autoConfigure()
    expect(configPort()).toBe(0)
    expect(body['gatewayUrl']).toBe('ws://localhost:18789')
  })
})
