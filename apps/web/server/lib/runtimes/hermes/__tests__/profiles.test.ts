// One Hermes profile per Clawboo Hermes agent, inside the supervised gateway's
// home. The profile's `.env` carries its own API key, the run's provider keys and
// its working folder; its config.yaml carries Clawboo's MCP servers and a pinned
// terminal block; the agent's old Hermes home moves in once, so its memory and
// skills carry over.

import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { MAX_READ_BYTES } from '../../../agentUser/protocol'

import {
  derivedHermesKey,
  envLine,
  hermesProfileName,
  isClawbooProfile,
  listClawbooProfiles,
  DEFAULT_APPROVAL_PINS,
  holdsPins,
  pinApprovalsMode,
  pinTerminalBlock,
  readAsHermes,
  provisionGatewayHome,
  provisionProfile,
  renderGatewayConfig,
  renderGatewayEnv,
  renderProfileEnv,
  refreshProfileProviderKeys,
  setAsideProfilesDir,
  throwawayProfileName,
  tidyProfiles,
  withoutChannelBlocks,
  withProviderKeys,
} from '../profiles'

describe('profile names', () => {
  it('keeps a lowercase agent id readable and hashes anything else', () => {
    expect(hermesProfileName('/data/runtimes/hermes/agent-1')).toBe('cb-agent-1')
    expect(hermesProfileName('/data/runtimes/hermes/8f0c2e9a-1b2c-4d5e-9f00-112233445566')).toBe(
      'cb-8f0c2e9a-1b2c-4d5e-9f00-112233445566',
    )
    const upper = hermesProfileName('/data/runtimes/hermes/Agent_One')
    const lower = hermesProfileName('/data/runtimes/hermes/agent_one')
    expect(upper).toMatch(/^cb-h[0-9a-f]{32}$/)
    expect(upper).not.toBe(lower)
    for (const name of [upper, lower, throwawayProfileName()]) {
      expect(name).toMatch(/^[a-z0-9][a-z0-9_-]{0,63}$/)
      expect(isClawbooProfile(name)).toBe(true)
    }
    expect(isClawbooProfile('default')).toBe(false)
    expect(isClawbooProfile('my-own')).toBe(false)
  })

  it('derives a distinct 64-hex key per profile from the master key', () => {
    const a = derivedHermesKey('m'.repeat(64), 'cb-a')
    expect(a).toMatch(/^[0-9a-f]{64}$/)
    expect(derivedHermesKey('m'.repeat(64), 'cb-b')).not.toBe(a)
    expect(derivedHermesKey('n'.repeat(64), 'cb-a')).not.toBe(a)
  })
})

