// How a quiet `hermes chat -Q` run reads when it fails. hermes-agent 0.19.0, against a
// stand-in API that refuses every request as too long, gives its error as its reply: on
// stdout, after any startup banner, with only the session line on stderr. The pure
// function is tested for every way the output can come, CRLF included, because the
// driver tests cannot run on Windows. The driver test runs the REAL driver against a
// fake `hermes` executable that prints the captured output.

import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import type { HermesNativeEvent } from '@clawboo/adapter-hermes'
import { mapHermesEvent } from '@clawboo/adapter-hermes'
import { classifyError } from '@clawboo/obs'
import type { StartOpts } from '@clawboo/executor'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fakeBin = vi.hoisted(() => ({ path: '' }))
vi.mock('../../platform', async (importActual) => {
  const actual = await importActual<typeof import('../../platform')>()
  return { ...actual, resolveRuntimeBin: () => fakeBin.path }
})

const { createHermesDriver, hermesQuietFailure, withoutStartupBanner } =
  await import('../hermesDriver')
const { runFailureText } = await import('../../runFailureText')

const OPTS: StartOpts = { agentId: 'hm', sessionKey: 'agent:hm:team:t1', message: 'work' }

/** Captured stdout, banner and all. */
const CAPTURED_STDOUT =
  '  ⚠ tirith security scanner enabled but not available \u2014 command scanning will use pattern matching only\nContext length exceeded (15 tokens). Cannot compress further.\n'
const CAPTURED_STDERR = '\nsession_id: 20261105_011746_ea1bfa\n'
const GIVE_UP = 'Context length exceeded (15 tokens). Cannot compress further.'

