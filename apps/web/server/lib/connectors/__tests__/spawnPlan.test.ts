import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../platform', async (orig) => {
  const actual = await orig<typeof import('../../platform')>()
  return { ...actual, findExecutable: vi.fn(actual.findExecutable) }
})

import { findExecutable } from '../../platform'
import { nodeModulesBeside, planConnectorSpawn } from '../spawnPlan'

const mockFind = vi.mocked(findExecutable)

describe('planConnectorSpawn', () => {
  it('shows the RESOLVED absolute command, not the catalog spelling', () => {
    // "npx" and "/usr/local/bin/npx" are different consent requests.
    mockFind.mockReturnValueOnce('/usr/local/bin/npx')
    const plan = planConnectorSpawn({ command: 'npx', args: ['-y', 'pkg@1.0.0'] })
    expect(plan.command).toBe('/usr/local/bin/npx')
    expect(plan.display).toContain('/usr/local/bin/npx')
    expect(plan.unresolved).toBe(false)
  })

  it('uses an ABSOLUTE command as-is, without a PATH lookup', () => {
    // Windows `where` searches PATH for a NAME and fails on a full path, so
    // looking one up would report an existing binary as missing. POSIX `which`
    // tolerates it, which is why this only ever broke on Windows.
    mockFind.mockClear()
    const plan = planConnectorSpawn({ command: process.execPath, args: ['-e', ''] })
    expect(plan.command).toBe(process.execPath)
    expect(plan.unresolved).toBe(false)
    expect(mockFind).not.toHaveBeenCalled()
  })

  it('reports an unresolved binary rather than throwing', () => {
    // A missing Node is an ordinary user-fixable condition, and the caller can
    // render it far better than an exception can.
    mockFind.mockReturnValueOnce(null)
    const plan = planConnectorSpawn({ command: 'npx', args: [] })
    expect(plan.unresolved).toBe(true)
    expect(plan.command).toBe('npx')
  })

  it('passes catalog args through as an ARRAY, never a shell string', () => {
    // The whole hazard: an arg from a registry snapshot containing shell
    // metacharacters must arrive at the child as literal argv.
    mockFind.mockReturnValueOnce('/usr/local/bin/npx')
    const nasty = ['-y', 'pkg@1.0.0', '& calc.exe', '$(whoami)', 'a|b']
    const plan = planConnectorSpawn({ command: 'npx', args: nasty })
    expect(plan.args).toEqual(nasty)
  })

  it('never rewrites the spawn command, so cross-spawn can do its own routing', () => {
    // The MCP SDK spawns through cross-spawn, which handles .cmd itself and sets
    // windowsVerbatimArguments -- the half that makes its escaping correct.
    // Pre-routing to cmd.exe here would make cross-spawn skip that, and Node
    // would re-quote an already-escaped line.
    mockFind.mockReturnValueOnce('C:\\Program Files\\nodejs\\npx.cmd')
    const plan = planConnectorSpawn({ command: 'npx', args: ['-y', 'pkg@1.0.0'] })
    expect(plan.command).toBe('C:\\Program Files\\nodejs\\npx.cmd')
    expect(plan.args).toEqual(['-y', 'pkg@1.0.0'])
    expect(plan.command.toLowerCase()).not.toContain('cmd.exe')
  })

  it('quotes a dangerous arg for DISPLAY without changing what is spawned', () => {
    mockFind.mockReturnValueOnce('/usr/local/bin/npx')
    const plan = planConnectorSpawn({ command: 'npx', args: ['& calc.exe'] })
    // Visible to the operator as a single quoted token...
    expect(plan.display).toContain('"& calc.exe"')
    // ...while argv is untouched.
    expect(plan.args).toEqual(['& calc.exe'])
  })
})

