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
import { detectProvider, provisionHermesHome, type ProvisionedHermesHome } from '../hermesHome'
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

  it('provider precedence: config wins (no flag) → OPENROUTER key fallback → nothing', async () => {
    const home = await provisionHermesHome(identityHome())

    // 1. No config, no key → no flag (Hermes default `auto`).
    expect((await plan(home)).args).not.toContain('--provider')

    // 2. No config + OPENROUTER_API_KEY → the compatibility fallback.
    const withKey = await plan(home, { apiKeyEnv: { OPENROUTER_API_KEY: 'sk-or-test' } })
    const i = withKey.args.indexOf('--provider')
    expect(i).toBeGreaterThan(-1)
    expect(withKey.args[i + 1]).toBe('openrouter')

    // 3. Configured model.provider wins → no flag even with the key present.
    await writeFile(path.join(home.home, 'config.yaml'), 'model:\n  provider: anthropic\n', 'utf8')
    const configured = await plan(home, { apiKeyEnv: { OPENROUTER_API_KEY: 'sk-or-test' } })
    expect(configured.args).not.toContain('--provider')
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
})
