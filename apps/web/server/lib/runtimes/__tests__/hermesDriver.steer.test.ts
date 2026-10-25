// Steering a Hermes run is interrupt-and-resume: one-shot `hermes chat -q` takes
// no input once started, so the driver stops the process and resumes the SAME
// session in the SAME home with the steer as the next input, all inside one run.
// The stopped process must never surface a terminal (that is what would read as a
// failure or a user Stop upstream). This drives the REAL driver against a fake
// `hermes` executable that behaves like hermes-agent 0.15.2: a SIGTERM'd `-q` run
// exits without printing its session line; a resumed run prints its reply and the
// session line on stderr.

import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import type { HermesNativeEvent } from '@clawboo/adapter-hermes'
import type { StartOpts } from '@clawboo/executor'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { RuntimeRunContext } from '../types'

const fakeBin = vi.hoisted(() => ({ path: '' }))
vi.mock('../../platform', async (importActual) => {
  const actual = await importActual<typeof import('../../platform')>()
  return { ...actual, resolveRuntimeBin: () => fakeBin.path }
})

const { createHermesDriver } = await import('../hermesDriver')

const FAKE_HERMES = `#!/usr/bin/env node
const fs = require('node:fs')
const args = process.argv.slice(2)
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ args, home: process.env.HERMES_HOME }) + '\\n')
const resumed = args.some((a) => a.includes('Your run was paused'))
if (resumed || process.env.FAKE_MODE === 'quick') {
  process.stdout.write(resumed ? 'Steered reply\\n' : 'Quick reply\\n')
  process.stderr.write('\\nsession_id: sess-9\\n')
  process.exit(0)
}
// A long tool call: work until stopped. Like hermes -q, a SIGTERM ends the run
// without the session line.
process.on('SIGTERM', () => process.exit(130))
setInterval(() => {}, 1000)
`

const OPTS: StartOpts = {
  agentId: 'hm',
  sessionKey: 'agent:hm:team:t1',
  message: 'write the report',
}

describe.skipIf(process.platform === 'win32')(
  'createHermesDriver: steering by interrupt-and-resume',
  () => {
    let dir: string
    let home: string
    let logPath: string
    let prev: { log?: string; mode?: string }

    beforeEach(async () => {
      dir = await mkdtemp(path.join(os.tmpdir(), 'clawboo-hermes-steer-'))
      home = path.join(dir, 'home')
      logPath = path.join(dir, 'calls.jsonl')
      fakeBin.path = path.join(dir, 'hermes')
      await writeFile(fakeBin.path, FAKE_HERMES, 'utf8')
      await chmod(fakeBin.path, 0o755)
      await writeFile(logPath, '', 'utf8')
      prev = { log: process.env['FAKE_LOG'], mode: process.env['FAKE_MODE'] }
      process.env['FAKE_LOG'] = logPath
      delete process.env['FAKE_MODE']
    })
    afterEach(async () => {
      if (prev.log === undefined) delete process.env['FAKE_LOG']
      else process.env['FAKE_LOG'] = prev.log
      if (prev.mode === undefined) delete process.env['FAKE_MODE']
      else process.env['FAKE_MODE'] = prev.mode
      await rm(dir, { recursive: true, force: true })
    })

    async function calls(): Promise<Array<{ args: string[]; home: string }>> {
      return (await readFile(logPath, 'utf8'))
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as { args: string[]; home: string })
    }

    async function until(cond: () => boolean | Promise<boolean>, ms = 8_000): Promise<void> {
      const deadline = Date.now() + ms
      while (!(await cond()) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20))
      expect(await cond()).toBe(true)
    }

    function start(ctx: RuntimeRunContext = { homeDir: home }): {
      driver: ReturnType<typeof createHermesDriver>
      seen: HermesNativeEvent[]
    } {
      const driver = createHermesDriver(OPTS, ctx)
      const seen: HermesNativeEvent[] = []
      driver.onEvent((ev) => seen.push(ev))
      return { driver, seen }
    }

    it('stops the run and resumes the same session with the steer, as ONE run', async () => {
      const { driver, seen } = start()
      await driver.start()
      await until(async () => (await calls()).length === 1)

      await expect(driver.steer!('Keep it to one page.')).resolves.toBe(true)
      await until(() => seen.some((e) => e.type === 'result'))
      await new Promise((r) => setTimeout(r, 100))

      // The stopped process produced no terminal: exactly one, from the resumed run.
      const results = seen.filter((e) => e.type === 'result')
      expect(results).toEqual([
        expect.objectContaining({
          type: 'result',
          ok: true,
          summary: 'Steered reply',
          sessionId: 'sess-9',
        }),
      ])
      const [first, resumed] = await calls()
      expect(first!.args).not.toContain('--continue')
      // Same home, the newest session in it, the steer as the next input.
      expect(resumed!.home).toBe(first!.home)
      expect(resumed!.args).toContain('--continue')
      const prompt = resumed!.args[resumed!.args.indexOf('-q') + 1]!
      expect(prompt).toContain('Keep it to one page.')
      expect(prompt).toContain('Your run was paused')
      // The headless flags carry over.
      expect(resumed!.args).toEqual(expect.arrayContaining(['-Q', '--yolo', '--accept-hooks']))
    })

    it('resumes by id when the run already knows its session', async () => {
      const { driver, seen } = start({ homeDir: home, resume: 'sess-known' })
      await driver.start()
      await until(async () => (await calls()).length === 1)
      await expect(driver.steer!('Also cite sources.')).resolves.toBe(true)
      await until(() => seen.some((e) => e.type === 'result'))
      const resumed = (await calls())[1]!
      expect(resumed.args).toEqual(expect.arrayContaining(['--resume', 'sess-known']))
      expect(resumed.args).not.toContain('--continue')
    })

    it('steers that arrive together ride one resume', async () => {
      const { driver, seen } = start()
      await driver.start()
      await until(async () => (await calls()).length === 1)
      const a = driver.steer!('First note.')
      const b = driver.steer!('Second note.')
      await expect(Promise.all([a, b])).resolves.toEqual([true, true])
      await until(() => seen.some((e) => e.type === 'result'))
      const all = await calls()
      expect(all).toHaveLength(2)
      const prompt = all[1]!.args[all[1]!.args.indexOf('-q') + 1]!
      expect(prompt).toContain('First note.')
      expect(prompt).toContain('Second note.')
    })

    it('refuses a steer once the run has finished', async () => {
      process.env['FAKE_MODE'] = 'quick'
      const { driver, seen } = start()
      await driver.start()
      await until(() => seen.some((e) => e.type === 'result'))
      await expect(driver.steer!('late')).resolves.toBe(false)
      expect(await calls()).toHaveLength(1)
    })

    it('an abort after a steer still ends the run as aborted, never as a failure', async () => {
      const { driver, seen } = start()
      await driver.start()
      await until(async () => (await calls()).length === 1)
      const steering = driver.steer!('x')
      await driver.abort()
      await steering.catch(() => false)
      await until(() => seen.some((e) => e.type === 'result'))
      const results = seen.filter((e) => e.type === 'result')
      expect(results).toHaveLength(1)
      // Whichever way the race goes, the run reads as stopped (or as the resumed
      // run's success), never as a failure.
      const r = results[0] as { ok: boolean; aborted?: boolean }
      expect(r.aborted === true || r.ok).toBe(true)
      expect(r).not.toHaveProperty('errorMessage')
    })
  },
)
