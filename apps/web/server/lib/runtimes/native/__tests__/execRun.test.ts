// Running a real command, with real processes.
//
// These spawn actual children rather than mocking `spawn`, because every defect
// worth catching here lives in the parts a mock replaces: whether the tail of the
// output survives, whether a killed child leaves grandchildren behind, and
// whether a chatty command that SUCCEEDED is reported as a failure.

import { mkdtemp, realpath, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { OUTPUT_CAP_BYTES, runApprovedCommand } from '../execRun'

/**
 * POSIX ONLY, because the thing under test is POSIX only.
 *
 * `buildExecTool` returns nothing on Windows, so this runner is never reached
 * there. The commands below are also POSIX (`seq`, `printenv`, `pwd`, `/tmp`),
 * and making them portable would be dressing up coverage for a code path that
 * does not exist on that platform. The absence is asserted in execTool.test.ts,
 * where it belongs.
 */
const describePosix = describe.skipIf(process.platform === 'win32')

const never = () => new AbortController().signal
const run = (argv: string[], over: Partial<Parameters<typeof runApprovedCommand>[0]> = {}) =>
  runApprovedCommand({ argv, cwd: process.cwd(), signal: never(), ...over })

describePosix('runApprovedCommand', () => {
  it('returns output and a zero exit for an ordinary command', async () => {
    const res = await run(['echo', 'hello'])
    expect(res.output.trim()).toBe('hello')
    expect(res.exitCode).toBe(0)
    expect(res.truncated).toBe(false)
  })

  it('treats a non-zero exit as a RESULT, not an error', async () => {
    // The model needs the output either way, and a failing command is ordinary.
    const res = await run(['ls', '/definitely/not/here'])
    expect(res.exitCode).not.toBe(0)
    expect(res.output.length).toBeGreaterThan(0)
  })

  it('merges stderr into the output in arrival order', async () => {
    const res = await run(['ls', '/definitely/not/here'])
    expect(res.output).toMatch(/no such file|not found|cannot access/i)
  })

  it('keeps the whole output of a command that writes a lot before exiting', async () => {
    // NOTE ON WHAT THIS DOES NOT PROVE. The implementation settles on `close`
    // rather than `exit` because `exit` can fire while stdio is still draining.
    // Swapping it back to `exit` does NOT fail this test: for output this size
    // the pipes have already drained by the time the process ends, so the race
    // never opens. The `close` choice stands on Node's contract and on
    // killTree.ts's own note about the same distinction, not on this assertion.
    const res = await run(['seq', '1', '2000'])
    expect(res.exitCode).toBe(0)
    expect(res.output.trimEnd().endsWith('2000')).toBe(true)
  })

  it('TRUNCATES a chatty command instead of killing it', async () => {
    // `execFile` would kill the child at its 1MB maxBuffer and reject, so a
    // command that succeeded would be reported as having failed. That is the
    // single most confusing outcome for someone who just approved it.
    //
    // The command KEEPS RUNNING after it passes the cap, which is what makes
    // this sensitive: a version that killed the child at the cap would come back
    // with a signal instead of a clean exit. A `seq` alone finishes too fast for
    // the kill to land and would pass either way.
    const res = await run(['bash', '-c', 'seq 1 400000; sleep 2'], { timeoutMs: 20_000 })
    expect(res.truncated).toBe(true)
    expect(Buffer.byteLength(res.output, 'utf8')).toBeLessThanOrEqual(OUTPUT_CAP_BYTES)
    expect(res.exitCode).toBe(0)
    expect(res.signal).toBeNull()
    expect(res.stoppedBy).toBeUndefined()
  })

  it('keeps the HEAD of a chunk that straddles the cap, and lets it finish', async () => {
    // This path is unreachable at the real cap: a pipe hands over 64KB chunks and
    // the cap is 64KB, so the straddling comparison lands exactly equal and the
    // partial-keep branch never runs. A small cap is the only way to exercise it.
    //
    // The command KEEPS RUNNING after it straddles, which is what makes the
    // second assertion real: with a plain `echo` the process is already gone, so
    // a version that killed the child here would look identical.
    const res = await run(['bash', '-c', 'echo abcdefghij; sleep 1'], {
      capBytes: 4,
      timeoutMs: 20_000,
    })
    expect(res.truncated).toBe(true)
    expect(res.output).toBe('abcd')
    expect(res.exitCode).toBe(0)
    expect(res.signal).toBeNull()
  })

  it('kills a command that runs past its timeout', async () => {
    const started = Date.now()
    const res = await run(['sleep', '30'], { timeoutMs: 300 })
    expect(res.stoppedBy).toBe('timeout')
    expect(Date.now() - started).toBeLessThan(10_000)
  })

  it('kills a command when the RUN is stopped', async () => {
    // Without the abort seam threaded into local tools, this child would outlive
    // the Stop, the budget kill switch and the drain guard.
    const controller = new AbortController()
    const p = run(['sleep', '30'], { signal: controller.signal })
    setTimeout(() => controller.abort(), 150)
    const res = await p
    expect(res.stoppedBy).toBe('abort')
  })

  it('stops a command whose run was already aborted before the spawn', async () => {
    const controller = new AbortController()
    controller.abort()
    const res = await run(['sleep', '30'], { signal: controller.signal })
    expect(res.stoppedBy).toBe('abort')
  })

  it('rejects only when the program cannot be started at all', async () => {
    await expect(run(['this-program-does-not-exist-xyz'])).rejects.toThrow()
  })

  it('runs in the directory it was given, not the server’s', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'clawboo-exec-'))
    try {
      const res = await run(['pwd'], { cwd: dir })
      // realpath: macOS reports /private/var for /var, so comparing the raw
      // string would fail for a reason that has nothing to do with cwd.
      expect(await realpath(res.output.trim())).toBe(await realpath(dir))
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('hands the child an ALLOWLISTED environment, not the server’s', async () => {
    // A SENTINEL rather than a real key name. Asserting on ANTHROPIC_API_KEY
    // proved nothing here, because the test runner does not have one set: the
    // assertion passed just as happily against a version that forwarded the whole
    // of `process.env`. Planting a variable guarantees there is something to leak.
    const sentinel = '__CLAWBOO_ENV_LEAK_PROBE'
    process.env[sentinel] = 'must-not-reach-the-child'
    try {
      // No `env` override: this exercises the real default, connectorChildEnv().
      const res = await run(['printenv'])
      expect(res.output).not.toContain(sentinel)
      expect(res.output).not.toContain('must-not-reach-the-child')
      // And it is not simply empty: the allowlist does pass PATH through.
      expect(res.output).toMatch(/PATH=/)
    } finally {
      delete process.env[sentinel]
    }
  })

  it('does not re-parse the argv through a shell', async () => {
    // `shell: true` would make these operators, which is the property this whole
    // tier exists to refuse. As argv items they are literal text.
    const res = await run(['echo', 'a && b | c > d'])
    expect(res.output.trim()).toBe('a && b | c > d')
  })
})
