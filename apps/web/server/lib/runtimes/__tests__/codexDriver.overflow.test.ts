// How a `codex exec` run reports the end of its context window. Exec's JSON carries no
// typed cause, so the driver reads the failed turn's own reason. This drives the REAL
// exec driver against a fake `codex` executable that prints what codex-cli 0.136 prints
// against a stand-in Responses API.

import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import type { CodexNativeEvent } from '@clawboo/adapter-codex'
import { mapCodexEvent } from '@clawboo/adapter-codex'
import { isPolicyDenialCode } from '@clawboo/governance'
import { classifyError } from '@clawboo/obs'
import type { StartOpts } from '@clawboo/executor'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fakeBin = vi.hoisted(() => ({ path: '' }))
vi.mock('../../platform', async (importActual) => {
  const actual = await importActual<typeof import('../../platform')>()
  return { ...actual, resolveRuntimeBin: () => fakeBin.path }
})

const { createCodexExecDriver } = await import('../codexDriver')
const { runFailureText } = await import('../../runFailureText')

const OPTS: StartOpts = { agentId: 'cx', sessionKey: 'agent:cx:team:t1', message: 'work' }

const OUT_OF_ROOM =
  "Codex ran out of room in the model's context window. Start a new thread or clear earlier history before retrying."

describe.skipIf(process.platform === 'win32')('createCodexExecDriver: a failed turn', () => {
  let dir: string
  const SANDBOXED = ['HOME', 'CLAWBOO_HOME', 'CODEX_HOME'] as const
  const saved = new Map<string, string | undefined>()

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'clawboo-codex-overflow-'))
    fakeBin.path = path.join(dir, 'codex')
    for (const name of SANDBOXED) saved.set(name, process.env[name])
    // The run home is seeded from ~/.codex, and the spawn records its pid under the
    // clawboo dir: keep the real ones out of it.
    process.env['HOME'] = dir
    process.env['CLAWBOO_HOME'] = path.join(dir, '.clawboo')
    delete process.env['CODEX_HOME']
  })
  afterEach(async () => {
    for (const name of SANDBOXED) {
      const value = saved.get(name)
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    await rm(dir, { recursive: true, force: true })
  })

  async function resultOf(
    lines: unknown[],
    stderr: string,
    code: number,
  ): Promise<Extract<CodexNativeEvent, { type: 'result' }>> {
    const stdout = lines.map((l) => `${JSON.stringify(l)}\n`).join('')
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
    const driver = createCodexExecDriver(OPTS, { cwd: dir, apiKeyEnv: { OPENAI_API_KEY: 'x' } })
    const seen: CodexNativeEvent[] = []
    driver.onEvent((ev) => seen.push(ev))
    await driver.start()
    const deadline = Date.now() + 8_000
    while (!seen.some((e) => e.type === 'result') && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10))
    }
    const result = seen.find((e) => e.type === 'result')
    expect(result).toBeDefined()
    return result as Extract<CodexNativeEvent, { type: 'result' }>
  }

  const failed = (message: string): unknown[] => [
    { type: 'thread.started', thread_id: 'th-1' },
    { type: 'turn.started' },
    { type: 'error', message },
    { type: 'turn.failed', error: { message } },
  ]

  it("types the CLI's own sentence for a full context window", async () => {
    const result = await resultOf(
      failed(OUT_OF_ROOM),
      'Reading additional input from stdin...\n',
      1,
    )
    expect(result.ok).toBe(false)
    expect(result.errorCode).toBe('context_overflow')
    expect(result.errorMessage).toBe(OUT_OF_ROOM)
    expect(result.threadId).toBe('th-1')
    const [error] = mapCodexEvent(
      result,
      { runId: 'r', sessionId: null },
      () => 1,
      () => 0,
    )
    expect(error).toMatchObject({ kind: 'error', code: 'context_overflow', fatal: true })
    expect(classifyError('context_overflow', result.errorMessage)).toBe('ContextOverflow')
    expect(isPolicyDenialCode(result.errorCode)).toBe(false)
  })

  it("types the backend's refusal the CLI forwards as a JSON string", async () => {
    const body = JSON.stringify({
      error: {
        message:
          'Your input exceeds the context window of this model. Please adjust your input and try again.',
        type: 'invalid_request_error',
        param: 'input',
        code: 'context_length_exceeded',
      },
    })
    const result = await resultOf(failed(body), '', 1)
    expect(result.errorCode).toBe('context_overflow')
    expect(result.errorMessage).toMatch(/^Your input exceeds the context window/)
  })

  it('leaves every other failure untyped, as before', async () => {
    const result = await resultOf(failed('stream disconnected before completion'), '', 1)
    expect(result.ok).toBe(false)
    expect(result.errorCode).toBeUndefined()
    expect(result.errorMessage).toBe('stream disconnected before completion')
  })

  it("types a rate limit in an overflow's words as a rate limit, and files and reads as one", async () => {
    const body = JSON.stringify({
      status: 429,
      error: { code: 'rate_limit_exceeded', message: 'too many tokens' },
    })
    const result = await resultOf(failed(body), '', 1)
    expect(result.errorCode).toBe('rate_limit')
    expect(result.errorMessage).toBe('Rate limit: too many tokens')
    expect(classifyError(result.errorCode, result.errorMessage)).toBe('RateLimited')
    expect(runFailureText(result.errorMessage, 'codex')).toBe(
      'The run failed: Rate limit: too many tokens',
    )
  })

  it('never reads the words from stderr, which is only the CLI log', async () => {
    const result = await resultOf(
      [{ type: 'thread.started', thread_id: 'th-1' }],
      'WARN compaction: Context window exceeded while compacting; removing oldest history item.\n',
      1,
    )
    expect(result.errorCode).toBeUndefined()
  })

  it('a turn that overflowed once and still finished is a success', async () => {
    const result = await resultOf(
      [
        { type: 'thread.started', thread_id: 'th-1' },
        { type: 'error', message: OUT_OF_ROOM },
      ],
      '',
      0,
    )
    expect(result.ok).toBe(true)
    expect(result.errorCode).toBeUndefined()
  })
})
