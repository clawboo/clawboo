// A quiet-mode Hermes run prints nothing until it exits, so the driver beats a
// `status: running` event while the process lives. Every idle watchdog counts any
// event as activity; without the beat a long run reads as a dead one. This drives
// the REAL driver against a fake `hermes` executable that works silently for a
// while and then answers.

import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import type { HermesNativeEvent } from '@clawboo/adapter-hermes'
import { mapHermesEvent } from '@clawboo/adapter-hermes'
import type { StartOpts } from '@clawboo/executor'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fakeBin = vi.hoisted(() => ({ path: '' }))
vi.mock('../../platform', async (importActual) => {
  const actual = await importActual<typeof import('../../platform')>()
  return { ...actual, resolveRuntimeBin: () => fakeBin.path }
})

const { createHermesDriver } = await import('../hermesDriver')

const FAKE_HERMES = `#!/usr/bin/env node
const ms = Number(process.env.FAKE_WORK_MS || '400')
process.on('SIGTERM', () => process.exit(130))
setTimeout(() => {
  process.stdout.write('Done\\n')
  process.stderr.write('\\nsession_id: sess-1\\n')
  process.exit(0)
}, ms)
`

const OPTS: StartOpts = { agentId: 'hm', sessionKey: 'agent:hm:team:t1', message: 'work' }

describe.skipIf(process.platform === 'win32')('createHermesDriver: liveness heartbeat', () => {
  let dir: string
  let prevWork: string | undefined

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'clawboo-hermes-beat-'))
    fakeBin.path = path.join(dir, 'hermes')
    await writeFile(fakeBin.path, FAKE_HERMES, 'utf8')
    await chmod(fakeBin.path, 0o755)
    prevWork = process.env['FAKE_WORK_MS']
  })
  afterEach(async () => {
    if (prevWork === undefined) delete process.env['FAKE_WORK_MS']
    else process.env['FAKE_WORK_MS'] = prevWork
    await rm(dir, { recursive: true, force: true })
  })

  const until = async (cond: () => boolean, ms = 8_000): Promise<void> => {
    const deadline = Date.now() + ms
    while (!cond() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10))
    expect(cond()).toBe(true)
  }

  it('beats while the process runs and stops once the run ends', async () => {
    const driver = createHermesDriver(
      OPTS,
      { homeDir: path.join(dir, 'home') },
      { heartbeatMs: 40 },
    )
    const seen: HermesNativeEvent[] = []
    driver.onEvent((ev) => seen.push(ev))
    await driver.start()
    await until(() => seen.some((e) => e.type === 'result'))

    const resultAt = seen.findIndex((e) => e.type === 'result')
    const beats = seen.slice(0, resultAt).filter((e) => e.type === 'status')
    expect(beats.length).toBeGreaterThanOrEqual(3)
    expect(seen[resultAt]).toMatchObject({ type: 'result', ok: true, summary: 'Done' })

    await new Promise((r) => setTimeout(r, 150))
    expect(seen.slice(resultAt + 1)).toEqual([])
  })

  it('stops beating when the run is aborted', async () => {
    process.env['FAKE_WORK_MS'] = '60000'
    const driver = createHermesDriver(
      OPTS,
      { homeDir: path.join(dir, 'home') },
      { heartbeatMs: 30 },
    )
    const seen: HermesNativeEvent[] = []
    driver.onEvent((ev) => seen.push(ev))
    await driver.start()
    await until(() => seen.some((e) => e.type === 'status'))
    await driver.abort()
    await until(() => seen.some((e) => e.type === 'result'))
    const after = seen.length
    await new Promise((r) => setTimeout(r, 120))
    expect(seen.length).toBe(after)
  })

  it('stops beating after its cap, so a hung run meets the silence limits', async () => {
    process.env['FAKE_WORK_MS'] = '60000'
    const driver = createHermesDriver(
      OPTS,
      { homeDir: path.join(dir, 'home') },
      { heartbeatMs: 20, heartbeatMaxMs: 120 },
    )
    const seen: HermesNativeEvent[] = []
    driver.onEvent((ev) => seen.push(ev))
    await driver.start()
    await until(() => seen.some((e) => e.type === 'status'))
    await new Promise((r) => setTimeout(r, 400))
    const beats = seen.filter((e) => e.type === 'status').length
    await new Promise((r) => setTimeout(r, 200))
    // Still running, but no longer beating.
    expect(seen.some((e) => e.type === 'result')).toBe(false)
    expect(seen.filter((e) => e.type === 'status').length).toBe(beats)
    await driver.abort()
    await until(() => seen.some((e) => e.type === 'result'))
  })

  it('maps a beat to a running status event, which the watchdogs count as activity', () => {
    let seq = 0
    const out = mapHermesEvent(
      { type: 'status', phase: 'running' },
      { runId: 'r1', sessionId: null },
      () => ++seq,
      () => 1,
    )
    expect(out).toEqual([
      { runId: 'r1', sessionId: null, ts: 1, seq: 1, kind: 'status', phase: 'running' },
    ])
  })
})