// The browsers used to start through `npx -y`, which keeps an `npm exec` process
// resident beside each server (about as much memory as the server itself) and
// asks the registry for the package manifest on every launch, warm cache or not.
describe('a pinned browser package that is already installed', () => {
  let root: string

  /** Lay out a package the way npm installs one, with an `npx` marker. */
  function installPackage(
    dir: string,
    name: string,
    version: string,
    bin: Record<string, string> | string,
    files: Record<string, string>,
  ): string {
    const pkgDir = path.join(dir, 'node_modules', ...name.split('/'))
    mkdirSync(pkgDir, { recursive: true })
    writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name, version, bin }))
    for (const [rel, body] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(pkgDir, rel)), { recursive: true })
      writeFileSync(path.join(pkgDir, rel), body)
    }
    writeFileSync(path.join(dir, 'node_modules', '.package-lock.json'), '{}')
    return pkgDir
  }

  /** Where `npx -y <spec>` keeps its install: `_npx/<first 16 hex of sha512(spec)>`. */
  function npxDir(cache: string, spec: string): string {
    return path.join(cache, '_npx', createHash('sha512').update(spec).digest('hex').slice(0, 16))
  }

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'clawboo-spawnplan-'))
    vi.stubEnv('npm_config_cache', path.join(root, 'npm-cache'))
    mockFind.mockReturnValue('/usr/local/bin/npx')
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    mockFind.mockReset()
    rmSync(root, { recursive: true, force: true })
  })

  it("runs the npx cache's copy of the exact pinned version directly, without npm exec", () => {
    const pkgDir = installPackage(
      npxDir(path.join(root, 'npm-cache'), '@playwright/mcp@0.0.79'),
      '@playwright/mcp',
      '0.0.79',
      { 'playwright-mcp': 'cli.js' },
      { 'cli.js': '#!/usr/bin/env node\n' },
    )

    const plan = planConnectorSpawn(
      { command: 'npx', args: ['-y', '@playwright/mcp@0.0.79', '--headless'] },
      { besideServer: [] },
    )
    expect(plan.command).toBe(process.execPath)
    expect(plan.args).toEqual([path.join(pkgDir, 'cli.js'), '--headless'])
    expect(plan.display).toContain(path.join(pkgDir, 'cli.js'))
    expect(plan.unresolved).toBe(false)
  })

  it('runs a copy installed beside Clawboo, picking the bin named after the package', () => {
    const globalDir = path.join(root, 'global')
    const pkgDir = installPackage(
      globalDir,
      'chrome-devtools-mcp',
      '1.7.0',
      {
        'chrome-devtools-mcp': './build/src/bin/chrome-devtools-mcp.js',
        'chrome-devtools': './build/src/bin/chrome-devtools.js',
      },
      {
        'build/src/bin/chrome-devtools-mcp.js': '#!/usr/bin/env node\n',
        'build/src/bin/chrome-devtools.js': '#!/usr/bin/env node\n',
      },
    )

    const plan = planConnectorSpawn(
      { command: 'npx', args: ['-y', 'chrome-devtools-mcp@1.7.0'] },
      { besideServer: [path.join(globalDir, 'node_modules')] },
    )
    expect(plan.command).toBe(process.execPath)
    expect(plan.args).toEqual([path.join(pkgDir, 'build/src/bin/chrome-devtools-mcp.js')])
  })

  it('falls back to npx for any other version than the pin', () => {
    installPackage(
      npxDir(path.join(root, 'npm-cache'), '@playwright/mcp@0.0.79'),
      '@playwright/mcp',
      '0.0.78',
      { 'playwright-mcp': 'cli.js' },
      { 'cli.js': '#!/usr/bin/env node\n' },
    )
    const plan = planConnectorSpawn(
      { command: 'npx', args: ['-y', '@playwright/mcp@0.0.79'] },
      { besideServer: [] },
    )
    expect(plan.command).toBe('/usr/local/bin/npx')
    expect(plan.args).toEqual(['-y', '@playwright/mcp@0.0.79'])
  })

  it('falls back to npx for an install npm did not finish', () => {
    const dir = npxDir(path.join(root, 'npm-cache'), '@playwright/mcp@0.0.79')
    installPackage(
      dir,
      '@playwright/mcp',
      '0.0.79',
      { 'playwright-mcp': 'cli.js' },
      { 'cli.js': '#!/usr/bin/env node\n' },
    )
    rmSync(path.join(dir, 'node_modules', '.package-lock.json'))
    const plan = planConnectorSpawn(
      { command: 'npx', args: ['-y', '@playwright/mcp@0.0.79'] },
      { besideServer: [] },
    )
    expect(plan.command).toBe('/usr/local/bin/npx')
  })

  it('falls back to npx when nothing is installed yet', () => {
    const plan = planConnectorSpawn(
      { command: 'npx', args: ['-y', 'chrome-devtools-mcp@1.7.0'] },
      { besideServer: [] },
    )
    expect(plan.command).toBe('/usr/local/bin/npx')
    expect(plan.args).toEqual(['-y', 'chrome-devtools-mcp@1.7.0'])
  })

  it('leaves every other package to npx, installed or not', () => {
    installPackage(
      npxDir(path.join(root, 'npm-cache'), 'some-server@1.0.0'),
      'some-server',
      '1.0.0',
      'cli.js',
      { 'cli.js': '#!/usr/bin/env node\n' },
    )
    const plan = planConnectorSpawn(
      { command: 'npx', args: ['-y', 'some-server@1.0.0'] },
      { besideServer: [] },
    )
    expect(plan.command).toBe('/usr/local/bin/npx')
  })
})

describe('where an installed copy is looked for', () => {
  it("searches Clawboo's own package and the folder it was installed into, nothing above", () => {
    const prefix = path.resolve('/opt/node/lib/node_modules')
    const dist = path.join(prefix, 'clawboo', 'dist')
    expect(nodeModulesBeside(dist)).toEqual([
      path.join(dist, 'node_modules'),
      path.join(prefix, 'clawboo', 'node_modules'),
      prefix,
    ])
  })

  it('searches nowhere for a server that was not installed into a node_modules folder', () => {
    expect(nodeModulesBeside(path.resolve('/tmp/checkout/apps/web/dist'))).toEqual([])
  })
})

describe("chrome-devtools-mcp's usage statistics and update check", () => {
  beforeEach(() => {
    vi.stubEnv('npm_config_cache', path.join(os.tmpdir(), 'clawboo-spawnplan-no-cache'))
  })
  afterEach(() => vi.unstubAllEnvs())

  it('are turned off, however it is launched', () => {
    mockFind.mockReturnValueOnce('/usr/local/bin/npx')
    const plan = planConnectorSpawn(
      { command: 'npx', args: ['-y', 'chrome-devtools-mcp@1.7.0'] },
      { besideServer: [] },
    )
    expect(plan.env).toEqual({
      CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS: '1',
      CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS: '1',
    })
  })

  it("follow the server's own environment when the person set them", () => {
    vi.stubEnv('CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS', '')
    mockFind.mockReturnValueOnce('/usr/local/bin/npx')
    const plan = planConnectorSpawn(
      { command: 'npx', args: ['-y', 'chrome-devtools-mcp@1.7.0'] },
      { besideServer: [] },
    )
    expect(plan.env).toEqual({
      CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS: '',
      CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS: '1',
    })
  })

  it('are not set on other servers', () => {
    mockFind.mockReturnValueOnce('/usr/local/bin/npx')
    const plan = planConnectorSpawn({ command: 'npx', args: ['-y', '@playwright/mcp@0.0.79'] })
    expect(plan.env).toEqual({})
  })
})
