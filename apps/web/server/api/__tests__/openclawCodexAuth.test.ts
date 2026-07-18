// OpenClaw on the ChatGPT subscription — the keyless `openai-codex` provider
// path. Covers the oauth-profile scanner (shape-tolerant, fail-closed, values
// never surfaced), the keyless configure carve-out, the auto-configure rungs
// (key → oauth profile → codex-CLI-only → nothing), the openclaw-config codexAuth
// probe, and the systemModels slug fix (oauth providers configured + the latent
// 'Hugging Face' display-name/id mismatch).

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import type { Request, Response } from 'express'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The codex-CLI login probe (rung 3) is machine state — mock it. The oauth
// PROFILE detection stays REAL (fixture files in the sandboxed state dir).
const codexAuthState = vi.hoisted(() => ({ loggedIn: false }))
vi.mock('../../lib/runtimes/codexAuth', () => ({
  isCodexLoggedIn: () => Promise.resolve(codexAuthState.loggedIn),
  invalidateCodexAuthCache: () => {},
  userCodexHome: () => '/nonexistent/.codex',
  userCodexAuthPath: () => '/nonexistent/.codex/auth.json',
}))
// The live `openclaw models list` shellout is machine state too — force the
// static-catalog path so the group assertions are deterministic.
vi.mock('../../lib/modelCache', () => ({
  getModelsFromCli: () => Promise.resolve(null),
}))

import { detectOauthProfileProviders } from '../../lib/openclawEnv'
import { setRuntimeSecret } from '../../lib/secretsVault'
import {
  autoConfigureOpenclawPOST,
  configureOpenclawPOST,
  openclawConfigGET,
  systemModelsGET,
} from '../system'

function mockRes(): { res: Response; statusCode: () => number; body: () => unknown } {
  let code = 200
  let payload: unknown
  const res = {
    status(c: number) {
      code = c
      return this
    },
    json(b: unknown) {
      payload = b
      return this
    },
  } as unknown as Response
  return { res, statusCode: () => code, body: () => payload }
}
const req = (body: unknown = {}): Request => ({ params: {}, query: {}, body }) as unknown as Request

/** Write an agent auth-profiles.json into the sandboxed state dir. */
function writeProfiles(stateDir: string, agentId: string, profiles: Record<string, unknown>): void {
  const dir = path.join(stateDir, 'agents', agentId, 'agent')
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, 'auth-profiles.json'), JSON.stringify({ version: 1, profiles }))
}

const OAUTH_PROFILE = {
  'openai-codex:default': {
    type: 'oauth',
    provider: 'openai-codex',
    access: 'at-secret',
    refresh: 'rt-secret',
    expires: 1799999999999,
  },
}