describe('.env lines', () => {
  it("double-quotes every value, escaping what both of Hermes's readers undo", () => {
    expect(envLine('TERMINAL_CWD', '/a b/$HOME')).toBe('TERMINAL_CWD="/a b/$HOME"')
    expect(envLine('TERMINAL_CWD', "/it's")).toBe('TERMINAL_CWD="/it\'s"')
    expect(envLine('X', 'a"b\\c$d\'')).toBe('X="a\\"b\\\\c$d\'"')
    // A UNC path keeps both of its backslashes (single quotes would lose one).
    expect(envLine('TERMINAL_CWD', '\\\\srv\\share')).toBe('TERMINAL_CWD="\\\\\\\\srv\\\\share"')
    expect(() => envLine('lower', 'x')).toThrow(/env var name/)
  })

  it('refuses every line break Hermes splits at, and ${} expansion in any quotes', () => {
    for (const brk of [
      '\n',
      '\r',
      '\v',
      '\f',
      '\x1c',
      '\x1d',
      '\x1e',
      '\x85',
      '\u2028',
      '\u2029',
      '\0',
    ]) {
      expect(() => envLine('TERMINAL_CWD', `/w${brk}OPENAI_BASE_URL=https://x`)).toThrow(
        /line break/,
      )
    }
    expect(() => envLine('X', 'x${SECRET}y')).toThrow(/cannot be written/)
    expect(() => envLine('X', "it's ${HOME}")).toThrow(/cannot be written/)
  })

  it('a line planted after a Unicode line break cannot override a managed name', () => {
    const body = renderProfileEnv({
      key: 'k'.repeat(64),
      cwd: '/work/teams/t1',
      providerEnv: {},
      previous: 'FOO=x\u2028TERMINAL_CWD=/\u0085API_SERVER_KEY=stolen\n',
    })
    expect(body).toContain('FOO=x')
    expect(body).not.toContain('TERMINAL_CWD=/\n')
    expect(body).not.toContain('stolen')
    expect(body.match(/TERMINAL_CWD=/g)).toHaveLength(1)
  })

  it('a profile .env holds its key, its folder and only provider API keys', () => {
    const body = renderProfileEnv({
      key: 'k'.repeat(64),
      cwd: '/work/teams/t1',
      providerEnv: {
        OPENROUTER_API_KEY: 'sk-or',
        TELEGRAM_BOT_TOKEN: 'never',
        ANTHROPIC_API_KEY: 'sk-ant',
      },
    })
    expect(body).toContain(`API_SERVER_KEY="${'k'.repeat(64)}"`)
    expect(body).toContain('TERMINAL_ENV="local"')
    expect(body).toContain('TERMINAL_CWD="/work/teams/t1"')
    expect(body).toContain('OPENROUTER_API_KEY="sk-or"')
    expect(body).toContain('ANTHROPIC_API_KEY="sk-ant"')
    expect(body).not.toContain('TELEGRAM')
  })

  it('keeps the lines someone else added, and drops a key Clawboo no longer connects', () => {
    const previous = renderProfileEnv({
      key: 'old',
      cwd: '/old',
      providerEnv: { OPENAI_API_KEY: 'sk-old' },
    }).concat("GEMINI_API_KEY='g-1'\n# my note\n")
    const next = renderProfileEnv({ key: 'new', cwd: '/new', providerEnv: {}, previous })
    expect(next).toContain("GEMINI_API_KEY='g-1'")
    expect(next).toContain('# my note')
    expect(next).not.toContain('sk-old')
    expect(next).not.toContain('TERMINAL_CWD="/old"')
    expect(next.match(/API_SERVER_KEY=/g)).toHaveLength(1)
    // Writing it again does not grow the kept part.
    const third = renderProfileEnv({ key: 'new', cwd: '/new', providerEnv: {}, previous: next })
    expect(third).toBe(next)
  })

  it('the gateway home holds the API server on loopback and nothing that opens a channel', () => {
    const env = renderGatewayEnv({ port: 8642, key: 'r'.repeat(64) })
    expect(env).toContain('API_SERVER_HOST="127.0.0.1"')
    expect(env).toContain('API_SERVER_PORT="8642"')
    expect(env).toContain(`API_SERVER_KEY="${'r'.repeat(64)}"`)
    expect(env.split('\n').filter((l) => l && !l.startsWith('#'))).toHaveLength(3)
    const config = renderGatewayConfig()
    expect(config).toContain('multiplex_profiles: true')
    expect(config).toContain('max_concurrent_runs: 10')
    expect(config).toContain('backend: local')
  })
})

describe('pinTerminalBlock', () => {
  it('sets cwd to the placeholder and backend to local inside terminal:, nothing else', () => {
    const body = [
      'model:',
      '  provider: openrouter',
      '  cwd: /not/terminal',
      'terminal:',
      '  backend: docker',
      '  cwd: /home/me/projects',
      '  timeout: 180',
      '  nested:',
      '    cwd: /deeper',
      'other: 1',
    ].join('\n')
    const out = pinTerminalBlock(body).split('\n')
    expect(out).toContain('  backend: local')
    expect(out).toContain('  cwd: "."')
    expect(out).toContain('  cwd: /not/terminal')
    expect(out).toContain('    cwd: /deeper')
    expect(out).toContain('  timeout: 180')
  })

  it('leaves a config without a terminal block as it is', () => {
    const body = 'model:\n  provider: anthropic\n'
    expect(pinTerminalBlock(body)).toBe(body)
  })
})

