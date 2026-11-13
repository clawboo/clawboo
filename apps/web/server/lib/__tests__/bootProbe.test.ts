// Boot probe: each check in isolation against a sandboxed fresh ~/.clawboo, the
// master-key boot-sentinel write-on-first / decrypt-on-subsequent round-trip, the
// rotated-key degrade, and the api-port-file match. No Gateway runs: the gateway
// check skips on a sandbox with no OpenClaw set up, and degrades (stale) once an
// OpenClaw config exists. The report stays ok either way (no fatal checks).

import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { getProxyDeviceIdentityPath } from '@clawboo/gateway-proxy'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { runBootProbe } from '../bootProbe'
import { writeApiPortFile } from '../portUtils'

const itPosix = process.platform === 'win32' ? it.skip : it

let home: string
let prevHome: string | undefined
let prevMaster: string | undefined

beforeEach(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), 'clawboo-bootprobe-'))
  prevHome = process.env['HOME']
  prevMaster = process.env['CLAWBOO_SECRETS_MASTER_KEY']
  process.env['HOME'] = home
  process.env['CLAWBOO_HOME'] = path.join(home, '.clawboo')
  delete process.env['CLAWBOO_SECRETS_MASTER_KEY']
})
afterEach(async () => {
  if (prevHome === undefined) delete process.env['HOME']
  else process.env['HOME'] = prevHome
  delete process.env['CLAWBOO_HOME']
  if (prevMaster === undefined) delete process.env['CLAWBOO_SECRETS_MASTER_KEY']
  else process.env['CLAWBOO_SECRETS_MASTER_KEY'] = prevMaster
  await rm(home, { recursive: true, force: true }).catch(() => {})
})

const checkById = (report: Awaited<ReturnType<typeof runBootProbe>>, id: string) =>
  report.checks.find((c) => c.id === id)

