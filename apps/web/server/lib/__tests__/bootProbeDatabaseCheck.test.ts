// The boot probe's database line: a check that could not run degrades the report
// and never fails it, and the full check runs in the background at most once a
// day, its finding replacing the boot probe's quick one. The worker is mocked; a
// sandboxed home holds the real database the probe opens.

import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { getSetting } from '@clawboo/db'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const checks = vi.hoisted(() => ({
  next: [] as Array<{ ran: true; verdict: string } | { ran: false; reason: string }>,
  calls: [] as string[],
}))
vi.mock('../dbCheck', () => ({
  checkDatabase: async (_file: string, kind: string) => {
    checks.calls.push(kind)
    return checks.next.shift() ?? { ran: true, verdict: 'ok' }
  },
}))

import {
  FULL_DATABASE_CHECK_AT_KEY,
  getLastBootReport,
  runBootProbe,
  startBackgroundFullDatabaseCheck,
} from '../bootProbe'
import { getDb, getDbPath, resetDb } from '../db'

let home: string
const saved = { HOME: process.env['HOME'], CLAWBOO_HOME: process.env['CLAWBOO_HOME'] }

beforeEach(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), 'clawboo-bootprobe-db-'))
  process.env['HOME'] = home
  process.env['CLAWBOO_HOME'] = path.join(home, '.clawboo')
  expect(getDbPath().startsWith(home)).toBe(true)
  checks.next = []
  checks.calls = []
})

afterEach(async () => {
  resetDb()
  for (const key of ['HOME', 'CLAWBOO_HOME'] as const) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
  await rm(home, { recursive: true, force: true }).catch(() => undefined)
})

const line = (report: Awaited<ReturnType<typeof runBootProbe>>) =>
  report.checks.find((c) => c.id === 'databaseIntegrity')

describe('the boot probe database line', () => {
  it('a check that could not run degrades the report instead of failing it', async () => {
    checks.next.push({ ran: false, reason: 'database is locked' })
    const report = await runBootProbe({ port: 18790 })
    expect(line(report)).toMatchObject({
      ok: false,
      message: 'SQLite quick integrity check could not run; Re-run probe tries again',
      detail: 'database is locked',
    })
    expect(report.fatal).not.toContain('databaseIntegrity')
    expect(report.degraded).toContain('databaseIntegrity')
  })

  it('damage SQLite reports is still fatal', async () => {
    checks.next.push({ ran: true, verdict: 'row 3 missing from index' })
    const report = await runBootProbe({ port: 18790 })
    expect(report.fatal).toContain('databaseIntegrity')
  })
})

describe('the background full check', () => {
  async function settled(): Promise<void> {
    for (let i = 0; i < 50 && checks.calls.length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }

  it('runs the full check after the start, and its finding replaces the quick one', async () => {
    await runBootProbe({ port: 18790 })
    expect(line(getLastBootReport()!)?.message).toBe('SQLite quick integrity check passed')
    checks.calls = []

    checks.next.push({ ran: true, verdict: 'row 3 missing from index' })
    const stop = startBackgroundFullDatabaseCheck({ delayMs: 0 })
    await settled()
    stop()

    expect(checks.calls).toEqual(['integrity_check'])
    const report = getLastBootReport()!
    expect(line(report)).toMatchObject({ ok: false, message: 'SQLite integrity check FAILED' })
    expect(report.fatal).toContain('databaseIntegrity')
    expect(Number(getSetting(getDb(), FULL_DATABASE_CHECK_AT_KEY))).toBeGreaterThan(0)
  })

  it('does not run again within a day of the last full check', async () => {
    // A person's Re-run probe counts as the day's full check.
    await runBootProbe({ port: 18790, fullDatabaseCheck: true })
    checks.calls = []
    const stop = startBackgroundFullDatabaseCheck({ delayMs: 0 })
    await new Promise((resolve) => setTimeout(resolve, 100))
    stop()
    expect(checks.calls).toEqual([])
  })
})