describe('OpenClaw ChatGPT-subscription (openai-codex) path', () => {
  let home: string
  let stateDir: string
  const saved: Record<string, string | undefined> = {}

  beforeEach(() => {
    home = mkdtempSync(path.join(os.tmpdir(), 'clawboo-oc-codex-'))
    stateDir = path.join(home, '.openclaw')
    for (const k of ['CLAWBOO_HOME', 'HOME', 'OPENCLAW_STATE_DIR']) saved[k] = process.env[k]
    process.env['CLAWBOO_HOME'] = path.join(home, '.clawboo')
    process.env['HOME'] = home
    process.env['OPENCLAW_STATE_DIR'] = stateDir
    codexAuthState.loggedIn = false
  })
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    rmSync(home, { recursive: true, force: true })
  })

  // ── the oauth-profile scanner ───────────────────────────────────────────────
  it('detectOauthProfileProviders sees oauth profiles, never api_key ones, and scans ALL agents', () => {
    // Agent 1: an api-key profile only — the key detector's territory, not ours.
    writeProfiles(stateDir, 'main', {
      'anthropic:default': { type: 'api_key', provider: 'anthropic', key: 'sk-x' },
    })
    // Agent 2: the oauth profile (no `key`) — must be found DESPITE agent 1
    // having no oauth entry (no first-hit break).
    writeProfiles(stateDir, 'writer', OAUTH_PROFILE)
    const found = detectOauthProfileProviders(stateDir)
    expect(found.has('openai-codex')).toBe(true)
    expect(found.has('anthropic')).toBe(false)

    // Token material with NO explicit type also counts (shape drift tolerance)…
    writeProfiles(stateDir, 'main', {
      'openai-codex:default': { provider: 'openai-codex', access: 'at' },
    })
    expect(detectOauthProfileProviders(stateDir).has('openai-codex')).toBe(true)
    // …but garbage / missing dirs fail CLOSED.
    writeFileSync(path.join(stateDir, 'agents', 'main', 'agent', 'auth-profiles.json'), 'nope {')
    writeProfiles(stateDir, 'writer', {})
    expect(detectOauthProfileProviders(stateDir).size).toBe(0)
    expect(detectOauthProfileProviders('/nonexistent')).toEqual(new Set())
  })

  // ── configure: the keyless carve-out ────────────────────────────────────────
  it('configure accepts keyless openai-codex: model default set, NO key line in .env', () => {
    const r = mockRes()
    configureOpenclawPOST(req({ provider: 'openai-codex' }), r.res)
    expect(r.statusCode()).toBe(200)
    expect((r.body() as { ok: boolean }).ok).toBe(true)

    const config = JSON.parse(readFileSync(path.join(stateDir, 'openclaw.json'), 'utf8')) as {
      agents: { defaults: { model: { primary: string } } }
    }
    expect(config.agents.defaults.model.primary).toBe('openai-codex/gpt-5.5')

    // .env carries ONLY the gateway token — no CUSTOM_API_KEY, no provider key.
    const env = readFileSync(path.join(stateDir, '.env'), 'utf8')
    expect(env).toMatch(/GATEWAY_AUTH_TOKEN=[a-f0-9]{64}/)
    expect(env).not.toContain('CUSTOM_API_KEY')
    expect(env).not.toContain('OPENAI')
  })

  it('configure still 400s a key-less API-KEY provider (the carve-out is exact)', () => {
    const r = mockRes()
    configureOpenclawPOST(req({ provider: 'anthropic' }), r.res)
    expect(r.statusCode()).toBe(400)
  })

  // ── auto-configure rungs ────────────────────────────────────────────────────
  it('rung 1 (unchanged): a connected vault key configures that provider and writes its key', async () => {
    setRuntimeSecret('ANTHROPIC_API_KEY', 'sk-ant-vault')
    const r = mockRes()
    await autoConfigureOpenclawPOST(req(), r.res)
    const body = r.body() as Record<string, unknown>
    expect(body['ok']).toBe(true)
    expect(body['provider']).toBe('anthropic')
    expect(readFileSync(path.join(stateDir, '.env'), 'utf8')).toContain(
      'ANTHROPIC_API_KEY=sk-ant-vault',
    )
  })

  it('rung 2: an existing openai-codex oauth profile configures keylessly', async () => {
    writeProfiles(stateDir, 'main', OAUTH_PROFILE)
    const r = mockRes()
    await autoConfigureOpenclawPOST(req(), r.res)
    const body = r.body() as Record<string, unknown>
    expect(body['ok']).toBe(true)
    expect(body['provider']).toBe('openai-codex')

    const config = JSON.parse(readFileSync(path.join(stateDir, 'openclaw.json'), 'utf8')) as {
      agents: { defaults: { model: { primary: string } } }
    }
    expect(config.agents.defaults.model.primary).toBe('openai-codex/gpt-5.5')
    // No provider-key write happened (no key exists) — .env holds only the token.
    const env = readFileSync(path.join(stateDir, '.env'), 'utf8')
    expect(env).toMatch(/GATEWAY_AUTH_TOKEN=/)
    expect(env).not.toContain('API_KEY=')
    // No token VALUE leaked into the response.
    expect(JSON.stringify(body)).not.toContain('at-secret')
  })

  it('rung 3: codex-CLI login only → needsCodexAuth + the NON-destructive login command', async () => {
    codexAuthState.loggedIn = true
    const r = mockRes()
    await autoConfigureOpenclawPOST(req(), r.res)
    expect(r.body()).toEqual({
      ok: false,
      needsCodexAuth: true,
      loginCommand: 'openclaw models auth login --provider openai-codex',
    })
  })

  it('rung 4: nothing connected → needsKey (unchanged)', async () => {
    const r = mockRes()
    await autoConfigureOpenclawPOST(req(), r.res)
    expect(r.body()).toEqual({ ok: false, needsKey: true })
  })

  // ── the config GET probe ────────────────────────────────────────────────────
  it('openclaw-config GET reports the codexAuth signals (presence only, no values)', async () => {
    writeProfiles(stateDir, 'main', OAUTH_PROFILE)
    codexAuthState.loggedIn = true
    const r = mockRes()
    await openclawConfigGET(req(), r.res)
    const body = r.body() as { codexAuth: Record<string, unknown> }
    expect(body.codexAuth).toEqual({
      profile: true,
      codexCli: true,
      bootstrapTrusted: false,
      loginCommand: 'openclaw models auth login --provider openai-codex',
    })
    expect(JSON.stringify(body)).not.toContain('at-secret')
    expect(JSON.stringify(body)).not.toContain('rt-secret')
  })

  // ── systemModels: oauth providers + the slug fix ────────────────────────────
  it('systemModels: the OpenAI Codex group is offered (greyed until the oauth profile configures it)', async () => {
    // Before auth: the group IS listed (like any keyed provider without a key —
    // the selector greys it) but reads unconfigured.
    const before = mockRes()
    await systemModelsGET(req(), before.res)
    const b = before.body() as { groups: { provider: string }[]; configuredProviders: string[] }
    expect(b.groups.some((g) => g.provider === 'OpenAI Codex')).toBe(true)
    expect(b.configuredProviders).not.toContain('openai-codex')

    writeProfiles(stateDir, 'main', OAUTH_PROFILE)
    const after = mockRes()
    await systemModelsGET(req(), after.res)
    const a = after.body() as { groups: { provider: string }[]; configuredProviders: string[] }
    // The oauth profile flips it configured — the id the selector's slugged
    // grey-out check matches against the 'OpenAI Codex' display name.
    expect(a.configuredProviders).toContain('openai-codex')
    expect(a.groups.some((g) => g.provider === 'OpenAI Codex')).toBe(true)
  })

  it('systemModels slug fix: a huggingface key admits the "Hugging Face" display group (latent bug)', async () => {
    mkdirSync(stateDir, { recursive: true })
    writeFileSync(path.join(stateDir, '.env'), 'HF_TOKEN=hf-secret\n')
    const r = mockRes()
    await systemModelsGET(req(), r.res)
    const body = r.body() as { groups: { provider: string }[]; configuredProviders: string[] }
    expect(body.configuredProviders).toContain('huggingface')
    expect(body.groups.some((g) => g.provider === 'Hugging Face')).toBe(true)
  })
})