describe('runBootProbe (fresh install)', () => {
  it('passes the foundational checks on a clean ~/.clawboo (no fatal)', async () => {
    const report = await runBootProbe({ port: 18790 })
    expect(report.fatal).toEqual([])
    expect(checkById(report, 'clawbooHomeWritable')?.ok).toBe(true)
    expect(checkById(report, 'databaseIntegrity')?.ok).toBe(true)
    expect(checkById(report, 'databaseSchema')?.ok).toBe(true)
    expect(checkById(report, 'otelExporterReachable')?.ok).toBe(true) // disabled = N/A = ok
    expect(report.resolved.clawbooHome).toContain('clawboo-bootprobe-')
    expect(report.config.budgetPosture).toBe('track-and-warn')
    expect(report.config.budgetHardCapUsdCents).toBeNull()
  })

  it("runs SQLite's quick check at boot and the full check when a person asks for it", async () => {
    const boot = await runBootProbe({ port: 18790 })
    expect(checkById(boot, 'databaseIntegrity')).toMatchObject({
      ok: true,
      message: 'SQLite quick integrity check passed',
    })
    const recheck = await runBootProbe({ port: 18790, fullDatabaseCheck: true })
    expect(checkById(recheck, 'databaseIntegrity')).toMatchObject({
      ok: true,
      message: 'SQLite integrity check passed',
    })
  })

  it('a Re-run probe that arrives while the boot probe runs still gets the full check', async () => {
    const boot = runBootProbe({ port: 18790 })
    const recheck = runBootProbe({ port: 18790, fullDatabaseCheck: true })
    expect(checkById(await boot, 'databaseIntegrity')?.message).toBe(
      'SQLite quick integrity check passed',
    )
    expect(checkById(await recheck, 'databaseIntegrity')?.message).toBe(
      'SQLite integrity check passed',
    )
  })

  it('writes the boot sentinel on first boot and decrypts it on the next (masterKeyOk)', async () => {
    const first = await runBootProbe({ port: 18790 })
    expect(first.resolved.masterKeyOk).toBe(true)
    expect(checkById(first, 'masterKeyBootSentinel')?.ok).toBe(true)

    const second = await runBootProbe({ port: 18790 })
    expect(second.resolved.masterKeyOk).toBe(true)
    expect(second.resolved.vaultPresent).toBe(true) // the sentinel created the vault
    expect(checkById(second, 'masterKeyBootSentinel')?.ok).toBe(true)
  })

  it('degrades (not fatal) when the master key has rotated — sentinel cannot decrypt', async () => {
    // First boot writes the sentinel under the auto-generated master key.
    await runBootProbe({ port: 18790 })
    // Next boot with a DIFFERENT (but valid) master key → decrypt fails closed.
    process.env['CLAWBOO_SECRETS_MASTER_KEY'] = 'a'.repeat(64) // 64-char hex = 32 bytes
    const report = await runBootProbe({ port: 18790 })
    expect(report.resolved.masterKeyOk).toBe(false)
    expect(checkById(report, 'masterKeyBootSentinel')?.ok).toBe(false)
    expect(report.degraded).toContain('masterKeyBootSentinel')
    expect(report.fatal).not.toContain('masterKeyBootSentinel') // degrade, never fatal
  })

  it('matches the api-port file when it agrees with the listening port', async () => {
    writeApiPortFile(18793)
    const report = await runBootProbe({ port: 18793 })
    expect(checkById(report, 'apiPortFileMatches')?.ok).toBe(true)
  })

  it('degrades apiPortFileMatches when the file disagrees with the port', async () => {
    writeApiPortFile(18793)
    const report = await runBootProbe({ port: 19999 })
    expect(checkById(report, 'apiPortFileMatches')?.ok).toBe(false)
    expect(report.degraded).toContain('apiPortFileMatches')
    expect(report.fatal).toEqual([]) // still not fatal
  })

  it('skips the OpenClaw Gateway check on an install that never set OpenClaw up', async () => {
    const report = await runBootProbe({ port: 18790 })
    // loadSettings still answers with the default address; that alone must not
    // read an install without OpenClaw as degraded.
    expect(checkById(report, 'openclawGatewayReachable')?.ok).toBe(true)
    expect(checkById(report, 'openclawGatewayReachable')?.message).toContain('skipped')
    expect(report.degraded).not.toContain('openclawGatewayReachable')
  })

  it('degrades the OpenClaw Gateway check (stale) when OpenClaw is set up but unreachable, but stays ok', async () => {
    mkdirSync(path.join(home, '.openclaw'), { recursive: true })
    writeFileSync(path.join(home, '.openclaw', 'openclaw.json'), '{}')
    const report = await runBootProbe({ port: 18790 })
    // OpenClaw's config exists but nothing is listening → degraded, not fatal.
    expect(checkById(report, 'openclawGatewayReachable')?.ok).toBe(false)
    expect(report.degraded).toContain('openclawGatewayReachable')
    expect(report.fatal).toEqual([])
  })

  itPosix(
    'vaultPerms flags a world-readable proxy device-identity file (degrades, not fatal)',
    async () => {
      const file = getProxyDeviceIdentityPath()
      mkdirSync(path.dirname(file), { recursive: true })
      writeFileSync(
        file,
        JSON.stringify({
          version: 1,
          deviceId: 'x',
          publicKey: 'p',
          privateKey: 'k',
          createdAtMs: 0,
        }),
        { mode: 0o600 },
      )
      chmodSync(file, 0o644)

      const bad = await runBootProbe({ port: 18790 })
      expect(checkById(bad, 'vaultPerms')?.ok).toBe(false)
      expect(checkById(bad, 'vaultPerms')?.detail).toContain('proxy-device-identity.json')
      expect(bad.fatal).toEqual([]) // perms are a degrade, never fatal

      chmodSync(file, 0o600)
      const good = await runBootProbe({ port: 18790 })
      expect(checkById(good, 'vaultPerms')?.ok).toBe(true)
    },
  )
})
