// A Claude Code run used to be invisible to process tracking: the Agent SDK
// spawned the CLI itself and never exposed its pid, so an engine that died hard
// left the run going. The driver now supplies the process through the SDK's
// `spawnClaudeCodeProcess` hook. These pin that the CLI it spawns lands in the
// durable pid record, that its stderr is drained and still reaches an exit
// error, and that the driver actually hands the hook to the SDK.

import type { ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import type { ClaudeNativeEvent } from '@clawboo/adapter-claude-code'
import type { StartOpts } from '@clawboo/executor'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  createClaudeCodeDriver,
  createStderrTail,
  spawnTrackedClaudeProcess,
  withStderrTail,
  type SdkModule,
  type SdkSpawnOptions,
} from '../claudeCodeDriver'
import {
  __resetRuntimePidRecordForTests,
  runtimePidDir,
  startRuntimePidRecord,
} from '../runtimePidFile'
import type { RuntimeRunContext } from '../types'

const OPTS: StartOpts = { agentId: 'a1', sessionKey: 'agent:a1:team:t1', message: 'write the post' }
const CTX = { cwd: null, model: null, apiKeyEnv: {} } as unknown as RuntimeRunContext

let home: string
let prevClawbooHome: string | undefined

beforeEach(() => {
  home = mkdtempSync(path.join(os.tmpdir(), 'clawboo-claude-spawn-'))
  prevClawbooHome = process.env['CLAWBOO_HOME']
  process.env['CLAWBOO_HOME'] = home
  __resetRuntimePidRecordForTests()
  startRuntimePidRecord()
})

afterEach(() => {
  __resetRuntimePidRecordForTests()
  if (prevClawbooHome === undefined) delete process.env['CLAWBOO_HOME']
  else process.env['CLAWBOO_HOME'] = prevClawbooHome
  rmSync(home, { recursive: true, force: true })
})

/** Every pid in the durable record right now. */
function recordedPids(): number[] {
  if (!existsSync(runtimePidDir())) return []
  return readdirSync(runtimePidDir())
    .filter((n) => n.endsWith('.json'))
    .flatMap(
      (n) =>
        (
          JSON.parse(readFileSync(path.join(runtimePidDir(), n), 'utf8')) as {
            children: { pid: number }[]
          }
        ).children,
    )
    .map((c) => c.pid)
}

const closed = (child: ChildProcess): Promise<void> =>
  new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve()
    else child.once('close', () => resolve())
  })

describe('spawnTrackedClaudeProcess', () => {
  it('records the CLI while it runs, forgets it on exit, and drains its stderr', async () => {
    let stderr = ''
    const child = spawnTrackedClaudeProcess(
      {
        command: process.execPath,
        args: ['-e', "process.stderr.write('warming up'); setTimeout(() => {}, 200)"],
        env: { ...process.env },
      },
      (chunk) => {
        stderr += chunk
      },
    )
    expect(recordedPids()).toEqual([child.pid])

    await closed(child)
    expect(stderr).toBe('warming up')
    expect(recordedPids()).toEqual([])
  })

  it("stops the CLI on the SDK's forwarded abort, as the SDK's own spawn does", async () => {
    const abort = new AbortController()
    const child = spawnTrackedClaudeProcess(
      {
        command: process.execPath,
        args: ['-e', 'setInterval(() => {}, 1e9)'],
        env: { ...process.env },
        signal: abort.signal,
      },
      () => {},
    )
    // Node reports an aborted spawn as an 'error'; the SDK listens for it.
    child.on('error', () => {})
    abort.abort()
    await closed(child)
    expect(child.signalCode).toBe('SIGTERM')
    expect(recordedPids()).toEqual([])
  })
})