describe('hermesQuietFailure', () => {
  const failure = (stdout: string, stderr: string, code: number | null = 1) =>
    hermesQuietFailure({ stdout, stderr, code })

  it('reads the captured overflow, past the banner and the session line', () => {
    expect(failure(CAPTURED_STDOUT, CAPTURED_STDERR)).toEqual({
      errorMessage: GIVE_UP,
      errorCode: 'context_overflow',
    })
  })

  it('reads it the same with CRLF line ends, as on Windows', () => {
    const crlf = (s: string): string => s.replace(/\n/g, '\r\n')
    expect(failure(crlf(CAPTURED_STDOUT), crlf(CAPTURED_STDERR))).toEqual({
      errorMessage: GIVE_UP,
      errorCode: 'context_overflow',
    })
    expect(failure('', crlf('Error: bad\n\nsession_id: s1\n')).errorMessage).toBe('Error: bad')
  })

  it('finds a give-up on stdout even when stderr has other lines', () => {
    const result = failure(GIVE_UP, 'WARNING something unrelated\nsession_id: s1\n')
    expect(result).toEqual({ errorMessage: GIVE_UP, errorCode: 'context_overflow' })
  })

  it('a stray error line on stderr does not hide its own failure reply', () => {
    const reply = 'API call failed after 3 retries: HTTP 401: User not found.'
    const result = failure(reply, 'Error: a plugin failed to load\nsession_id: s1\n')
    expect(result).toEqual({ errorMessage: reply })
    expect(classifyError(result.errorCode, result.errorMessage)).toBe('Auth')
  })

  it('reads the cause from stderr and the reply together', () => {
    const result = failure(
      'HTTP 401: Incorrect API key provided.\n',
      "[ERROR] x: Non-retryable client error: Error code: 401 - {'error': {'message': 'Incorrect API key provided', 'code': 'invalid_api_key'}}\nsession_id: s1\n",
    )
    expect(result.errorMessage).toBe('HTTP 401: Incorrect API key provided.')
    expect(result.errorCode).toBe('invalid_api_key')
  })

  it("types a provider's overflow given as the reply, and not a rate limit in those words", () => {
    const line = "HTTP 400: This model's maximum context length is 8192 tokens."
    expect(failure(line, CAPTURED_STDERR)).toEqual({
      errorMessage: line,
      errorCode: 'context_overflow',
    })
    const limited = failure('HTTP 429: too many tokens\n', CAPTURED_STDERR)
    expect(limited.errorCode).toBeUndefined()
    expect(classifyError(limited.errorCode, limited.errorMessage)).toBe('RateLimited')
    expect(runFailureText(limited.errorMessage, 'hermes')).toBe(
      'The run failed: HTTP 429: too many tokens',
    )
  })

  it('reads the overflow with compression turned off', () => {
    const line =
      'Context overflow and auto-compaction is disabled (compression.enabled: false). Run /compress to compact manually, /new to start fresh, or switch to a larger-context model.'
    expect(failure(line, CAPTURED_STDERR).errorCode).toBe('context_overflow')
  })

  it('gives the exit code for a banner and nothing else', () => {
    const banner = '  ⚠ tirith security scanner enabled but not available\n'
    expect(failure(banner, '\nsession_id: s1\n')).toEqual({
      errorMessage: 'hermes exited with code 1',
    })
  })

  it("never takes the model's own words as the cause", () => {
    const reply =
      'I hit a 401 from the billing API and your quota looks exhausted.\nLet me know what to do.\n'
    const result = failure(reply, '\nsession_id: s1\n', 1)
    expect(result).toEqual({ errorMessage: 'hermes exited with code 1' })
    expect(classifyError(result.errorCode, result.errorMessage)).not.toBe('Auth')
    expect(classifyError(result.errorCode, result.errorMessage)).not.toBe('Billing')
    // Nor a reply that merely quotes the words mid-sentence.
    expect(failure('The log said context length exceeded, oddly.\n', '').errorCode).toBeUndefined()
  })

  it("gives Hermes's own error when that is its reply", () => {
    const line = 'API call failed after 3 retries: HTTP 401: User not found.'
    const result = failure(line, '\nsession_id: s1\n')
    expect(result).toEqual({ errorMessage: line })
    expect(classifyError(result.errorCode, result.errorMessage)).toBe('Auth')
  })

  it('reads stderr first, with its provider code, as before', () => {
    const result = failure(
      'a reply\n',
      "Error: Error code: 401 - {'error': {'message': 'Incorrect API key', 'type': 'invalid_request_error', 'code': 'invalid_api_key'}}\n\nsession_id: s1\n",
    )
    expect(result.errorCode).toBe('invalid_api_key')
    expect(result.errorMessage).toContain('Incorrect API key')
    expect(result.errorMessage).not.toContain('session_id')
  })

  it('keeps any other stderr as the reason when it has nothing better', () => {
    expect(failure('', 'Traceback: boom\n\nsession_id: s1\n')).toEqual({
      errorMessage: 'Traceback: boom',
    })
  })

  it('falls back to the exit code when it printed nothing at all', () => {
    expect(failure('', '', 3)).toEqual({ errorMessage: 'hermes exited with code 3' })
  })
})

