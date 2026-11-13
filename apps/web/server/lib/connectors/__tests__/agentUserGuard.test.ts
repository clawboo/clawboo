// With agents running as their own OS user, a per-agent browser starts as that
// user: what it is given to read must be readable by it, and what keeps it off
// the dashboard must not be writable by it.

import { createHash } from 'node:crypto'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../platform', async (orig) => ({
  ...(await orig<typeof import('../../platform')>()),
  findExecutable: () => '/usr/local/bin/npx',
}))

import { browserGuardArgs } from '../dashboardGuard'
import { planConnectorSpawn } from '../spawnPlan'

const posix = process.platform !== 'win32'

describe.runIf(posix)('browser launch files under agent isolation', () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'clawboo-agentguard-'))
    vi.stubEnv('CLAWBOO_HOME', path.join(root, 'data'))
    vi.stubEnv('npm_config_cache', path.join(root, 'npm-cache'))
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    rmSync(root, { recursive: true, force: true })
  })

  it("puts Playwright's guard file where the agent user can read it and not change it", () => {
    vi.stubEnv('CLAWBOO_AGENT_USER', 'clawboo-agent')
    const [flag, file] = browserGuardArgs(
      'playwright',
      { chromeSwitchArg: { flag: '--config', style: 'playwrightConfig' } },
      18790,
    )
    expect(flag).toBe('--config')
    expect(file!.startsWith(path.join(root, 'data'))).toBe(false)
    expect(statSync(path.dirname(file!)).mode & 0o777).toBe(0o755)
    expect(statSync(file!).mode & 0o777).toBe(0o644)
    expect(statSync(path.dirname(file!)).uid).toBe(process.getuid?.())
    expect(readFileSync(file!, 'utf8')).toContain('host-resolver-rules')
  })

  it('makes a fresh guard folder when the one it made was removed and taken by someone else', () => {
    vi.stubEnv('CLAWBOO_AGENT_USER', 'clawboo-agent')
    const pw = { chromeSwitchArg: { flag: '--config', style: 'playwrightConfig' } as const }
    const [, first] = browserGuardArgs('playwright', pw, 18790)
    const dir = path.dirname(first!)
    // A temp cleaner removed it, and another user made one by the same name,
    // with a link where the next write would go.
    rmSync(dir, { recursive: true, force: true })
    mkdirSync(dir, { mode: 0o777 })
    chmodSync(dir, 0o777)
    symlinkSync(path.join(root, 'data-file'), first!)
    writeFileSync(path.join(root, 'data-file'), 'database')
    const [, second] = browserGuardArgs('playwright', pw, 18791)
    expect(path.dirname(second!)).not.toBe(dir)
    expect(readFileSync(path.join(root, 'data-file'), 'utf8')).toBe('database')
    expect(readFileSync(second!, 'utf8')).toContain('18791')
    rmSync(dir, { recursive: true, force: true })
  })

  it('writes the guard file readable by every user whatever the umask', () => {
    vi.stubEnv('CLAWBOO_AGENT_USER', 'clawboo-agent')
    const old = process.umask(0o077)
    try {
      const [, file] = browserGuardArgs(
        'playwright',
        { chromeSwitchArg: { flag: '--config', style: 'playwrightConfig' } },
        18799,
      )
      expect(statSync(file!).mode & 0o777).toBe(0o644)
    } finally {
      process.umask(old)
    }
  })

  it("does not hand the agent user a bin from the server user's npm cache", () => {
    const spec = '@playwright/mcp@0.0.79'
    const dir = path.join(
      root,
      'npm-cache',
      '_npx',
      createHash('sha512').update(spec).digest('hex').slice(0, 16),
      'node_modules',
    )
    mkdirSync(path.join(dir, '@playwright', 'mcp'), { recursive: true })
    writeFileSync(
      path.join(dir, '@playwright', 'mcp', 'package.json'),
      JSON.stringify({
        name: '@playwright/mcp',
        version: '0.0.79',
        bin: { 'playwright-mcp': 'cli.js' },
      }),
    )
    writeFileSync(path.join(dir, '@playwright', 'mcp', 'cli.js'), '#!/usr/bin/env node\n')
    writeFileSync(path.join(dir, '.package-lock.json'), '{}')
    const launch = { command: 'npx', args: ['-y', spec, '--headless'] }

    // Started by the server: the cached copy runs directly, as before.
    expect(planConnectorSpawn(launch, { besideServer: [] }).command).toBe(process.execPath)
    vi.stubEnv('CLAWBOO_AGENT_USER', 'clawboo-agent')
    expect(planConnectorSpawn(launch, { besideServer: [] }).command).toBe(process.execPath)
    // Started by the agent host: npx, which the agent user runs with a cache of its own.
    expect(planConnectorSpawn(launch, { besideServer: [], asAgentUser: true }).command).not.toBe(
      process.execPath,
    )
  })
})