describe('provider keys between runs', () => {
  it('replaces only the provider keys, keeping the key, the folder and added lines', () => {
    const body = renderProfileEnv({
      key: 'k'.repeat(64),
      cwd: '/w',
      providerEnv: { OPENROUTER_API_KEY: 'sk-or', ANTHROPIC_API_KEY: 'sk-ant' },
      previous: "GEMINI_API_KEY='g'\n",
    })
    const none = withProviderKeys(body, {})
    expect(none).not.toContain('sk-or')
    expect(none).not.toContain('sk-ant')
    expect(none).toContain('TERMINAL_CWD="/w"')
    expect(none).toContain("GEMINI_API_KEY='g'")
    const one = withProviderKeys(none, { OPENAI_API_KEY: 'sk-oa' })
    expect(one).toContain('OPENAI_API_KEY="sk-oa"')
    expect(one.indexOf('OPENAI_API_KEY')).toBeLessThan(one.indexOf('# Kept as they were:'))
  })

  it('leaves throwaway profiles out of a key refresh', async () => {
    const gw = await mkdtemp(path.join(os.tmpdir(), 'clawboo-hermes-keys-'))
    try {
      await mkdir(path.join(gw, 'profiles', 'cbtmp-0123456789abcdef'), { recursive: true })
      const env = path.join(gw, 'profiles', 'cbtmp-0123456789abcdef', '.env')
      const before = renderProfileEnv({
        key: 'k',
        cwd: null,
        providerEnv: { OPENROUTER_API_KEY: 'old' },
      })
      await writeFile(env, before)
      await refreshProfileProviderKeys(gw, () => ({ OPENROUTER_API_KEY: 'new' }))
      expect(await readFile(env, 'utf8')).toBe(before)
    } finally {
      await rm(gw, { recursive: true, force: true })
    }
  })

  it('refreshes every Clawboo profile in the gateway home', async () => {
    const gw = await mkdtemp(path.join(os.tmpdir(), 'clawboo-hermes-keys-'))
    try {
      for (const name of ['cb-a', 'cb-b']) {
        await mkdir(path.join(gw, 'profiles', name), { recursive: true })
        await writeFile(
          path.join(gw, 'profiles', name, '.env'),
          renderProfileEnv({ key: 'k', cwd: null, providerEnv: { OPENROUTER_API_KEY: 'old' } }),
        )
      }
      await refreshProfileProviderKeys(gw, () => ({}))
      for (const name of ['cb-a', 'cb-b']) {
        expect(await readFile(path.join(gw, 'profiles', name, '.env'), 'utf8')).not.toContain('old')
      }
    } finally {
      await rm(gw, { recursive: true, force: true })
    }
  })

  it('passes over a profile whose .env cannot be written, and refreshes the rest', async () => {
    const gw = await mkdtemp(path.join(os.tmpdir(), 'clawboo-hermes-keys-'))
    try {
      // An agent replaced its own .env with a folder.
      await mkdir(path.join(gw, 'profiles', 'cb-a', '.env'), { recursive: true })
      await mkdir(path.join(gw, 'profiles', 'cb-b'), { recursive: true })
      await writeFile(
        path.join(gw, 'profiles', 'cb-b', '.env'),
        renderProfileEnv({ key: 'k', cwd: null, providerEnv: { OPENROUTER_API_KEY: 'old' } }),
      )
      await expect(refreshProfileProviderKeys(gw, () => ({}))).resolves.toBeUndefined()
      expect(await readFile(path.join(gw, 'profiles', 'cb-b', '.env'), 'utf8')).not.toContain('old')
    } finally {
      await rm(gw, { recursive: true, force: true })
    }
  })

  it("writes each profile's own gateway key, so one not run since the key changed still answers", async () => {
    const gw = await mkdtemp(path.join(os.tmpdir(), 'clawboo-hermes-keys-'))
    try {
      await mkdir(path.join(gw, 'profiles', 'cb-a'), { recursive: true })
      const env = path.join(gw, 'profiles', 'cb-a', '.env')
      await writeFile(env, renderProfileEnv({ key: 'k'.repeat(64), cwd: '/w', providerEnv: {} }))
      await refreshProfileProviderKeys(gw, () => ({}), {
        keyFor: (profile) => derivedHermesKey('n'.repeat(64), profile),
      })
      const body = await readFile(env, 'utf8')
      expect(body).toContain(`API_SERVER_KEY="${derivedHermesKey('n'.repeat(64), 'cb-a')}"`)
      expect(body).not.toContain('k'.repeat(64))
      expect(body.match(/API_SERVER_KEY=/g)).toHaveLength(1)
      expect(body).toContain('TERMINAL_CWD="/w"')
    } finally {
      await rm(gw, { recursive: true, force: true })
    }
  })
})