describe.skipIf(process.platform === 'win32')('createHermesDriver: a failed run', () => {
  let dir: string
  const SANDBOXED = ['HOME', 'CLAWBOO_HOME', 'HERMES_HOME'] as const
  const saved = new Map<string, string | undefined>()

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'clawboo-hermes-overflow-'))
    fakeBin.path = path.join(dir, 'hermes')
    for (const name of SANDBOXED) saved.set(name, process.env[name])
    // The home is seeded from ~/.hermes, and the spawn records its pid under the clawboo
    // dir: keep the real ones out of it.
    process.env['HOME'] = dir
    process.env['CLAWBOO_HOME'] = path.join(dir, '.clawboo')
    delete process.env['HERMES_HOME']
  })
  afterEach(async () => {
    for (const name of SANDBOXED) {
      const value = saved.get(name)
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    await rm(dir, { recursive: true, force: true })
  })

  async function eventsOf(
    stdout: string,
    stderr: string,
    code: number,
  ): Promise<HermesNativeEvent[]> {
    await writeFile(
      fakeBin.path,
      `#!/usr/bin/env node
process.stdout.write(${JSON.stringify(stdout)})
process.stderr.write(${JSON.stringify(stderr)})
process.exitCode = ${code}
`,
      'utf8',
    )
    await chmod(fakeBin.path, 0o755)
    const driver = createHermesDriver(OPTS, { homeDir: path.join(dir, 'home'), cwd: dir })
    const seen: HermesNativeEvent[] = []
    driver.onEvent((ev) => seen.push(ev))
    await driver.start()
    const deadline = Date.now() + 8_000
    while (!seen.some((e) => e.type === 'result') && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10))
    }
    return seen
  }

  async function resultOf(
    stdout: string,
    stderr: string,
    code: number,
  ): Promise<Extract<HermesNativeEvent, { type: 'result' }>> {
    const result = (await eventsOf(stdout, stderr, code)).find((e) => e.type === 'result')
    expect(result).toBeDefined()
    return result as Extract<HermesNativeEvent, { type: 'result' }>
  }

  const messagesIn = (events: HermesNativeEvent[]): string[] =>
    events.flatMap((e) => (e.type === 'message' ? [e.text] : []))

  it('types the captured overflow and keeps its session id', async () => {
    const result = await resultOf(CAPTURED_STDOUT, CAPTURED_STDERR, 1)
    expect(result.ok).toBe(false)
    expect(result.errorCode).toBe('context_overflow')
    expect(result.errorMessage).toBe(GIVE_UP)
    expect(result.sessionId).toBe('20261105_011746_ea1bfa')
    const [error] = mapHermesEvent(
      result,
      { runId: 'r', sessionId: null },
      () => 1,
      () => 0,
    )
    expect(error).toMatchObject({ kind: 'error', code: 'context_overflow', fatal: true })
  })

  it('a quiet reply does not carry the startup banner', async () => {
    const banner = CAPTURED_STDOUT.split('\n')[0]
    const events = await eventsOf(`${banner}\nThe parser is fixed.\n`, '\nsession_id: s4\n', 0)
    expect(messagesIn(events)).toEqual(['The parser is fixed.\n'])
    expect(events.find((e) => e.type === 'result')).toMatchObject({
      summary: 'The parser is fixed.',
    })
    // Nor does a run that printed the banner and nothing else claim it as its reply.
    const quiet = await eventsOf(`${banner}\n`, '\nsession_id: s5\n', 0)
    expect(messagesIn(quiet)).toEqual([])
    expect(quiet.find((e) => e.type === 'result')).toMatchObject({ summary: '' })
  })

  it('a reply that opens with its own warning about the scanner keeps it', async () => {
    const reply = '⚠ Tirith cannot scan this command safely.\nSo I did not run it.'
    const events = await eventsOf(`${reply}\n`, '\nsession_id: s6\n', 0)
    expect(messagesIn(events).join('')).toBe(`${reply}\n`)
    expect(events.find((e) => e.type === 'result')).toMatchObject({ summary: reply })
  })

  it('takes only the banner off the start of what a stopped run printed', () => {
    const banner = CAPTURED_STDOUT.split('\n')[0]!
    // The reply can quote the warning, and it has started by then.
    const stdout = `${banner}\nThe scanner said:\n${banner}\nSo it is off.\n`
    expect(withoutStartupBanner(stdout)).toBe(`The scanner said:\n${banner}\nSo it is off.\n`)
    expect(withoutStartupBanner(`${banner}\n`)).toBe('')
    expect(withoutStartupBanner('session_id: s7\n' + `${banner}\nDone.\n`)).toBe('Done.\n')
  })

  it('a successful run that happens to mention the words is untouched', async () => {
    const result = await resultOf(`${GIVE_UP}\n`, '\nsession_id: s3\n', 0)
    expect(result.ok).toBe(true)
    expect(result.errorCode).toBeUndefined()
  })
})
