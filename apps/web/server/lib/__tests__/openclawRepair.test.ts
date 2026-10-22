// Reading why a Gateway launch failed, and running `openclaw doctor --fix` when
// that is what OpenClaw asks for. The log lines are captured from OpenClaw
// 2026.9.2 starting on a workspace an older OpenClaw had set up.

import { EventEmitter } from 'node:events'

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../cwdGuard', () => ({ liveCwd: () => '/live/dir' }))
vi.mock('../platform', () => ({ isWindows: false }))
const killState = vi.hoisted(() => ({ killed: 0 }))
vi.mock('../runtimes/killTree', () => ({
  killProcessTree: () => {
    killState.killed++
  },
}))

import { gatewayFailureReason, needsDoctorFix, runDoctorFix } from '../openclawRepair'

const E = '\x1b'
const MIGRATION_LOG = [
  `${E}[90m2026-10-21T23:05:00.327-04:00${E}[39m ${E}[36m[gateway]${E}[39m ${E}[36mstarting...${E}[39m`,
  `${E}[90m2026-10-21T23:05:00.831-04:00${E}[39m ${E}[36m[gateway]${E}[39m ${E}[33mauth token was missing. Generated a runtime token for this startup without changing config.${E}[39m`,
  '2026-10-21T23:05:01.011-04:00 Gateway failed to start: Legacy workspace setup state requires migration for /Users/ada/.openclaw/workspace; run openclaw doctor --fix.. Run openclaw gateway status --deep for diagnostics.',
  '',
].join('\n')

// What the OpenClaw CLI printed when Clawboo started it from a deleted directory.
const DELETED_CWD_LOG =
  '[openclaw] Could not start the CLI. Reason: ENOENT: process.cwd failed with error no such file or directory, the current working directory was likely removed without changing the working directory, uv_cwd\n'

describe('gatewayFailureReason', () => {
  it('reads the reason from the failure line, without the diagnostics pointer', () => {
    expect(gatewayFailureReason(MIGRATION_LOG)).toBe(
      'Legacy workspace setup state requires migration for /Users/ada/.openclaw/workspace; run openclaw doctor --fix.',
    )
  })

  it('reads a CLI that could not start', () => {
    expect(gatewayFailureReason(DELETED_CWD_LOG)).toMatch(/^ENOENT: process.cwd failed/)
  })

  it('takes the latest failure when the log holds more than one', () => {
    const log = `Gateway failed to start: first\nGateway failed to start: second\n`
    expect(gatewayFailureReason(log)).toBe('second')
  })

  it('is null for a launch that stated no failure', () => {
    expect(gatewayFailureReason('[gateway] starting...\n[gateway] listening on 18789\n')).toBeNull()
  })
})

describe('needsDoctorFix', () => {
  it('is true for the migration failure', () => {
    expect(needsDoctorFix(MIGRATION_LOG)).toBe(true)
  })

  it('ignores a passing mention of doctor when the failure is something else', () => {
    const log = [
      '[gateway] tip: run openclaw doctor --fix to tidy plugin state',
      'Gateway failed to start: EADDRINUSE: address already in use 127.0.0.1:18789',
    ].join('\n')
    expect(needsDoctorFix(log)).toBe(false)
  })

  it('is false for a CLI that could not start', () => {
    expect(needsDoctorFix(DELETED_CWD_LOG)).toBe(false)
  })
})

class FakeChild extends EventEmitter {
  stdout = new EventEmitter()
  stderr = new EventEmitter()
}

describe('runDoctorFix', () => {
  let calls: { cmd: string; args: string[]; opts: Record<string, unknown> }[]
  let child: FakeChild
  const fakeSpawn = ((cmd: string, args: string[], opts: Record<string, unknown>) => {
    calls.push({ cmd, args, opts })
    return child
  }) as unknown as typeof import('node:child_process').spawn

  beforeEach(() => {
    calls = []
    child = new FakeChild()
    killState.killed = 0
  })

  it('runs the unattended repair and leaves Gateway services alone', async () => {
    const lines: string[] = []
    const done = runDoctorFix('/bin/openclaw', (l) => lines.push(l), { spawn: fakeSpawn })
    child.stdout.emit(
      'data',
      Buffer.from(
        '│\n◇  Legacy state detected ──╮\n│  - Workspace setup: legacy files → shared SQLite state  │\n',
      ),
    )
    child.emit('close', 0)
    expect(await done).toEqual({ ok: true, code: 0 })

    expect(calls).toHaveLength(1)
    const { cmd, args, opts } = calls[0]!
    expect(cmd).toBe('/bin/openclaw')
    expect(args).toEqual(['doctor', '--fix', '--non-interactive'])
    expect(opts['cwd']).toBe('/live/dir')
    expect(opts['stdio']).toEqual(['ignore', 'pipe', 'pipe'])
    expect((opts['env'] as NodeJS.ProcessEnv)['OPENCLAW_SERVICE_REPAIR_POLICY']).toBe('external')
    // Box-only lines are dropped; lines with text are kept.
    expect(lines).toEqual([
      '◇  Legacy state detected ──╮',
      '│  - Workspace setup: legacy files → shared SQLite state  │',
    ])
  })

  it('reports the last thing doctor said when it fails', async () => {
    const done = runDoctorFix('/bin/openclaw', () => {}, { spawn: fakeSpawn })
    child.stderr.emit(
      'data',
      Buffer.from('│  Config write blocked: openclaw.json is read-only  │\n'),
    )
    child.emit('close', 1)
    expect(await done).toEqual({
      ok: false,
      code: 1,
      error: 'Config write blocked: openclaw.json is read-only',
    })
  })

  it('stops a doctor that never finishes', async () => {
    vi.useFakeTimers()
    try {
      const done = runDoctorFix('/bin/openclaw', () => {}, { spawn: fakeSpawn, timeoutMs: 1000 })
      vi.advanceTimersByTime(1000)
      expect(await done).toEqual({
        ok: false,
        code: null,
        error: 'openclaw doctor --fix did not finish in time',
      })
      expect(killState.killed).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('resolves rather than throws when it cannot be started', async () => {
    const throwing = (() => {
      throw new Error('spawn EINVAL')
    }) as unknown as typeof import('node:child_process').spawn
    expect(await runDoctorFix('/bin/openclaw', () => {}, { spawn: throwing })).toEqual({
      ok: false,
      code: null,
      error: 'spawn EINVAL',
    })
  })
})