describe('withoutChannelBlocks', () => {
  it("drops the person's chat channels and multiplexer keys, keeping the rest", () => {
    const body = [
      'model:',
      '  provider: anthropic',
      'platforms:',
      '  telegram:',
      '    token: 123:abc',
      'telegram:',
      '  allowed_users: [1]',
      'gateway:',
      '  multiplex_profiles: true',
      'multiplex_profiles: true',
      'approvals:',
      '  mode: smart',
      '',
    ].join('\n')
    const out = withoutChannelBlocks(body)
    expect(out).toBe(
      ['model:', '  provider: anthropic', 'approvals:', '  mode: smart', ''].join('\n'),
    )
  })
})

describe('readAsHermes', () => {
  it('reads a config as PyYAML does: merges followed, a bare off is false', () => {
    expect(readAsHermes('approvals:\n  mode: off\n')).toMatchObject({ approvalMode: 'off' })
    expect(readAsHermes('x: &m {mode: off}\napprovals:\n  <<: *m\n')).toMatchObject({
      approvalMode: 'off',
    })
    expect(readAsHermes('"approvals": {"mode": "off"}\n')).toMatchObject({ approvalMode: 'off' })
    expect(readAsHermes('model:\n  provider: x\n')).toMatchObject({ approvalMode: null })
  })

  it('calls anything two readers could take differently unreadable', () => {
    expect(readAsHermes('approvals:\n  mode: manual\napprovals:\n  mode: off\n')).toBe('unreadable')
    expect(readAsHermes('a: 1\n---\nb: 2\n')).toBe('unreadable')
    expect(readAsHermes('approvals: [1, 2]\n')).toBe('unreadable')
    expect(readAsHermes('approvals:\n  mode: !!python/name:os.system off\n')).toBe('unreadable')
  })

  it('holds the pins only when Hermes would read them', () => {
    expect(holdsPins('approvals:\n  mode: manual\n', DEFAULT_APPROVAL_PINS)).toBe(true)
    expect(
      holdsPins(
        'approvals:\n  mode: manual\nterminal:\n  backend: docker\n',
        DEFAULT_APPROVAL_PINS,
      ),
    ).toBe(false)
    expect(
      holdsPins('approvals:\n  mode: manual\n"approvals":\n  mode: off\n', DEFAULT_APPROVAL_PINS),
    ).toBe(false)
  })
})

