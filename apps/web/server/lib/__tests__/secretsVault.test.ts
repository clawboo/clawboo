// Encrypted credential vault — AES-256-GCM round-trip, fail-closed on a
// wrong/rotated key, presence check that never decrypts, master-key + dir perms,
// and the resolution chain (process.env → vault → OpenClaw .env). The
// load-bearing security proof: a secret VALUE never lands in cleartext on disk.

import { randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  deleteRuntimeSecret,
  getRuntimeSecret,
  hasRuntimeSecret,
  resolveRuntimeKey,
  setRuntimeSecret,
} from '../secretsVault'

const isWindows = process.platform === 'win32'

describe('secretsVault', () => {
  let clawbooHome: string
  let stateDir: string
  const prev: Record<string, string | undefined> = {}
  // Clear the provider vars too — the dev/CI box may have a real
  // ANTHROPIC_API_KEY / OPENROUTER_API_KEY exported, which would shadow the
  // vault + OpenClaw-.env fallback under test (process.env wins by design).
  const SAVED = [
    'CLAWBOO_HOME',
    'CLAWBOO_SECRETS_MASTER_KEY',
    'OPENCLAW_STATE_DIR',
    'ANTHROPIC_API_KEY',
    'OPENROUTER_API_KEY',
  ] as const

  beforeEach(() => {
    for (const k of SAVED) prev[k] = process.env[k]
    clawbooHome = mkdtempSync(path.join(os.tmpdir(), 'clawboo-vault-'))
    stateDir = mkdtempSync(path.join(os.tmpdir(), 'clawboo-state-'))
    process.env['CLAWBOO_HOME'] = clawbooHome
    process.env['OPENCLAW_STATE_DIR'] = stateDir
    delete process.env['CLAWBOO_SECRETS_MASTER_KEY']
    delete process.env['ANTHROPIC_API_KEY']
    delete process.env['OPENROUTER_API_KEY']
  })
  afterEach(() => {
    for (const k of SAVED) {
      if (prev[k] === undefined) delete process.env[k]
      else process.env[k] = prev[k]
    }
    rmSync(clawbooHome, { recursive: true, force: true })
    rmSync(stateDir, { recursive: true, force: true })
  })

  it('encrypts + decrypts a value (round-trip)', () => {
    setRuntimeSecret('ANTHROPIC_API_KEY', 'sk-ant-secret-123')
    expect(getRuntimeSecret('ANTHROPIC_API_KEY')).toBe('sk-ant-secret-123')
  })

  it('stores ciphertext only — the plaintext never lands on disk', () => {
    setRuntimeSecret('OPENROUTER_API_KEY', 'sk-or-PLAINTEXT-NEVER-ON-DISK')
    const vaultFile = path.join(clawbooHome, 'secrets', 'runtime-keys.json')
    const onDisk = readFileSync(vaultFile, 'utf8')
    expect(onDisk).not.toContain('sk-or-PLAINTEXT-NEVER-ON-DISK')
    // The encrypted entry IS present (keyed by env-var name) with iv/tag/ciphertext.
    const parsed = JSON.parse(onDisk) as Record<
      string,
      { iv: string; tag: string; ciphertext: string }
    >
    expect(parsed['OPENROUTER_API_KEY']).toMatchObject({
      iv: expect.any(String),
      tag: expect.any(String),
      ciphertext: expect.any(String),
    })
    // …and it still decrypts back.
    expect(getRuntimeSecret('OPENROUTER_API_KEY')).toBe('sk-or-PLAINTEXT-NEVER-ON-DISK')
  })

  it('presence check never decrypts; delete removes the entry', () => {
    expect(hasRuntimeSecret('ANTHROPIC_API_KEY')).toBe(false)
    setRuntimeSecret('ANTHROPIC_API_KEY', 'sk-ant-x')
    expect(hasRuntimeSecret('ANTHROPIC_API_KEY')).toBe(true)
    deleteRuntimeSecret('ANTHROPIC_API_KEY')
    expect(hasRuntimeSecret('ANTHROPIC_API_KEY')).toBe(false)
    expect(getRuntimeSecret('ANTHROPIC_API_KEY')).toBeNull()
  })

  it('fails closed on a wrong/rotated master key (no plaintext, no throw)', () => {
    const keyA = randomBytes(32).toString('base64')
    const keyB = randomBytes(32).toString('base64')
    process.env['CLAWBOO_SECRETS_MASTER_KEY'] = keyA
    setRuntimeSecret('ANTHROPIC_API_KEY', 'sk-ant-rotated')
    expect(getRuntimeSecret('ANTHROPIC_API_KEY')).toBe('sk-ant-rotated')
    // Rotate the master key — the old ciphertext is now undecryptable.
    process.env['CLAWBOO_SECRETS_MASTER_KEY'] = keyB
    expect(() => getRuntimeSecret('ANTHROPIC_API_KEY')).not.toThrow()
    expect(getRuntimeSecret('ANTHROPIC_API_KEY')).toBeNull()
  })

  it('rejects an invalid CLAWBOO_SECRETS_MASTER_KEY (fail loud on set)', () => {
    process.env['CLAWBOO_SECRETS_MASTER_KEY'] = 'too-short'
    expect(() => setRuntimeSecret('ANTHROPIC_API_KEY', 'x')).toThrow(/CLAWBOO_SECRETS_MASTER_KEY/)
  })

  it('fails closed on a tampered ciphertext — the GCM auth tag is verified', () => {
    setRuntimeSecret('ANTHROPIC_API_KEY', 'sk-ant-tamper-target')
    const vaultFile = path.join(clawbooHome, 'secrets', 'runtime-keys.json')
    const v = JSON.parse(readFileSync(vaultFile, 'utf8')) as Record<string, { ciphertext: string }>
    const ct = Buffer.from(v['ANTHROPIC_API_KEY']!.ciphertext, 'base64')
    ct[0] ^= 0xff // flip a byte — GCM must reject it
    v['ANTHROPIC_API_KEY']!.ciphertext = ct.toString('base64')
    writeFileSync(vaultFile, JSON.stringify(v), 'utf8')
    expect(() => getRuntimeSecret('ANTHROPIC_API_KEY')).not.toThrow()
    expect(getRuntimeSecret('ANTHROPIC_API_KEY')).toBeNull()
  })

  it('fails closed on a truncated auth tag (no weakened-integrity decrypt)', () => {
    setRuntimeSecret('ANTHROPIC_API_KEY', 'sk-ant-tag-target')
    const vaultFile = path.join(clawbooHome, 'secrets', 'runtime-keys.json')
    const v = JSON.parse(readFileSync(vaultFile, 'utf8')) as Record<string, { tag: string }>
    v['ANTHROPIC_API_KEY']!.tag = Buffer.from(v['ANTHROPIC_API_KEY']!.tag, 'base64')
      .subarray(0, 8)
      .toString('base64')
    writeFileSync(vaultFile, JSON.stringify(v), 'utf8')
    expect(getRuntimeSecret('ANTHROPIC_API_KEY')).toBeNull()
  })

  it('auto-generates the master key with 0600 perms inside a 0700 secrets dir', () => {
    setRuntimeSecret('ANTHROPIC_API_KEY', 'sk-ant-perms')
    const dir = path.join(clawbooHome, 'secrets')
    const keyFile = path.join(dir, 'master.key')
    expect(statSync(keyFile).isFile()).toBe(true)
    if (!isWindows) {
      expect(statSync(dir).mode & 0o777).toBe(0o700)
      expect(statSync(keyFile).mode & 0o777).toBe(0o600)
      expect(statSync(path.join(dir, 'runtime-keys.json')).mode & 0o777).toBe(0o600)
    }
  })

  it('resolveRuntimeKey precedence: process.env > vault > OpenClaw .env', () => {
    // 1. OpenClaw .env fallback (lowest).
    writeFileSync(path.join(stateDir, '.env'), 'OPENROUTER_API_KEY=or-from-openclaw-env\n', 'utf8')
    expect(resolveRuntimeKey('OPENROUTER_API_KEY')).toBe('or-from-openclaw-env')

    // 2. Vault beats the OpenClaw .env fallback.
    setRuntimeSecret('OPENROUTER_API_KEY', 'or-from-vault')
    expect(resolveRuntimeKey('OPENROUTER_API_KEY')).toBe('or-from-vault')

    // 3. process.env beats everything.
    process.env['OPENROUTER_API_KEY'] = 'or-from-process-env'
    try {
      expect(resolveRuntimeKey('OPENROUTER_API_KEY')).toBe('or-from-process-env')
    } finally {
      delete process.env['OPENROUTER_API_KEY']
    }
  })

  it('reuses an existing OpenClaw provider key when the vault is empty (auto-connect path)', () => {
    // Mirrors "configured OpenClaw with Anthropic → Claude Code auto-connects".
    mkdirSync(stateDir, { recursive: true })
    writeFileSync(path.join(stateDir, '.env'), 'ANTHROPIC_API_KEY=sk-ant-from-openclaw\n', 'utf8')
    expect(hasRuntimeSecret('ANTHROPIC_API_KEY')).toBe(false)
    expect(resolveRuntimeKey('ANTHROPIC_API_KEY')).toBe('sk-ant-from-openclaw')
  })
})
