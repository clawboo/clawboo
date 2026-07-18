// The rewritten Hermes driver: stable per-identity home (provision + seeding +
// provider detection), the preserved-runtime argv (`chat -q … -Q`, NO
// --ignore-user-config, NO hard-pinned provider), --resume threading, and the
// tolerant quiet-mode parser. All assertions run against the exported pure
// pieces (buildHermesSpawnPlan / parseHermesLine / provisionHermesHome /
// detectProvider) — no child process is ever spawned.

import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { StartOpts } from '@clawboo/executor'

import {
  HERMES_SESSION_LINE,
  buildHermesSpawnPlan,
  hermesMcpConfig,
  parseHermesLine,
  type HermesRunState,
} from '../hermesDriver'
import {
  detectProvider,
  provisionHermesHome,
  seedHermesAuth,
  type ProvisionedHermesHome,
} from '../hermesHome'
import { hasUsableHermesCodexAuth } from '../hermesAuth'
import { runtimeIdentityHomePath, sanitizeAgentId } from '../identityHome'
import type { RuntimeRunContext } from '../types'

const OPTS: StartOpts = {
  agentId: 'hermes-1',
  sessionKey: 'runtime:hermes:task:t1',
  message: 'do the task',
}

function freshState(): HermesRunState {
  return { lastText: '', sawResult: false }
}