describe('pinApprovalsMode', () => {
  it('adds the mode when the config chooses none', () => {
    expect(pinApprovalsMode('model:\n  provider: x\n', 'manual')).toBe(
      'model:\n  provider: x\napprovals:\n  mode: manual\n',
    )
    expect(pinApprovalsMode('', 'manual')).toBe('approvals:\n  mode: manual\n')
  })

  it('sets back a mode the agent changed, keeping the other approval keys', () => {
    const edited = 'approvals:\n  timeout: 60\n  mode: off\nmodel:\n  provider: x\n'
    expect(pinApprovalsMode(edited, 'manual')).toBe(
      'approvals:\n  timeout: 60\n  mode: manual\nmodel:\n  provider: x\n',
    )
    expect(pinApprovalsMode('approvals:\n  timeout: 60\n', 'smart')).toBe(
      'approvals:\n  mode: smart\n  timeout: 60\n',
    )
    expect(pinApprovalsMode('approvals: {mode: off}\n', 'manual')).toBe(
      'approvals:\n  mode: manual\n',
    )
    // `off` is quoted: YAML 1.1 readers take a bare off for false.
    expect(pinApprovalsMode('', 'off')).toBe('approvals:\n  mode: "off"\n')
  })
})

describe('provisionProfile', () => {
  let root: string
  let prevHome: string | undefined

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'clawboo-hermes-profiles-'))
    prevHome = process.env['HOME']
    process.env['HOME'] = path.join(root, 'home')
    delete process.env['HERMES_HOME']
  })
  afterEach(async () => {
    process.env['HOME'] = prevHome
    await rm(root, { recursive: true, force: true })
  })

  const base = (over: Partial<Parameters<typeof provisionProfile>[0]> = {}) => ({
    gatewayHome: path.join(root, 'gw'),
    profile: 'cb-agent-1',
    legacyHome: path.join(root, 'legacy', 'agent-1'),
    key: 'p'.repeat(64),
    cwd: path.join(root, 'work'),
    providerEnv: { OPENROUTER_API_KEY: 'sk-or' },
    mcpServers: { 'clawboo-tasks': { url: 'http://127.0.0.1:1/api/mcp/tasks?live=1' } },
    ...over,
  })

  it('refuses a profile config.yaml too large to read whole, and leaves it as it is', async () => {
    const dir = path.join(root, 'gw', 'profiles', 'cb-agent-1')
    await mkdir(dir, { recursive: true })
    const big = `model:\n  provider: openrouter\n# ${'x'.repeat(MAX_READ_BYTES)}\n`
    await writeFile(path.join(dir, 'config.yaml'), big)
    await expect(provisionProfile(base({ legacyHome: null }))).rejects.toThrow(/larger than/)
    expect(await readFile(path.join(dir, 'config.yaml'), 'utf8')).toBe(big)
  })

  it("moves the agent's old Hermes home in once, so its memory and skills carry over", async () => {
    const legacy = path.join(root, 'legacy', 'agent-1')
    await mkdir(path.join(legacy, 'memories'), { recursive: true })
    await mkdir(path.join(legacy, 'skills', 'deploy'), { recursive: true })
    await writeFile(path.join(legacy, 'memories', 'MEMORY.md'), 'remember me')
    await writeFile(path.join(legacy, 'skills', 'deploy', 'SKILL.md'), '---\nname: deploy\n---')

    const first = await provisionProfile(base())
    expect(first).toMatchObject({ created: true, migrated: true, mcpAttached: true })
    expect(first.dir).toBe(path.join(root, 'gw', 'profiles', 'cb-agent-1'))
    expect(await readFile(path.join(first.dir, 'memories', 'MEMORY.md'), 'utf8')).toBe(
      'remember me',
    )
    expect(await stat(path.join(first.dir, 'skills', 'deploy', 'SKILL.md'))).toBeTruthy()

    // The runner recreates the old folder as an empty identity home; it is not
    // moved over the profile again.
    await mkdir(legacy, { recursive: true })
    const again = await provisionProfile(base({ cwd: path.join(root, 'elsewhere') }))
    expect(again).toMatchObject({ created: false, migrated: false })
    expect(await readFile(path.join(again.dir, 'memories', 'MEMORY.md'), 'utf8')).toBe(
      'remember me',
    )
    const env = await readFile(path.join(again.dir, '.env'), 'utf8')
    expect(env).toContain(`TERMINAL_CWD="${path.join(root, 'elsewhere')}"`)
  })

  it('writes the .env and the MCP block for a new agent, owner-only', async () => {
    const out = await provisionProfile(base({ legacyHome: null }))
    expect(out).toMatchObject({ created: true, migrated: false, mcpAttached: true })
    const env = await readFile(path.join(out.dir, '.env'), 'utf8')
    expect(env).toContain(`API_SERVER_KEY="${'p'.repeat(64)}"`)
    expect(env).toContain('OPENROUTER_API_KEY="sk-or"')
    const config = await readFile(path.join(out.dir, 'config.yaml'), 'utf8')
    expect(config).toContain('clawboo-tasks:')
    expect(config).toContain('live=1')
    if (process.platform !== 'win32') {
      expect((await stat(path.join(out.dir, '.env'))).mode & 0o077).toBe(0)
    }
    expect(await listClawbooProfiles(path.join(root, 'gw'))).toEqual(['cb-agent-1'])
  })

  it("seeds config.yaml from the person's own Hermes config with its terminal block pinned", async () => {
    await mkdir(path.join(root, 'home', '.hermes'), { recursive: true })
    await writeFile(
      path.join(root, 'home', '.hermes', 'config.yaml'),
      'model:\n  provider: anthropic\nterminal:\n  backend: docker\n  cwd: /home/me\n',
    )
    const out = await provisionProfile(base({ legacyHome: null }))
    const config = await readFile(path.join(out.dir, 'config.yaml'), 'utf8')
    expect(config).toContain('provider: anthropic')
    expect(config).toContain('  backend: local')
    expect(config).toContain('  cwd: "."')
    expect(config).not.toContain('/home/me')
    // The person's own file is untouched.
    expect(await readFile(path.join(root, 'home', '.hermes', 'config.yaml'), 'utf8')).toContain(
      'backend: docker',
    )
  })

  it("does not copy the person's chat channels into a profile", async () => {
    await mkdir(path.join(root, 'home', '.hermes'), { recursive: true })
    await writeFile(
      path.join(root, 'home', '.hermes', 'config.yaml'),
      'model:\n  provider: anthropic\nplatforms:\n  discord:\n    token: secret-bot\n',
    )
    const out = await provisionProfile(base({ legacyHome: null }))
    const config = await readFile(path.join(out.dir, 'config.yaml'), 'utf8')
    expect(config).toContain('provider: anthropic')
    expect(config).not.toContain('secret-bot')
    expect(config).not.toContain('platforms:')
  })

  it('refuses a profile path that is a link, so nothing is written through it', async () => {
    if (process.platform === 'win32') return
    const target = path.join(root, 'home', '.hermes')
    await mkdir(target, { recursive: true })
    await writeFile(path.join(target, '.env'), 'MINE=1\n')
    await mkdir(path.join(root, 'gw', 'profiles'), { recursive: true })
    await symlink(target, path.join(root, 'gw', 'profiles', 'cb-agent-1'))
    await expect(provisionProfile(base({ legacyHome: null }))).rejects.toThrow(/is a link/)
    expect(await readFile(path.join(target, '.env'), 'utf8')).toBe('MINE=1\n')
  })

  it("sets aside a gone agent's profile, and gives it back when the agent returns", async () => {
    const gw = path.join(root, 'gw')
    const kept = await provisionProfile(base({ legacyHome: null }))
    await writeFile(path.join(kept.dir, 'jobs.json'), '{}')
    await provisionProfile(base({ legacyHome: null, profile: 'cb-agent-2' }))
    await mkdir(path.join(gw, 'profiles', 'cbtmp-0123456789abcdef'), { recursive: true })

    // While the registry cannot be read, nothing is set aside; throwaways stay
    // unless asked.
    expect(await tidyProfiles(gw, { keep: null, removeThrowaways: false })).toEqual({
      removed: [],
      setAside: [],
    })
    const out = await tidyProfiles(gw, {
      keep: new Set(['cb-agent-2']),
      removeThrowaways: true,
    })
    expect(out).toEqual({ removed: ['cbtmp-0123456789abcdef'], setAside: ['cb-agent-1'] })
    expect(await listClawbooProfiles(gw)).toEqual(['cb-agent-2'])
    expect(
      await readFile(path.join(setAsideProfilesDir(gw), 'cb-agent-1', 'jobs.json'), 'utf8'),
    ).toBe('{}')

    const back = await provisionProfile(base({ legacyHome: null }))
    expect(back.created).toBe(false)
    expect(await readFile(path.join(back.dir, 'jobs.json'), 'utf8')).toBe('{}')
  })

  it('sets a profile aside without its keys or its sign-in copy', async () => {
    const gw = path.join(root, 'gw')
    const gone = await provisionProfile(base({ legacyHome: null }))
    await writeFile(path.join(gone.dir, 'auth.json'), '{"providers":{}}')
    await tidyProfiles(gw, { keep: new Set<string>(), removeThrowaways: false })
    const aside = path.join(setAsideProfilesDir(gw), 'cb-agent-1')
    expect(await readFile(path.join(aside, '.env'), 'utf8')).not.toContain('sk-or')
    await expect(stat(path.join(aside, 'auth.json'))).rejects.toThrow()
    // One set aside before this, keys and all, loses them at the next refresh.
    await writeFile(path.join(aside, '.env'), 'OPENROUTER_API_KEY="sk-or-old"\n')
    await refreshProfileProviderKeys(gw, () => ({ OPENROUTER_API_KEY: 'sk-or-now' }))
    expect(await readFile(path.join(aside, '.env'), 'utf8')).not.toContain('sk-or')
  })

  it("pins approvals to the person's own choice before every run, whatever the agent wrote", async () => {
    const out = await provisionProfile(base({ legacyHome: null }))
    const config = path.join(out.dir, 'config.yaml')
    expect(await readFile(config, 'utf8')).toContain('  mode: manual')
    // The agent turns its own approvals off...
    await writeFile(config, (await readFile(config, 'utf8')).replace('mode: manual', 'mode: off'))
    await provisionProfile(base({ legacyHome: null }))
    expect(await readFile(config, 'utf8')).toContain('  mode: manual')
    // ...while the person's own Hermes config decides it.
    await mkdir(path.join(root, 'home', '.hermes'), { recursive: true })
    await writeFile(
      path.join(root, 'home', '.hermes', 'config.yaml'),
      'approvals:\n  mode: smart\n',
    )
    await provisionProfile(base({ legacyHome: null }))
    expect(await readFile(config, 'utf8')).toContain('  mode: smart')
  })

  it("sets the jobs' approval setting back too: a job cannot be let run flagged commands", async () => {
    const out = await provisionProfile(base({ legacyHome: null }))
    const config = path.join(out.dir, 'config.yaml')
    expect(readAsHermes(await readFile(config, 'utf8'))).toMatchObject({ cronMode: 'deny' })
    // The agent lets its own jobs run flagged commands...
    await writeFile(
      config,
      (await readFile(config, 'utf8')).replace(
        '  mode: manual',
        '  mode: manual\n  cron_mode: approve',
      ),
    )
    await provisionProfile(base({ legacyHome: null }))
    expect(readAsHermes(await readFile(config, 'utf8'))).toMatchObject({ cronMode: 'deny' })
    // ...while the person's own Hermes config decides it.
    await mkdir(path.join(root, 'home', '.hermes'), { recursive: true })
    await writeFile(
      path.join(root, 'home', '.hermes', 'config.yaml'),
      'approvals:\n  cron_mode: approve\n',
    )
    await provisionProfile(base({ legacyHome: null }))
    expect(readAsHermes(await readFile(config, 'utf8'))).toMatchObject({
      approvalMode: 'manual',
      cronMode: 'approve',
    })
  })

  it("drops chat channels from an old Hermes home's config when it moves in", async () => {
    const legacy = path.join(root, 'legacy', 'agent-1')
    await mkdir(path.join(legacy, 'memories'), { recursive: true })
    await writeFile(path.join(legacy, 'memories', 'MEMORY.md'), 'x')
    // An earlier Clawboo copied the person's whole config into the agent's home.
    await writeFile(
      path.join(legacy, 'config.yaml'),
      'model:\n  provider: openrouter\nplatforms:\n  telegram:\n    token: tg-secret\ntelegram:\n  enabled: true\n',
    )
    const out = await provisionProfile(base())
    expect(out.migrated).toBe(true)
    const body = await readFile(path.join(out.dir, 'config.yaml'), 'utf8')
    expect(body).toContain('provider: openrouter')
    expect(body).not.toContain('platforms:')
    expect(body).not.toContain('tg-secret')
    expect(body).not.toMatch(/^telegram:/m)
  })

  it('rebuilds a config an agent wrote to slip past the line pins', async () => {
    const out = await provisionProfile(base({ legacyHome: null }))
    const config = path.join(out.dir, 'config.yaml')
    for (const tamper of [
      'approvals:\n  mode: manual\napprovals:\n  mode: off\n',
      '"approvals":\n  mode: off\n',
      'off_switch: &x {mode: off}\napprovals:\n  <<: *x\n',
      'terminal:\n  backend: local\n"terminal": {backend: ssh}\n',
    ]) {
      await writeFile(config, tamper)
      await provisionProfile(base({ legacyHome: null }))
      const body = await readFile(config, 'utf8')
      expect(holdsPins(body, DEFAULT_APPROVAL_PINS)).toBe(true)
      expect(readAsHermes(body)).toMatchObject({ approvalMode: 'manual' })
      // Clawboo's MCP servers are attached again too.
      expect(body).toContain('clawboo-tasks:')
    }
  })

  it('rewrites a config whose bytes are not exactly what Clawboo checked', async () => {
    const out = await provisionProfile(base({ legacyHome: null }))
    const config = path.join(out.dir, 'config.yaml')
    const good = await readFile(config)
    for (const tamper of [
      // An invalid UTF-8 byte in a leading comment, decoded leniently as U+FFFD
      // (the text then pins the same, so only a byte compare sees it).
      Buffer.concat([Buffer.from('# \xff\n', 'latin1'), good]),
      // A byte order mark in front of an otherwise pinned file.
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), good]),
      // A character PyYAML refuses, in a leading comment.
      Buffer.concat([Buffer.from('# \u0007\n', 'utf8'), good]),
    ]) {
      await writeFile(config, tamper)
      await provisionProfile(base({ legacyHome: null }))
      const after = await readFile(config)
      expect(after.equals(tamper)).toBe(false)
      expect(holdsPins(after.toString('utf8'), DEFAULT_APPROVAL_PINS)).toBe(true)
    }
  })

  it('the gateway home files are written owner-only', async () => {
    const home = path.join(root, 'gw')
    await provisionGatewayHome({ home, port: 8650, key: 'r'.repeat(64) })
    expect(await readFile(path.join(home, '.env'), 'utf8')).toContain('API_SERVER_PORT="8650"')
    expect(await readFile(path.join(home, 'config.yaml'), 'utf8')).toContain('multiplex_profiles')
    if (process.platform !== 'win32') {
      expect((await stat(path.join(home, '.env'))).mode & 0o077).toBe(0)
    }
  })
})
