// The Codex driver hosts a run in `codex app-server` so a person can steer it
// with `turn/steer`. These tests drive the REAL driver against a small fake
// app-server (a node script speaking the same newline-delimited JSON-RPC, with the
// message shapes captured from a live Codex run), so they pin the driver's side:
// the handshake and thread/turn setup, translating notifications into the adapter's
// native events, the steer request, answering server requests, abort, and falling
// back to `exec` when there is no app-server at all.

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import type { CodexDriver, CodexNativeEvent } from '@clawboo/adapter-codex'
import type { StartOpts } from '@clawboo/executor'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createCodexAppServerDriver } from '../codexAppServerDriver'
import type { RuntimeRunContext } from '../types'

const FAKE_SERVER = String.raw`
const fs = require('node:fs')
const scenario = process.env.FAKE_SCENARIO
const logPath = process.env.FAKE_LOG
const log = (m) => fs.appendFileSync(logPath, JSON.stringify(m) + '\n')
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n')
const notify = (method, params) => send({ method, params })
if (scenario === 'no-app-server') {
  process.stderr.write("error: unrecognized subcommand 'app-server'\n")
  process.exit(2)
}
process.on('SIGTERM', () => process.exit(143))
let buf = ''
let threadId = 'th-1'
let steerText = null
const finishTurn = () => {
  notify('item/completed', { threadId, turnId: 'turn-1', item: { type: 'commandExecution', id: 'c1', command: 'sleep 1', cwd: '/w', status: 'completed', exitCode: 0, aggregatedOutput: 'done\n' } })
  notify('thread/tokenUsage/updated', { threadId, turnId: 'turn-1', tokenUsage: {
    total: { totalTokens: 0, inputTokens: 1120, cachedInputTokens: 20, outputTokens: 230, reasoningOutputTokens: 0 },
    last: { totalTokens: 0, inputTokens: 100, cachedInputTokens: 20, outputTokens: 25, reasoningOutputTokens: 0 } } })
  if (steerText) notify('item/started', { threadId, turnId: 'turn-1', item: { type: 'userMessage', id: 'u2', content: [{ type: 'text', text: steerText }] } })
  const final = steerText ? 'Steered: ' + steerText : 'All done.'
  notify('item/started', { threadId, turnId: 'turn-1', item: { type: 'agentMessage', id: 'm2', text: '' } })
  notify('item/agentMessage/delta', { threadId, turnId: 'turn-1', itemId: 'm2', delta: final })
  notify('item/completed', { threadId, turnId: 'turn-1', item: { type: 'agentMessage', id: 'm2', text: final } })
  notify('thread/tokenUsage/updated', { threadId, turnId: 'turn-1', tokenUsage: {
    total: { totalTokens: 0, inputTokens: 1300, cachedInputTokens: 40, outputTokens: 260, reasoningOutputTokens: 0 },
    last: { totalTokens: 0, inputTokens: 180, cachedInputTokens: 20, outputTokens: 30, reasoningOutputTokens: 0 } } })
  notify('turn/completed', { threadId, turn: { id: 'turn-1', status: 'completed', error: null, items: [] } })
}
process.stdin.on('data', (d) => {
  buf += d.toString()
  let nl
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl)
    buf = buf.slice(nl + 1)
    if (!line.trim()) continue
    const m = JSON.parse(line)
    log(m)
    if (m.method === 'initialize') send({ id: m.id, result: { userAgent: 'fake' } })
    else if (m.method === 'thread/start') send({ id: m.id, result: { thread: { id: threadId }, model: 'gpt-fake' } })
    else if (m.method === 'thread/resume') {
      if (scenario === 'resume-fails') send({ id: m.id, error: { code: -32600, message: 'no rollout found for thread id ' + m.params.threadId } })
      else { threadId = m.params.threadId; send({ id: m.id, result: { thread: { id: threadId }, model: 'gpt-fake' } }) }
    } else if (m.method === 'turn/start') {
      send({ id: m.id, result: { turn: { id: 'turn-1', status: 'inProgress', items: [] } } })
      notify('turn/started', { threadId, turn: { id: 'turn-1', status: 'inProgress', items: [] } })
      notify('item/started', { threadId, turnId: 'turn-1', item: { type: 'agentMessage', id: 'm1', text: '' } })
      notify('item/agentMessage/delta', { threadId, turnId: 'turn-1', itemId: 'm1', delta: 'Running.' })
      notify('item/completed', { threadId, turnId: 'turn-1', item: { type: 'agentMessage', id: 'm1', text: 'Running.' } })
      notify('item/started', { threadId, turnId: 'turn-1', item: { type: 'commandExecution', id: 'c1', command: 'sleep 1', cwd: '/w', status: 'inProgress' } })
      // A request nobody headless can answer: the driver must refuse it.
      send({ id: 'srv-1', method: 'item/commandExecution/requestApproval', params: { itemId: 'c1' } })
      if (scenario === 'plain') finishTurn()
    } else if (m.method === 'turn/steer') {
      if (m.params.expectedTurnId !== 'turn-1') send({ id: m.id, error: { code: -32600, message: 'turn mismatch' } })
      else {
        steerText = m.params.input[0].text
        send({ id: m.id, result: { turnId: 'turn-1' } })
        finishTurn()
      }
    }
  }
})
`

