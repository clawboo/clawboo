// A Hermes agent's home (now its gateway profile): provisioning, seeding from
// the person's own config, the clawboo MCP block, provider detection, the
// ChatGPT sign-in seed, and the provider and model a run asks the gateway for
// (`resolveHermesRunSettings`). No child process is ever spawned.

import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { StartOpts } from '@clawboo/executor'

import { parse as parseYaml } from 'yaml'

import { hermesRunMcpServers, resolveHermesRunSettings } from '../hermes/runSettings'
import {
  CLAWBOO_MCP_BEGIN,
  detectProvider,
  listHermesMcpServerNames,
  mergeClawbooMcpServers,
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
    // The home is materialized on every platform; only the 0700 hardening is
    // POSIX-only. Windows has no mode bits (the chmod is a no-op there and the
    // stat reports 0666), and the source applies no ACL equivalent yet, so
    // asserting 0700 there would assert something untrue rather than untested.
    expect(st.isDirectory()).toBe(true)
    if (process.platform !== 'win32') {
      expect(st.mode & 0o777).toBe(0o700)
    }

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

  /** Parse a config.yaml body strictly (duplicate keys rejected) and return what
   *  Hermes's `_load_mcp_config` reads: the top-level `mcp_servers` mapping. */
  const hermesMcpView = (body: string): Record<string, { url?: string; command?: string }> => {
    const doc = (parseYaml(body, { uniqueKeys: true }) ?? {}) as Record<string, unknown>
    return (doc['mcp_servers'] ?? {}) as Record<string, { url?: string; command?: string }>
  }

  it('attaches the clawboo servers through config.yaml mcp_servers, the only place Hermes reads them', async () => {
    const withMcp = await provisionHermesHome(identityHome(), {
      mcpServers: hermesRunMcpServers('http://localhost:18790'),
    })
    expect(withMcp.mcpAttached).toBe(true)
    const configPath = path.join(withMcp.home, 'config.yaml')
    const servers = hermesMcpView(await readFile(configPath, 'utf8'))
    expect(Object.keys(servers).sort()).toEqual([
      'clawboo-memory',
      'clawboo-tasks',
      'clawboo-teamchat',
      'clawboo-tools',
    ])
    for (const server of Object.values(servers))
      expect(server.url).toContain('http://localhost:18790/api/mcp/')
    expect(existsSync(path.join(withMcp.home, 'mcp.json'))).toBe(false)

    // Port change: the block is rewritten in place, never duplicated.
    await provisionHermesHome(identityHome(), {
      mcpServers: hermesRunMcpServers('http://localhost:19000'),
    })
    const body = await readFile(configPath, 'utf8')
    expect(body.split(CLAWBOO_MCP_BEGIN)).toHaveLength(2)
    expect(hermesMcpView(body)['clawboo-tasks']?.url).toContain('19000')

    // No MCP base URL: the block goes, and a file holding nothing else goes with it.
    await provisionHermesHome(identityHome(), { mcpServers: null })
    expect(existsSync(configPath)).toBe(false)
  })

  it("merges into the seeded user config's own mcp_servers and keeps the user's servers", async () => {
    const userDir = path.join(sandbox, '.hermes')
    await mkdir(userDir, { recursive: true })
    await writeFile(
      path.join(userDir, 'config.yaml'),
      [
        'model:',
        '  provider: anthropic',
        'mcp_servers:   # mine',
        '    github:',
        '        command: npx',
        'agent:',
        '  max_turns: 40',
        '',
      ].join('\n'),
      'utf8',
    )
    const first = await provisionHermesHome(identityHome(), {
      mcpServers: hermesRunMcpServers('http://localhost:18790', { teamId: 'team-A' }),
    })
    expect(first.seededConfig).toBe(true)
    const configPath = path.join(first.home, 'config.yaml')
    const body = await readFile(configPath, 'utf8')
    const servers = hermesMcpView(body)
    expect(servers['github']?.command).toBe('npx')
    expect(servers['clawboo-tasks']?.url).toContain('scopeTeamId=team-A')
    // The rest of the config is untouched, so the provider still resolves.
    expect(await detectProvider(first.home)).toBe('anthropic')
    expect((parseYaml(body) as { agent: { max_turns: number } }).agent.max_turns).toBe(40)

    // A Hermes re-save drops comments: unmarked clawboo entries are still replaced.
    const resaved = [
      'model:',
      '  provider: anthropic',
      'mcp_servers:',
      '  github:',
      '    command: npx',
      '  clawboo-tasks:',
      '    url: http://localhost:1/api/mcp/tasks',
      '',
    ].join('\n')
    await writeFile(configPath, resaved, 'utf8')
    await provisionHermesHome(identityHome(), {
      mcpServers: hermesRunMcpServers('http://localhost:18790'),
    })
    const after = hermesMcpView(await readFile(configPath, 'utf8'))
    expect(after['github']?.command).toBe('npx')
    expect(after['clawboo-tasks']?.url).toContain('localhost:18790')
    expect(Object.keys(after)).toHaveLength(5)
  })

  it('leaves no temp copy of the attach config when the write fails', async () => {
    const home = identityHome()
    // A directory where config.yaml belongs makes the final rename fail.
    await mkdir(path.join(home, 'config.yaml', 'blocker'), { recursive: true })
    await expect(
      provisionHermesHome(home, { mcpServers: hermesRunMcpServers('http://localhost:18790') }),
    ).rejects.toThrow()
    const { readdir } = await import('node:fs/promises')
    expect((await readdir(home)).filter((f) => f.endsWith('.tmp'))).toEqual([])
  })

  it('mergeClawbooMcpServers handles an empty flow mapping and refuses a non-empty one', () => {
    const servers = { 'clawboo-tasks': { url: 'http://h/api/mcp/tasks?a=1&b=2' } }
    const fromEmpty = mergeClawbooMcpServers('mcp_servers: {}\n', servers)
    expect(fromEmpty.attached).toBe(true)
    expect(hermesMcpView(fromEmpty.body)['clawboo-tasks']?.url).toBe(
      'http://h/api/mcp/tasks?a=1&b=2',
    )
    const flow = 'mcp_servers: {github: {command: npx}}\n'
    expect(mergeClawbooMcpServers(flow, servers)).toEqual({ body: flow, attached: false })
    // Removing the block restores the original body.
    const plain = 'model:\n  provider: openrouter\n'
    const added = mergeClawbooMcpServers(plain, servers).body
    expect(mergeClawbooMcpServers(added, null).body).toBe(plain)
    expect(listHermesMcpServerNames(added)).toEqual(['clawboo-tasks'])
  })

  it('binds the run scope onto the shared Memory and Tasks server URLs (per-run scope)', () => {
    const mcpServers = hermesRunMcpServers('http://localhost:18790', {
      teamId: 'team-A',
      agentId: 'agent-1',
    })
    expect(mcpServers['clawboo-memory']?.url).toContain('scopeTeamId=team-A')
    expect(mcpServers['clawboo-memory']?.url).toContain('scopeAgentId=agent-1')
    // Tasks carries the same scope: board READS are forced to the run's team (a
    // bare `list_tasks` must mean "my team's board"), and the agent binding is
    // what enables the mid-run inbox piggyback.
    expect(mcpServers['clawboo-tasks']?.url).toContain('scopeTeamId=team-A')
    expect(mcpServers['clawboo-tasks']?.url).toContain('scopeAgentId=agent-1')
    // Tools carries the run scope too. A connector tool is governed per agent,
    // so an attach with no identity could match no agent-scoped grant and every
    // connector call from a spawned runtime would be denied.
    expect(mcpServers['clawboo-tools']?.url).toContain('scopeTeamId=team-A')
    // TeamChat carries the room + AUTHOR binding (anti-spoof), not the scope params.
    expect(mcpServers['clawboo-teamchat']?.url).toContain('roomTeamId=team-A')
    expect(mcpServers['clawboo-teamchat']?.url).toContain('postAuthorAgentId=agent-1')
    expect(mcpServers['clawboo-teamchat']?.url).not.toContain('scopeTeamId')
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

  // ── what a run asks the gateway for ────────────────────────────────────────

  /** The provider and model a run asks for, as the flags the old one-shot driver
   *  passed (`--provider`, `-m`), so each rule reads the same as before. */
  const plan = async (
    home: ProvisionedHermesHome,
    ctx: Partial<RuntimeRunContext> = {},
    opts: Partial<StartOpts> = {},
  ) => {
    const run = await resolveHermesRunSettings(
      { ...OPTS, ...opts },
      ctx as RuntimeRunContext,
      home.home,
    )
    return {
      run,
      args: [
        ...(run.provider ? ['--provider', run.provider] : []),
        ...(run.model ? ['-m', run.model] : []),
      ],
    }
  }

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

  it('model comes from ctx.model over opts.model; the input is the context, then the message', async () => {
    const home = await provisionHermesHome(identityHome())
    const spawn = await plan(
      home,
      { model: 'anthropic/claude-sonnet-4', apiKeyEnv: { OPENROUTER_API_KEY: 'k' } },
      { model: 'other', context: 'You are on the docs team.' },
    )
    const i = spawn.args.indexOf('-m')
    expect(spawn.args[i + 1]).toBe('anthropic/claude-sonnet-4')
    expect(spawn.run.input).toBe('You are on the docs team.\n\ndo the task')
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

  it('derived rung: NO keys + seeded subscription auth → --provider openai-codex and NO -m', async () => {
    await writeUserAuth()
    const home = await provisionHermesHome(identityHome())
    const spawn = await plan(home, { apiKeyEnv: {} })
    expect(providerArg(spawn.args)).toBe('openai-codex')
    // No model: Hermes asks the backend for the account's own list and runs its
    // first, so no id rides in that the backend could refuse.
    expect(spawn.args).not.toContain('-m')
  })

  it('a PICKED openai-codex with no model (the plan-default pick) pins the provider and passes NO -m', async () => {
    await writeUserAuth()
    const home = await provisionHermesHome(identityHome())
    const spawn = await plan(home, {
      providerHint: 'openai-codex',
      apiKeyEnv: { OPENROUTER_API_KEY: 'sk-or' }, // pick outranks the key rung
    })
    expect(providerArg(spawn.args)).toBe('openai-codex')
    expect(spawn.args).not.toContain('-m')
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
      model: 'gpt-5.6-luna',
      apiKeyEnv: { OPENROUTER_API_KEY: 'sk-or' }, // pick outranks the key rung
    })
    expect(providerArg(spawn.args)).toBe('openai-codex')
    expect(modelArg(spawn.args)).toBe('gpt-5.6-luna')
  })

  it('a PICKED openai-codex with NO auth anywhere degrades like a keyless pick (pin + model dropped)', async () => {
    const home = await provisionHermesHome(identityHome())
    const spawn = await plan(home, {
      providerHint: 'openai-codex',
      model: 'gpt-5.6-luna',
      apiKeyEnv: { OPENROUTER_API_KEY: 'sk-or' },
    })
    // Degraded to the key-derived rung; the codex-specific model went with the pin.
    expect(providerArg(spawn.args)).toBe('openrouter')
    expect(modelArg(spawn.args)).toBe('openai/gpt-4o-mini')
  })
})