describe('createClaudeCodeDriver: the CLI is spawned through the tracked hook', () => {
  it('hands the SDK its spawner and puts stderr back on an exit error', async () => {
    let recordedWhileRunning: number[] = []
    let spawnedPid: number | undefined
    const sdk: SdkModule = {
      query({ options }) {
        return {
          [Symbol.asyncIterator]: () => ({
            async next() {
              // What the SDK does with the hook: spawn through it, then fail the
              // query with its exit error, which carries no stderr for a process
              // the SDK did not spawn itself.
              const spawnFn = options?.['spawnClaudeCodeProcess'] as
                ((o: SdkSpawnOptions) => ChildProcess) | undefined
              if (!spawnFn) throw new Error('no spawnClaudeCodeProcess option')
              const child = spawnFn({
                command: process.execPath,
                args: [
                  '-e',
                  "process.stderr.write('Invalid API key sk-ant-abcdefghijklmnopqrst'); process.exit(1)",
                ],
                env: { ...process.env },
              })
              spawnedPid = child.pid
              recordedWhileRunning = recordedPids()
              await closed(child)
              throw new Error('Claude Code process exited with code 1')
            },
          }),
        }
      },
    }
    const driver = createClaudeCodeDriver(OPTS, CTX, { loadSdk: async () => sdk })
    const seen: ClaudeNativeEvent[] = []
    driver.onEvent((ev) => seen.push(ev))
    await driver.start()
    for (let i = 0; i < 200 && !seen.some((e) => e.type === 'result'); i++) {
      await new Promise((r) => setTimeout(r, 10))
    }

    expect(recordedWhileRunning).toEqual([spawnedPid])
    expect(recordedPids()).toEqual([])
    // The key in the stderr is masked, as the SDK masks its own tail.
    expect(seen.find((e) => e.type === 'result')).toMatchObject({
      ok: false,
      errorMessage: 'Claude Code process exited with code 1. stderr: Invalid API key ••••',
    })
  })

  it('does not show part of a key the 2048-character cut fell inside', async () => {
    // Only the last 2048 characters are kept. The cut lands 20 characters before
    // the end of the key, where the redaction can no longer recognise it.
    const key = 'sk-ant-' + 'Q7'.repeat(30)
    const last = 'Invalid API key\n'
    const filler = 'y'.repeat(2048 - 21 - last.length - 1) + '\n'
    const stderr = 'x'.repeat(500) + ' ' + key + '\n' + filler + last
    const sdk: SdkModule = {
      query({ options }) {
        return {
          [Symbol.asyncIterator]: () => ({
            async next() {
              const spawnFn = options?.['spawnClaudeCodeProcess'] as
                ((o: SdkSpawnOptions) => ChildProcess) | undefined
              if (!spawnFn) throw new Error('no spawnClaudeCodeProcess option')
              const child = spawnFn({
                command: process.execPath,
                args: ['-e', 'process.stderr.write(process.env.STDERR_TEXT); process.exitCode = 1'],
                env: { ...process.env, STDERR_TEXT: stderr },
              })
              await closed(child)
              throw new Error('Claude Code process exited with code 1')
            },
          }),
        }
      },
    }
    const driver = createClaudeCodeDriver(OPTS, CTX, { loadSdk: async () => sdk })
    const seen: ClaudeNativeEvent[] = []
    driver.onEvent((ev) => seen.push(ev))
    await driver.start()
    for (let i = 0; i < 200 && !seen.some((e) => e.type === 'result'); i++) {
      await new Promise((r) => setTimeout(r, 10))
    }

    const result = seen.find((e) => e.type === 'result') as { errorMessage?: string } | undefined
    expect(result?.errorMessage).toContain('stderr: ')
    expect(result?.errorMessage).toContain('Invalid API key')
    expect(result?.errorMessage).not.toContain('Q7Q7')
  })
})

describe('createStderrTail', () => {
  it('keeps everything while it fits', () => {
    const tail = createStderrTail(32)
    tail.push('one\n')
    tail.push('two\n')
    expect(tail.text).toBe('one\ntwo\n')
  })

  it('drops the line the cut falls inside and keeps the lines after it', () => {
    const tail = createStderrTail(16)
    tail.push('token sk-ant-abcdefgh\nshort\nlast\n')
    expect(tail.text).toBe('short\nlast\n')
  })

  it('keeps a line that starts exactly at the cut', () => {
    const tail = createStderrTail(10)
    tail.push('0123456789\n0123456789')
    expect(tail.text).toBe('0123456789')
  })

  it('drops the rest of a cut line that arrives in later chunks', () => {
    const tail = createStderrTail(16)
    tail.push('key sk-ant-abcdefghijklmnop')
    expect(tail.text).toBe('')
    tail.push('qrstuvwxyz')
    expect(tail.text).toBe('')
    tail.push('0123\nnext line\n')
    expect(tail.text).toBe('next line\n')
  })

  it('keeps a key whole when it is split across chunks but not cut', () => {
    const tail = createStderrTail(64)
    tail.push('Invalid API key sk-ant-abcd')
    tail.push('efghijklmnop\n')
    expect(tail.text).toBe('Invalid API key sk-ant-abcdefghijklmnop\n')
  })
})

describe('withStderrTail', () => {
  it('appends the tail to a process exit or signal error', () => {
    expect(withStderrTail('Claude Code process exited with code 1', ' bad flag \n')).toBe(
      'Claude Code process exited with code 1. stderr: bad flag',
    )
    expect(withStderrTail('Claude Code process terminated by signal SIGKILL', 'oom')).toBe(
      'Claude Code process terminated by signal SIGKILL. stderr: oom',
    )
  })

  it('leaves every other message alone', () => {
    // Not an exit error: stderr is noise there.
    expect(withStderrTail('Claude Code returned an error result', 'noise')).toBe(
      'Claude Code returned an error result',
    )
    // Already carries one (the SDK spawned it after all).
    expect(withStderrTail('Claude Code process exited with code 1. stderr: a', 'b')).toBe(
      'Claude Code process exited with code 1. stderr: a',
    )
    // Nothing to add.
    expect(withStderrTail('Claude Code process exited with code 1', '  ')).toBe(
      'Claude Code process exited with code 1',
    )
  })
})