describe('hermes driver (preserved runtime)', () => {
  let sandbox: string
  let prevHome: string | undefined

  beforeEach(async () => {
    sandbox = await mkdtemp(path.join(os.tmpdir(), 'clawboo-hermes-test-'))
    prevHome = process.env['HOME']
    process.env['HOME'] = sandbox
    // userHermesHome() honours HERMES_HOME before ~/.hermes — keep the sandbox authoritative.
    delete process.env['HERMES_HOME']
  })
  afterEach(async () => {
    if (prevHome === undefined) delete process.env['HOME']
    else process.env['HOME'] = prevHome
    await rm(sandbox, { recursive: true, force: true })
  })

  const identityHome = (): string => runtimeIdentityHomePath('hermes', 'hermes-1')

  // ── identity home path ──────────────────────────────────────────────────────

  it('runtimeIdentityHomePath is stable per (runtime, agent) under ~/.clawboo/runtimes', () => {
    const a = runtimeIdentityHomePath('hermes', 'hermes-1')
    const b = runtimeIdentityHomePath('hermes', 'hermes-1')
    const other = runtimeIdentityHomePath('hermes', 'hermes-2')
    expect(a).toBe(b)
    expect(a).not.toBe(other)
    expect(a).toBe(path.join(sandbox, '.clawboo', 'runtimes', 'hermes', 'hermes-1'))
  })

  it('sanitizeAgentId is traversal-proof (dots excluded entirely) with a _default fallback', () => {
    expect(sanitizeAgentId('hermes-1')).toBe('hermes-1')
    expect(sanitizeAgentId('a/../b')).toBe('a____b')
    expect(sanitizeAgentId('..')).toBe('__')
    expect(sanitizeAgentId('générale agent')).toBe('g_n_rale_agent')
    expect(sanitizeAgentId('')).toBe('_default')
    expect(sanitizeAgentId(null)).toBe('_default')
  })

  // ── provisioning + seeding ──────────────────────────────────────────────────

  it('provisions a 0700 home; the same path re-provisions with created=false (stable across runs)', async () => {
    const first = await provisionHermesHome(identityHome())
    expect(first.created).toBe(true)
    const st = await stat(first.home)
    expect(st.mode & 0o777).toBe(0o700)

    const second = await provisionHermesHome(identityHome())
    expect(second.home).toBe(first.home)
    expect(second.created).toBe(false)
  })

  it('seeds config.yaml from ~/.hermes once, never overwrites, never writes back', async () => {
    const userDir = path.join(sandbox, '.hermes')
    await mkdir(userDir, { recursive: true })
    await writeFile(path.join(userDir, 'config.yaml'), 'model:\n  provider: anthropic\n', 'utf8')

    const first = await provisionHermesHome(identityHome())
    expect(first.seededConfig).toBe(true)
    expect(await readFile(path.join(first.home, 'config.yaml'), 'utf8')).toContain('anthropic')

    // The home's copy evolves independently — a re-provision must not clobber it.
    await writeFile(
      path.join(first.home, 'config.yaml'),
      'model:\n  provider: openrouter\n',
      'utf8',
    )
    const second = await provisionHermesHome(identityHome())
    expect(second.seededConfig).toBe(false)
    expect(await readFile(path.join(second.home, 'config.yaml'), 'utf8')).toContain('openrouter')

    // And the user's real config is untouched.
    expect(await readFile(path.join(userDir, 'config.yaml'), 'utf8')).toContain('anthropic')
  })

  it('seeds LATE: a user config appearing after first provision is picked up on the next run', async () => {
    const first = await provisionHermesHome(identityHome())
    expect(first.seededConfig).toBe(false)
    expect(existsSync(path.join(first.home, 'config.yaml'))).toBe(false)

    const userDir = path.join(sandbox, '.hermes')
    await mkdir(userDir, { recursive: true })
    await writeFile(path.join(userDir, 'config.yaml'), 'model:\n  provider: anthropic\n', 'utf8')

    const second = await provisionHermesHome(identityHome())
    expect(second.seededConfig).toBe(true)
  })

  it('mcp.json is clawboo-owned: written/refreshed when a base URL exists, removed when none', async () => {
    const withMcp = await provisionHermesHome(identityHome(), {
      mcpJson: hermesMcpConfig('http://localhost:18790'),
    })
    const mcpPath = path.join(withMcp.home, 'mcp.json')
    const parsed = JSON.parse(await readFile(mcpPath, 'utf8')) as {
      mcpServers: Record<string, { url: string }>
    }
    expect(Object.keys(parsed.mcpServers).sort()).toEqual([
      'clawboo-memory',
      'clawboo-tasks',
      'clawboo-teamchat',
      'clawboo-tools',
    ])
    for (const server of Object.values(parsed.mcpServers))
      expect(server.url).toContain('http://localhost:18790')

    // Port change → refreshed.
    await provisionHermesHome(identityHome(), {
      mcpJson: hermesMcpConfig('http://localhost:19000'),
    })
    expect(await readFile(mcpPath, 'utf8')).toContain('19000')

    // No MCP base URL → removed (no stale attach config).
    await provisionHermesHome(identityHome(), { mcpJson: null })
    expect(existsSync(mcpPath)).toBe(false)
  })

  it('binds the run scope onto the shared Memory server URL only (per-run memory scope)', () => {
    const json = JSON.parse(
      hermesMcpConfig('http://localhost:18790', { teamId: 'team-A', agentId: 'agent-1' }),
    ) as {
      mcpServers: Record<string, { url: string }>
    }
    expect(json.mcpServers['clawboo-memory']?.url).toContain('scopeTeamId=team-A')
    expect(json.mcpServers['clawboo-memory']?.url).toContain('scopeAgentId=agent-1')
    // Tasks/Tools stay bare.
    expect(json.mcpServers['clawboo-tasks']?.url).not.toContain('scopeTeamId')
    expect(json.mcpServers['clawboo-tools']?.url).not.toContain('scopeTeamId')
    // TeamChat carries the room + AUTHOR binding (anti-spoof), not the scope params.
    expect(json.mcpServers['clawboo-teamchat']?.url).toContain('roomTeamId=team-A')
    expect(json.mcpServers['clawboo-teamchat']?.url).toContain('postAuthorAgentId=agent-1')
    expect(json.mcpServers['clawboo-teamchat']?.url).not.toContain('scopeTeamId')
  })

  // ── provider detection ──────────────────────────────────────────────────────

  it('detectProvider reads model.provider (quoted, unquoted, with trailing comment)', async () => {
    const home = (await provisionHermesHome(identityHome())).home
    const cases: Array<[string, string | null]> = [
      ['model:\n  provider: anthropic\n', 'anthropic'],
      ["model:\n  provider: 'openrouter'\n", 'openrouter'],
      ['model:\n  provider: groq  # fast\n', 'groq'],
      // Top-level providers: map must NOT false-positive; no model.provider → null.
      ['providers:\n  my-proxy:\n    provider: openai-compatible\n', null],
      ['agent:\n  provider: nope\n', null],
    ]
    for (const [body, expected] of cases) {
      await writeFile(path.join(home, 'config.yaml'), body, 'utf8')
      expect(await detectProvider(home)).toBe(expected)
    }
  })

  it('detectProvider returns null when config.yaml is absent', async () => {
    const home = (await provisionHermesHome(identityHome())).home
    expect(await detectProvider(home)).toBeNull()
  })

  // ── spawn plan / argv ───────────────────────────────────────────────────────

  const plan = (
    home: ProvisionedHermesHome,
    ctx: Partial<RuntimeRunContext> = {},
    opts: Partial<StartOpts> = {},
  ) => buildHermesSpawnPlan({ ...OPTS, ...opts }, ctx as RuntimeRunContext, home)

  it('argv is a one-shot `chat -q … -Q` with NO --ignore-user-config and NO hard-pinned provider', async () => {
    const home = await provisionHermesHome(identityHome())
    const spawn = await plan(home)
    expect(spawn.args.slice(0, 3)).toEqual(['chat', '-q', 'do the task'])
    expect(spawn.args).toContain('-Q')
    expect(spawn.args).toContain('--yolo')
    expect(spawn.args).toContain('--accept-hooks')
    expect(spawn.args).not.toContain('--ignore-user-config')
    expect(spawn.args).not.toContain('--provider')
    expect(spawn.args).not.toContain('gateway') // one-shot worker, never the Hermes gateway
  })

  it('provider precedence: config wins → key-derived --provider (openrouter > anthropic > openai-api) → nothing', async () => {
    const home = await provisionHermesHome(identityHome())
    const providerArg = (args: string[]): string | undefined => {
      const i = args.indexOf('--provider')
      return i > -1 ? args[i + 1] : undefined
    }

    // 1. No config, no key → no flag (Hermes default `auto`).
    expect((await plan(home)).args).not.toContain('--provider')

    // 2. No config + OPENROUTER_API_KEY → openrouter (the default path).
    expect(
      providerArg((await plan(home, { apiKeyEnv: { OPENROUTER_API_KEY: 'sk-or' } })).args),
    ).toBe('openrouter')

    // 3. A REUSED native Anthropic key → the `anthropic` provider.
    expect(
      providerArg((await plan(home, { apiKeyEnv: { ANTHROPIC_API_KEY: 'sk-ant' } })).args),
    ).toBe('anthropic')

    // 4. A REUSED OpenAI key → `openai-api` (NOT bare `openai`, which is not a
    //    valid hermes provider id).
    expect(providerArg((await plan(home, { apiKeyEnv: { OPENAI_API_KEY: 'sk-oa' } })).args)).toBe(
      'openai-api',
    )

    // 5. OpenRouter wins when multiple keys are present (it is always available).
    expect(
      providerArg(
        (await plan(home, { apiKeyEnv: { ANTHROPIC_API_KEY: 'a', OPENROUTER_API_KEY: 'o' } })).args,
      ),
    ).toBe('openrouter')

    // 6. Configured model.provider wins → no flag even with a key present.
    await writeFile(path.join(home.home, 'config.yaml'), 'model:\n  provider: anthropic\n', 'utf8')
    const configured = await plan(home, { apiKeyEnv: { OPENROUTER_API_KEY: 'sk-or' } })
    expect(configured.args).not.toContain('--provider')
  })

  it('derives a default model with a key-derived provider (so OpenRouter does not 400 "No models provided")', async () => {
    const home = await provisionHermesHome(identityHome())
    const modelArg = (args: string[]): string | undefined => {
      const i = args.indexOf('-m')
      return i > -1 ? args[i + 1] : undefined
    }

    // OpenRouter-derived: a default OpenRouter model id now rides `-m` alongside
    // `--provider openrouter` (the reported bug was NO `-m` → "No models provided").
    const or = await plan(home, { apiKeyEnv: { OPENROUTER_API_KEY: 'sk-or' } })
    expect(or.args).toContain('--provider')
    expect(modelArg(or.args)).toBe('openai/gpt-4o-mini')

    // Reused native keys get their own namespace defaults.
    expect(modelArg((await plan(home, { apiKeyEnv: { ANTHROPIC_API_KEY: 'a' } })).args)).toBe(
      'claude-haiku-4-5',
    )
    expect(modelArg((await plan(home, { apiKeyEnv: { OPENAI_API_KEY: 'o' } })).args)).toBe(
      'gpt-4o-mini',
    )

    // An explicit model still wins over the derived default.
    expect(
      modelArg(
        (
          await plan(home, {
            model: 'anthropic/claude-sonnet-4',
            apiKeyEnv: { OPENROUTER_API_KEY: 'sk-or' },
          })
        ).args,
      ),
    ).toBe('anthropic/claude-sonnet-4')

    // No provider derived (no key, no config) → NO `-m` (Hermes default `auto`).
    expect(modelArg((await plan(home)).args)).toBeUndefined()
  })

  it('a per-agent PICKED provider (ctx.providerHint) pins --provider + uses ctx.model, ahead of key derivation and config', async () => {
    const home = await provisionHermesHome(identityHome())
    const providerArg = (args: string[]): string | undefined => {
      const i = args.indexOf('--provider')
      return i > -1 ? args[i + 1] : undefined
    }
    const modelArg = (args: string[]): string | undefined => {
      const i = args.indexOf('-m')
      return i > -1 ? args[i + 1] : undefined
    }

    // Pick anthropic even though an OpenRouter key is present (would otherwise derive
    // openrouter): the pick pins the provider AND passes the picked model.
    const picked = await plan(home, {
      model: 'claude-haiku-4-5',
      providerHint: 'anthropic',
      apiKeyEnv: { OPENROUTER_API_KEY: 'sk-or', ANTHROPIC_API_KEY: 'a' },
    })
    expect(providerArg(picked.args)).toBe('anthropic')
    expect(modelArg(picked.args)).toBe('claude-haiku-4-5')

    // The pick also wins over a seeded config.yaml provider.
    await writeFile(path.join(home.home, 'config.yaml'), 'model:\n  provider: openrouter\n', 'utf8')
    const overConfig = await plan(home, {
      model: 'gpt-4o-mini',
      providerHint: 'openai-api',
      apiKeyEnv: { OPENAI_API_KEY: 'o' },
    })
    expect(providerArg(overConfig.args)).toBe('openai-api')
    expect(modelArg(overConfig.args)).toBe('gpt-4o-mini')
  })

  it('degrades a PICKED provider whose key is NOT connected to the key-derived default (no hard-fail)', async () => {
    const home = await provisionHermesHome(identityHome())
    const providerArg = (args: string[]): string | undefined => {
      const i = args.indexOf('--provider')
      return i > -1 ? args[i + 1] : undefined
    }
    const modelArg = (args: string[]): string | undefined => {
      const i = args.indexOf('-m')
      return i > -1 ? args[i + 1] : undefined
    }

    // The reported failure: an Anthropic-direct pick on an OpenRouter-only setup. The
    // unusable `--provider anthropic` pin + its model are DROPPED and the run degrades
    // to the key-derived openrouter default — never the un-authable `--provider anthropic`
    // (which fails "No Anthropic credentials found").
    const degraded = await plan(home, {
      model: 'claude-haiku-4-5',
      providerHint: 'anthropic',
      apiKeyEnv: { OPENROUTER_API_KEY: 'sk-or' },
    })
    expect(providerArg(degraded.args)).toBe('openrouter')
    expect(modelArg(degraded.args)).toBe('openai/gpt-4o-mini')
    expect(degraded.args).not.toContain('anthropic')
    expect(degraded.args).not.toContain('claude-haiku-4-5')
  })

  it('injects --resume from ctx.resume only into a PRE-EXISTING home', async () => {
    const fresh = await provisionHermesHome(identityHome())
    expect(fresh.created).toBe(true)
    expect((await plan(fresh, { resume: 'hsess-1' })).args).not.toContain('--resume')

    const existing = await provisionHermesHome(identityHome())
    expect(existing.created).toBe(false)
    const resumed = await plan(existing, { resume: 'hsess-1' })
    const i = resumed.args.indexOf('--resume')
    expect(i).toBeGreaterThan(-1)
    expect(resumed.args[i + 1]).toBe('hsess-1')

    expect((await plan(existing, { resume: null })).args).not.toContain('--resume')
  })

  it('model comes from ctx.model over opts.model; env carries HERMES_HOME + apiKeyEnv', async () => {
    const home = await provisionHermesHome(identityHome())
    const spawn = await plan(
      home,
      { model: 'anthropic/claude-sonnet-4', apiKeyEnv: { OPENROUTER_API_KEY: 'k' } },
      { model: 'other' },
    )
    const i = spawn.args.indexOf('-m')
    expect(spawn.args[i + 1]).toBe('anthropic/claude-sonnet-4')
    expect(spawn.env?.['HERMES_HOME']).toBe(home.home)
    expect(spawn.env?.['OPENROUTER_API_KEY']).toBe('k')
  })

  // ── quiet-mode parser ───────────────────────────────────────────────────────

  it('parseHermesLine captures the plain session-info line in its variants (first wins)', () => {
    const state = freshState()
    expect(parseHermesLine('session_id: abc123', state)).toEqual([
      { type: 'session', sessionId: 'abc123' },
    ])
    expect(parseHermesLine('Session ID: zzz999', state)).toEqual([]) // already captured
    expect(state.sessionId).toBe('abc123')

    const state2 = freshState()
    expect(parseHermesLine('  Session ID: cafe-42  ', state2)).toEqual([
      { type: 'session', sessionId: 'cafe-42' },
    ])
    const state3 = freshState()
    expect(parseHermesLine('session-id: dash-1', state3)).toEqual([
      { type: 'session', sessionId: 'dash-1' },
    ])
  })

  it('parseHermesLine captures a JSON frame carrying session_id', () => {
    const state = freshState()
    const evs = parseHermesLine('{"session_id":"json-7","model":"m1"}', state)
    expect(evs).toEqual([{ type: 'session', sessionId: 'json-7', model: 'm1' }])
    expect(state.sessionId).toBe('json-7')
  })

  it('plain response lines become message events and accumulate into the summary', () => {
    const state = freshState()
    expect(parseHermesLine('The answer is 42.', state)).toEqual([
      { type: 'message', text: 'The answer is 42.\n' },
    ])
    parseHermesLine('Done.', state)
    expect(state.lastText).toBe('The answer is 42.\nDone.\n')
  })

  it('a JSON-shaped response line that is not a frame passes through as text', () => {
    const state = freshState()
    const evs = parseHermesLine('{"result": [1, 2, 3]}', state)
    expect(evs).toEqual([{ type: 'message', text: '{"result": [1, 2, 3]}\n' }])
  })

  it('the session-line regex matches the sanctioned base form exactly', () => {
    expect(HERMES_SESSION_LINE.exec('session_id: 0f3a-9b')?.[1]).toBe('0f3a-9b')
    expect(HERMES_SESSION_LINE.test('the session_id: 0f3a was used')).toBe(false) // anchored — never mid-prose
  })

  // ── ChatGPT subscription (openai-codex) ────────────────────────────────────
  // Hermes's native `openai-codex` OAuth provider. Auth lives in
  // ~/.hermes/auth.json (per-provider tokens), seeded into the managed home
  // (a managed home outside ~/.hermes is its OWN hermes root — no global-auth
  // fallback reaches the user's store from a spawned run).

  const HERMES_CODEX_AUTH = JSON.stringify({
    version: 3,
    providers: {
      'openai-codex': {
        tokens: { access_token: 'at-user', refresh_token: 'rt-user' },
        last_refresh: '2026-07-01T00:00:00Z',
      },
    },
  })
  const userAuthPath = (): string => path.join(sandbox, '.hermes', 'auth.json')
  const writeUserAuth = async (body: string = HERMES_CODEX_AUTH): Promise<void> => {
    await mkdir(path.join(sandbox, '.hermes'), { recursive: true })
    await writeFile(userAuthPath(), body, 'utf8')
  }
  const providerArg = (args: string[]): string | undefined => {
    const i = args.indexOf('--provider')
    return i > -1 ? args[i + 1] : undefined
  }
  const modelArg = (args: string[]): string | undefined => {
    const i = args.indexOf('-m')
    return i > -1 ? args[i + 1] : undefined
  }

  it('hasUsableHermesCodexAuth enforces the store shape hermes itself reads (fail-closed)', async () => {
    const p = (name: string): string => path.join(sandbox, name)
    await writeFile(p('good.json'), HERMES_CODEX_AUTH)
    expect(hasUsableHermesCodexAuth(p('good.json'))).toBe(true)

    // Both tokens are required (hermes's own codex_auth_* validation).
    await writeFile(
      p('no-refresh.json'),
      JSON.stringify({ providers: { 'openai-codex': { tokens: { access_token: 'a' } } } }),
    )
    expect(hasUsableHermesCodexAuth(p('no-refresh.json'))).toBe(false)
    await writeFile(
      p('empty-access.json'),
      JSON.stringify({
        providers: { 'openai-codex': { tokens: { access_token: ' ', refresh_token: 'r' } } },
      }),
    )
    expect(hasUsableHermesCodexAuth(p('empty-access.json'))).toBe(false)
    // A DIFFERENT provider's tokens never count.
    await writeFile(
      p('other-provider.json'),
      JSON.stringify({
        providers: { nous: { tokens: { access_token: 'a', refresh_token: 'r' } } },
      }),
    )
    expect(hasUsableHermesCodexAuth(p('other-provider.json'))).toBe(false)
    await writeFile(p('garbage.json'), 'not json {')
    expect(hasUsableHermesCodexAuth(p('garbage.json'))).toBe(false)
    expect(hasUsableHermesCodexAuth(p('missing.json'))).toBe(false)

    // Shape 2 — the credential POOL: what `hermes auth add openai-codex` (the
    // surfaced command) actually writes; hermes runtime resolution accepts it.
    await writeFile(
      p('pool.json'),
      JSON.stringify({
        credential_pool: {
          'openai-codex': [
            { access_token: 'at-pool', refresh_token: 'rt-pool', auth_type: 'oauth' },
          ],
        },
      }),
    )
    expect(hasUsableHermesCodexAuth(p('pool.json'))).toBe(true)
    // An empty/blank pool entry fails closed; another provider's pool never counts.
    await writeFile(
      p('pool-empty.json'),
      JSON.stringify({ credential_pool: { 'openai-codex': [{ access_token: ' ' }] } }),
    )
    expect(hasUsableHermesCodexAuth(p('pool-empty.json'))).toBe(false)
    await writeFile(
      p('pool-other.json'),
      JSON.stringify({ credential_pool: { nous: [{ access_token: 'a' }] } }),
    )
    expect(hasUsableHermesCodexAuth(p('pool-other.json'))).toBe(false)
  })

  it('seedHermesAuth: seeds into an empty managed home; provision reports seededAuth', async () => {
    // No user login → nothing seeded, no throw.
    const bare = await provisionHermesHome(identityHome())
    expect(bare.seededAuth).toBe(false)
    expect(existsSync(path.join(bare.home, 'auth.json'))).toBe(false)

    await writeUserAuth()
    const seeded = await provisionHermesHome(identityHome())
    expect(seeded.seededAuth).toBe(true)
    expect(hasUsableHermesCodexAuth(path.join(seeded.home, 'auth.json'))).toBe(true)
    // Copy-only: the user's store is untouched.
    expect(await readFile(userAuthPath(), 'utf8')).toBe(HERMES_CODEX_AUTH)
  })

  it('seedHermesAuth KEEPS a fresher usable managed token; REPLACES on user re-login or unusable managed copy', async () => {
    const home = await provisionHermesHome(identityHome())
    const managedAuth = path.join(home.home, 'auth.json')
    const ROTATED = JSON.stringify({
      providers: {
        'openai-codex': { tokens: { access_token: 'rotated', refresh_token: 'rotated-r' } },
      },
    })

    // Fresher usable managed copy is KEPT (hermes rotates tokens in the managed home).
    await writeUserAuth()
    await writeFile(managedAuth, ROTATED)
    const past = new Date(Date.now() - 60_000)
    const { utimes } = await import('node:fs/promises')
    await utimes(userAuthPath(), past, past)
    expect(await seedHermesAuth(home.home)).toBe(false)
    expect((await readFile(managedAuth, 'utf8')).includes('rotated')).toBe(true)

    // User re-login (user file newer) REPLACES the managed copy.
    await utimes(managedAuth, past, past)
    await writeUserAuth() // fresh mtime
    expect(await seedHermesAuth(home.home)).toBe(true)
    expect((await readFile(managedAuth, 'utf8')).includes('at-user')).toBe(true)

    // An UNUSABLE managed copy is replaced even when fresher.
    await writeFile(managedAuth, 'corrupt {')
    await utimes(userAuthPath(), past, past)
    expect(await seedHermesAuth(home.home)).toBe(true)
    expect(hasUsableHermesCodexAuth(managedAuth)).toBe(true)
  })

  it('derived rung: NO keys + seeded subscription auth → --provider openai-codex with its own default model', async () => {
    await writeUserAuth()
    const home = await provisionHermesHome(identityHome())
    const spawn = await plan(home, { apiKeyEnv: {} })
    expect(providerArg(spawn.args)).toBe('openai-codex')
    // Flat-cost subscription → hermes's codex default, not a "mini" tier.
    expect(modelArg(spawn.args)).toBe('gpt-5.5')
  })

  it("every key rung outranks the subscription rung (existing keyed setups keep today's behavior)", async () => {
    await writeUserAuth()
    const home = await provisionHermesHome(identityHome())
    const spawn = await plan(home, { apiKeyEnv: { OPENROUTER_API_KEY: 'sk-or' } })
    expect(providerArg(spawn.args)).toBe('openrouter')
  })

  it('a PICKED openai-codex is usable on auth PRESENCE (not an env key): pins provider + model', async () => {
    await writeUserAuth()
    const home = await provisionHermesHome(identityHome())
    const spawn = await plan(home, {
      providerHint: 'openai-codex',
      model: 'gpt-5.3-codex',
      apiKeyEnv: { OPENROUTER_API_KEY: 'sk-or' }, // pick outranks the key rung
    })
    expect(providerArg(spawn.args)).toBe('openai-codex')
    expect(modelArg(spawn.args)).toBe('gpt-5.3-codex')
  })

  it('a PICKED openai-codex with NO auth anywhere degrades like a keyless pick (pin + model dropped)', async () => {
    const home = await provisionHermesHome(identityHome())
    const spawn = await plan(home, {
      providerHint: 'openai-codex',
      model: 'gpt-5.3-codex',
      apiKeyEnv: { OPENROUTER_API_KEY: 'sk-or' },
    })
    // Degraded to the key-derived rung; the codex-specific model went with the pin.
    expect(providerArg(spawn.args)).toBe('openrouter')
    expect(modelArg(spawn.args)).toBe('openai/gpt-4o-mini')
  })
})
