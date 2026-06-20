// Per-runtime native homes — the isolation invariants: a hostile agentId can
// never escape its runtime/agent dir or reach the vault, and a clawboo-owned home
// file is owner-only (no credentials live here, but defense in depth).

import { mkdtemp, rm, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { provisionHermesHome } from '../hermesHome'
import { runtimeIdentityHomePath, sanitizeAgentId } from '../identityHome'

const isWindows = process.platform === 'win32'

describe('per-runtime native home isolation', () => {
  let home: string
  let prev: string | undefined

  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), 'clawboo-home-test-'))
    prev = process.env['CLAWBOO_HOME']
    process.env['CLAWBOO_HOME'] = home
  })
  afterEach(async () => {
    if (prev === undefined) delete process.env['CLAWBOO_HOME']
    else process.env['CLAWBOO_HOME'] = prev
    await rm(home, { recursive: true, force: true })
  })

  it('sanitizeAgentId strips every traversal/separator char', () => {
    for (const hostile of [
      '../../.clawboo/secrets',
      '..%2f..',
      '/etc/passwd',
      '..\\win',
      '../../../master',
    ]) {
      const s = sanitizeAgentId(hostile)
      expect(s).not.toMatch(/[./\\]/)
      expect(s).not.toContain('..')
    }
    expect(sanitizeAgentId('')).toBe('_default')
  })

  it('runtimeIdentityHomePath stays under runtimes/<id> and never reaches the secrets vault', () => {
    const secretsDir = path.join(home, 'secrets')
    const runtimesDir = path.join(home, 'runtimes', 'hermes')
    for (const hostile of ['../../secrets/master', '/etc/passwd', '..\\..\\secrets']) {
      const resolved = path.resolve(runtimeIdentityHomePath('hermes', hostile))
      expect(resolved.startsWith(path.resolve(runtimesDir) + path.sep)).toBe(true)
      // It can never climb out to the vault.
      expect(path.relative(secretsDir, resolved).startsWith('..')).toBe(true)
    }
  })

  it('a clawboo-owned mcp.json is written owner-only (0600)', async () => {
    if (isWindows) return // POSIX modes are a no-op on Windows
    const agentHome = runtimeIdentityHomePath('hermes', 'native-x-abc123')
    await provisionHermesHome(agentHome, { mcpJson: '{"mcpServers":{}}' })
    const mcp = path.join(agentHome, 'mcp.json')
    expect(existsSync(mcp)).toBe(true)
    expect((await stat(mcp)).mode & 0o077).toBe(0) // not group/other readable
    expect((await stat(agentHome)).mode & 0o777).toBe(0o700)
  })
})