const OPTS: StartOpts = { agentId: 'cx', sessionKey: 'agent:cx:team:t1', message: 'run the build' }

describe('createCodexAppServerDriver', () => {
  let dir: string
  let serverPath: string
  let logPath: string
  let prevScenario: string | undefined
  let prevLog: string | undefined

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'clawboo-codex-appserver-'))
    serverPath = path.join(dir, 'fake-app-server.cjs')
    logPath = path.join(dir, 'received.jsonl')
    await writeFile(serverPath, FAKE_SERVER, 'utf8')
    await writeFile(logPath, '', 'utf8')
    prevScenario = process.env['FAKE_SCENARIO']
    prevLog = process.env['FAKE_LOG']
    process.env['FAKE_LOG'] = logPath
  })
  afterEach(async () => {
    if (prevScenario === undefined) delete process.env['FAKE_SCENARIO']
    else process.env['FAKE_SCENARIO'] = prevScenario
    if (prevLog === undefined) delete process.env['FAKE_LOG']
    else process.env['FAKE_LOG'] = prevLog
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })

  function driverFor(
    scenario: string,
    ctx: RuntimeRunContext = {},
    fallback?: () => CodexDriver,
  ): { driver: CodexDriver; seen: CodexNativeEvent[] } {
    process.env['FAKE_SCENARIO'] = scenario
    const driver = createCodexAppServerDriver(OPTS, ctx, {
      prepareHome: async () => ({ codexHome: dir, managed: false }),
      fallback:
        fallback ??
        (() => {
          throw new Error('fallback not expected')
        }),
      command: process.execPath,
      args: [serverPath],
      handshakeTimeoutMs: 5_000,
    })
    const seen: CodexNativeEvent[] = []
    driver.onEvent((ev) => seen.push(ev))
    return { driver, seen }
  }

  async function until(cond: () => boolean, ms = 5_000): Promise<void> {
    const deadline = Date.now() + ms
    while (!cond() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10))
    expect(cond()).toBe(true)
  }

  async function received(): Promise<Array<Record<string, unknown>>> {
    const text = await readFile(logPath, 'utf8')
    return text
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>)
  }

  it('runs one turn headless and maps it to the adapter’s native events', async () => {
    const { driver, seen } = driverFor('plain', { cwd: dir })
    await driver.start()
    await until(() => seen.some((e) => e.type === 'result'))

    expect(seen[0]).toEqual({ type: 'thread', threadId: 'th-1', model: 'gpt-fake' })
    expect(seen).toContainEqual({
      type: 'tool-call',
      id: 'c1',
      name: 'shell',
      input: { command: 'sleep 1', cwd: '/w' },
    })
    expect(seen).toContainEqual({
      type: 'tool-result',
      id: 'c1',
      name: 'shell',
      output: 'done\n',
      isError: false,
    })
    const text = seen
      .filter((e) => e.type === 'text')
      .map((e) => (e as { text: string }).text)
      .join('')
    // The second message starts on its own paragraph.
    expect(text).toBe('Running.\n\nAll done.')
    const results = seen.filter((e) => e.type === 'result')
    expect(results).toHaveLength(1)
    // The run's own tokens: the thread's earlier usage (total minus the first
    // request's `last`) is subtracted.
    expect(results[0]).toMatchObject({
      ok: true,
      summary: 'All done.',
      threadId: 'th-1',
      model: 'gpt-fake',
      usage: { inputTokens: 280, outputTokens: 55, cachedInputTokens: 40 },
    })

    const msgs = await received()
    expect(msgs.find((m) => m['method'] === 'thread/start')?.['params']).toMatchObject({
      cwd: dir,
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
    })
    // The approval request was refused, not left hanging.
    expect(msgs).toContainEqual(
      expect.objectContaining({ id: 'srv-1', error: expect.objectContaining({ code: -32601 }) }),
    )
  })

  it('steers the in-progress turn with turn/steer, inside the same run', async () => {
    const { driver, seen } = driverFor('steer')
    await driver.start()
    await until(() => seen.some((e) => e.type === 'tool-call'))
    await expect(driver.steer!('Lead with the pricing change.')).resolves.toBe(true)
    await until(() => seen.some((e) => e.type === 'result'))

    const steer = (await received()).find((m) => m['method'] === 'turn/steer')
    expect(steer?.['params']).toEqual({
      threadId: 'th-1',
      expectedTurnId: 'turn-1',
      input: [{ type: 'text', text: 'Lead with the pricing change.' }],
    })
    const results = seen.filter((e) => e.type === 'result')
    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({
      ok: true,
      summary: 'Steered: Lead with the pricing change.',
    })
  })

  it('resumes a prior thread when handed one (leader continuity)', async () => {
    const { driver, seen } = driverFor('plain', { resume: 'th-earlier' })
    await driver.start()
    await until(() => seen.some((e) => e.type === 'result'))
    expect(seen[0]).toMatchObject({ type: 'thread', threadId: 'th-earlier' })
    expect((await received()).some((m) => m['method'] === 'thread/start')).toBe(false)
  })

  it('fails the run when the prior thread cannot be resumed', async () => {
    const { driver, seen } = driverFor('resume-fails', { resume: 'th-gone' })
    await driver.start()
    await until(() => seen.some((e) => e.type === 'result'))
    expect(seen.find((e) => e.type === 'result')).toMatchObject({
      ok: false,
      errorMessage: expect.stringContaining('no rollout found'),
    })
  })

  it('refuses a steer once the run has finished', async () => {
    const { driver, seen } = driverFor('plain')
    await driver.start()
    await until(() => seen.some((e) => e.type === 'result'))
    await expect(driver.steer!('late')).resolves.toBe(false)
  })

  it('reports an abort as a clean aborted terminal', async () => {
    const { driver, seen } = driverFor('steer')
    await driver.start()
    await until(() => seen.some((e) => e.type === 'tool-call'))
    await driver.abort()
    await until(() => seen.some((e) => e.type === 'result'))
    const results = seen.filter((e) => e.type === 'result')
    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({ ok: true, aborted: true })
  })

  it('falls back to `codex exec` when there is no app-server, with one terminal', async () => {
    const fallbackEvents: Array<(ev: CodexNativeEvent) => void> = []
    let fellBack = false
    const fallback = (): CodexDriver => ({
      async start() {
        fellBack = true
        for (const h of fallbackEvents) h({ type: 'result', ok: true, summary: 'from exec' })
      },
      onEvent(h) {
        fallbackEvents.push(h)
        return () => undefined
      },
      async abort() {},
      async setModel() {},
      async writeContext() {},
    })
    const { driver, seen } = driverFor('no-app-server', {}, fallback)
    await driver.start()
    await until(() => seen.some((e) => e.type === 'result'))
    await new Promise((r) => setTimeout(r, 50))
    expect(fellBack).toBe(true)
    expect(seen.filter((e) => e.type === 'result')).toEqual([
      { type: 'result', ok: true, summary: 'from exec' },
    ])
    await expect(driver.steer!('x')).rejects.toThrow(/no app-server/)
  })

  it('a refused home ends the run before anything is spawned', async () => {
    process.env['FAKE_SCENARIO'] = 'plain'
    const driver = createCodexAppServerDriver(
      OPTS,
      {},
      {
        prepareHome: async () => {
          throw new Error('no Codex credentials provisioned for managed home /x')
        },
        fallback: () => {
          throw new Error('fallback not expected')
        },
        command: process.execPath,
        args: [serverPath],
      },
    )
    const seen: CodexNativeEvent[] = []
    driver.onEvent((ev) => seen.push(ev))
    await driver.start()
    expect(seen).toEqual([
      expect.objectContaining({
        type: 'result',
        ok: false,
        errorMessage: expect.stringMatching(/no Codex credentials provisioned/),
      }),
    ])
    expect(await received()).toEqual([])
  })
})
