// The Hermes ACP driver hosts a run in `hermes acp` so it streams and takes a steer
// mid-turn. These tests drive the REAL driver against a small fake ACP agent (a
// node script speaking the same newline-delimited JSON-RPC, with the message shapes
// of Hermes's ACP server), so they pin the driver's side: the handshake and session
// setup, streamed updates into the adapter's native events, usage, a failed turn
// read from the missing usage, steering and its acknowledgements, a steer that came
// too late, cancel, resuming a session, and falling back when there is no ACP.

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import type { HermesDriver, HermesNativeEvent } from '@clawboo/adapter-hermes'
import type { StartOpts } from '@clawboo/executor'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  createHermesAcpDriver,
  hermesAcpFailure,
  hermesLateSteerPrompt,
  hermesPromptText,
  hermesToolName,
} from '../hermesAcpDriver'
import type { RuntimeRunContext } from '../types'

const FAKE_AGENT = String.raw`
const fs = require('node:fs')
const scenario = process.env.FAKE_SCENARIO
const logPath = process.env.FAKE_LOG
const log = (m) => fs.appendFileSync(logPath, JSON.stringify(m) + '\n')
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n')
const update = (sessionId, u) => send({ method: 'session/update', params: { sessionId, update: u } })
const text = (t) => ({ type: 'text', text: t })
const USAGE = { inputTokens: 120, outputTokens: 30, totalTokens: 150, cachedReadTokens: 20 }
if (scenario === 'no-acp') {
  process.stderr.write("ACP dependencies not installed.\nInstall them with:  pip install -e '.[acp]'\n")
  process.exit(1)
}
process.on('SIGTERM', () => process.exit(143))
let buf = ''
let mainPrompt = null
let sid = 's-1'
let permissionAnswered = null
const finishMain = (result) => { send({ id: mainPrompt, result }); mainPrompt = null }
process.stdin.on('data', (d) => {
  buf += d.toString()
  let nl
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl)
    buf = buf.slice(nl + 1)
    if (!line.trim()) continue
    const m = JSON.parse(line)
    log(m)
    if (m.id === 'perm-1' && permissionAnswered) { permissionAnswered(m.result); continue }
    if (m.method === 'initialize') send({ id: m.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } })
    else if (m.method === 'session/new') {
      if (scenario === 'resume-missing') sid = 's-2'
      send({ id: m.id, result: { sessionId: sid } })
    } else if (m.method === 'session/load') {
      if (scenario === 'resume-missing') send({ id: m.id, error: { code: -32002, message: 'session not found' } })
      else {
        sid = m.params.sessionId
        // A loaded session replays its history before answering.
        update(sid, { sessionUpdate: 'agent_message_chunk', content: text('OLD HISTORY') })
        send({ id: m.id, result: {} })
      }
    } else if (m.method === 'session/set_mode' || m.method === 'session/set_model') send({ id: m.id, result: {} })
    else if (m.method === 'session/cancel') {
      if (mainPrompt !== null) finishMain({ stopReason: 'cancelled' })
    } else if (m.method === 'session/prompt') {
      const t = m.params.prompt[0].text
      if (t.startsWith('/steer ')) {
        update(sid, { sessionUpdate: 'agent_message_chunk', content: text('⏩ Steer queued for the active turn: ' + t.slice(7)) })
        send({ id: m.id, result: { stopReason: 'end_turn' } })
        if (scenario === 'steer') {
          update(sid, { sessionUpdate: 'tool_call_update', toolCallId: 'tc-1', status: 'completed', rawOutput: 'built' })
          update(sid, { sessionUpdate: 'agent_message_chunk', content: text('Steered.') })
          finishMain({ stopReason: 'end_turn', usage: USAGE })
        } else if (scenario === 'late-steer') {
          update(sid, { sessionUpdate: 'agent_message_chunk', content: text(' Done.') })
          finishMain({ stopReason: 'end_turn', usage: USAGE })
        }
        continue
      }
      if (mainPrompt === null && scenario === 'late-steer' && t.includes('while you were finishing')) {
        update(sid, { sessionUpdate: 'agent_message_chunk', content: text('Took it in.') })
        send({ id: m.id, result: { stopReason: 'end_turn', usage: { ...USAGE, inputTokens: 200 } } })
        continue
      }
      mainPrompt = m.id
      if (scenario === 'plain' || scenario === 'resume' || scenario === 'resume-missing') {
        update(sid, { sessionUpdate: 'agent_thought_chunk', content: text('thinking') })
        update(sid, { sessionUpdate: 'tool_call', toolCallId: 'tc-1', title: 'terminal: ls -la', kind: 'execute', status: 'pending', rawInput: { command: 'ls -la' } })
        update(sid, { sessionUpdate: 'tool_call_update', toolCallId: 'tc-1', status: 'completed', rawOutput: 'a\nb' })
        update(sid, { sessionUpdate: 'agent_message_chunk', content: text('All ') })
        update(sid, { sessionUpdate: 'agent_message_chunk', content: text('done.') })
        update(sid, { sessionUpdate: 'usage_update', size: 200000, used: 900 })
        finishMain({ stopReason: 'end_turn', usage: USAGE })
      } else if (scenario === 'permission') {
        update(sid, { sessionUpdate: 'tool_call', toolCallId: 'tc-1', title: 'write_file: a.txt', kind: 'edit', status: 'pending' })
        permissionAnswered = (r) => {
          log({ permission: r })
          update(sid, { sessionUpdate: 'tool_call_update', toolCallId: 'tc-1', status: 'completed', content: [{ type: 'diff', path: 'a.txt', oldText: '', newText: 'x' }] })
          finishMain({ stopReason: 'end_turn', usage: USAGE })
        }
        send({ id: 'perm-1', method: 'session/request_permission', params: { sessionId: sid, toolCall: { toolCallId: 'tc-1' }, options: [ { optionId: 'deny', kind: 'reject_once', name: 'Deny' }, { optionId: 'allow', kind: 'allow_once', name: 'Allow once' } ] } })
      } else if (scenario === 'fs-request') {
        send({ id: 'fs-1', method: 'fs/read_text_file', params: { sessionId: sid, path: '/etc/hosts' } })
        update(sid, { sessionUpdate: 'agent_message_chunk', content: text('ok') })
        finishMain({ stopReason: 'end_turn', usage: USAGE })
      } else if (scenario === 'failed') {
        process.stderr.write("2026-11-02 21:00:00 [INFO] run_agent: starting turn\n")
        process.stderr.write("2026-11-02 21:00:01 [ERROR] agent.conversation_loop: Non-retryable client error: Error code: 401 - {'error': {'message': 'Incorrect API key provided', 'type': 'invalid_request_error', 'code': 'invalid_api_key'}}\n")
        process.stderr.write("❌ Non-retryable client error (HTTP 401). Aborting.\n")
        setTimeout(() => finishMain({ stopReason: 'end_turn' }), 20)
      } else if (scenario === 'failed-live') {
        // Captured from hermes-agent 0.19.0 with a refused OpenRouter key: the
        // error streams as text, and the turn ends end_turn with no usage.
        process.stderr.write("⚠️  API call failed (attempt 1/3): AuthenticationError [HTTP 401]\n   📝 Error: HTTP 401: User not found.\n")
        process.stderr.write("❌ Non-retryable error (HTTP 401): HTTP 401: User not found.\n❌ Non-retryable client error (HTTP 401). Aborting.\n")
        process.stderr.write("2026-11-02 21:44:13 [ERROR] agent.conversation_loop: Non-retryable client error: Error code: 401 - {'error': {'message': 'User not found.', 'code': 401}}\n")
        setTimeout(() => {
          update(sid, { sessionUpdate: 'agent_message_chunk', content: text('HTTP 401: User not found.') })
          update(sid, { sessionUpdate: 'usage_update', size: 128000, used: 12601 })
          finishMain({ stopReason: 'end_turn' })
        }, 20)
      } else if (scenario === 'steer') {
        update(sid, { sessionUpdate: 'tool_call', toolCallId: 'tc-1', title: 'terminal: npm run build', kind: 'execute', status: 'in_progress' })
      } else if (scenario === 'late-steer') {
        update(sid, { sessionUpdate: 'agent_message_chunk', content: text('Writing the answer.') })
      } else if (scenario === 'refusal') {
        finishMain({ stopReason: 'refusal' })
      } else if (scenario === 'exit-mid-turn') {
        process.stderr.write('Traceback (most recent call last):\nRuntimeError: Error: the model backend crashed\n')
        setTimeout(() => process.exit(2), 20)
      }
      // 'cancel': the turn runs until session/cancel arrives.
    }
  }
})
`

const OPTS: StartOpts = {
  agentId: 'hermes-1',
  sessionKey: 'runtime:hermes:task:t1',
  message: 'do the task',
}

describe('createHermesAcpDriver', () => {
  let dir: string
  let agentPath: string
  let logPath: string
  const saved: Record<string, string | undefined> = {}

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'clawboo-hermes-acp-'))
    agentPath = path.join(dir, 'fake-acp-agent.cjs')
    logPath = path.join(dir, 'received.jsonl')
    await writeFile(agentPath, FAKE_AGENT, 'utf8')
    await writeFile(logPath, '', 'utf8')
    for (const k of ['FAKE_SCENARIO', 'FAKE_LOG', 'HOME', 'HERMES_HOME']) saved[k] = process.env[k]
    process.env['FAKE_LOG'] = logPath
    // The home is seeded from ~/.hermes; keep the real one out of it.
    process.env['HOME'] = dir
    delete process.env['HERMES_HOME']
  })
  afterEach(async () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })

  function ctxFor(extra: Partial<RuntimeRunContext> = {}): RuntimeRunContext {
    return {
      homeDir: path.join(dir, 'home'),
      cwd: dir,
      apiKeyEnv: { OPENROUTER_API_KEY: 'sk-or-test' },
      ...extra,
    } as RuntimeRunContext
  }

  function driverFor(
    scenario: string,
    ctx: RuntimeRunContext = ctxFor(),
    fallback?: () => HermesDriver,
    onAcpUnavailable?: (reason: string) => void,
    opts: StartOpts = OPTS,
  ): { driver: HermesDriver; seen: HermesNativeEvent[] } {
    process.env['FAKE_SCENARIO'] = scenario
    const driver = createHermesAcpDriver(opts, ctx, {
      fallback:
        fallback ??
        (() => {
          throw new Error('fallback not expected')
        }),
      command: process.execPath,
      args: [agentPath],
      handshakeTimeoutMs: 5_000,
      cancelGraceMs: 1_000,
      ...(onAcpUnavailable ? { onAcpUnavailable } : {}),
    })
    const seen: HermesNativeEvent[] = []
    driver.onEvent((ev) => seen.push(ev))
    return { driver, seen }
  }

  async function until(cond: () => boolean, ms = 5_000): Promise<void> {
    const end = Date.now() + ms
    while (!cond()) {
      if (Date.now() > end) throw new Error('timed out waiting')
      await new Promise((r) => setTimeout(r, 10))
    }
  }

  async function untilReceived(method: string, ms = 5_000): Promise<void> {
    const end = Date.now() + ms
    while (!(await received()).some((m) => m['method'] === method)) {
      if (Date.now() > end) throw new Error(`timed out waiting for ${method}`)
      await new Promise((r) => setTimeout(r, 10))
    }
  }

  async function received(): Promise<Array<Record<string, unknown>>> {
    const raw = await readFile(logPath, 'utf8')
    return raw
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>)
  }

  const resultOf = (seen: HermesNativeEvent[]) =>
    seen.find((e) => e.type === 'result') as Extract<HermesNativeEvent, { type: 'result' }>

  it('runs one turn: streams reasoning, the tool call and text, and reports usage', async () => {
    const { driver, seen } = driverFor('plain')
    await driver.start()
    await until(() => seen.some((e) => e.type === 'result'))
    expect(seen.filter((e) => e.type !== 'result')).toEqual([
      { type: 'session', sessionId: 's-1', model: 'openai/gpt-4o-mini' },
      { type: 'message', text: 'thinking', channel: 'reasoning' },
      { type: 'tool-call', id: 'tc-1', name: 'terminal', input: { command: 'ls -la' } },
      { type: 'tool-result', id: 'tc-1', name: 'terminal', output: 'a\nb', isError: false },
      { type: 'message', text: 'All ' },
      { type: 'message', text: 'done.' },
    ])
    expect(resultOf(seen)).toEqual({
      type: 'result',
      ok: true,
      summary: 'All done.',
      usage: { inputTokens: 120, outputTokens: 30, cachedInputTokens: 20 },
      sessionId: 's-1',
      model: 'openai/gpt-4o-mini',
    })
    const msgs = await received()
    const init = msgs.find((m) => m['method'] === 'initialize')
    expect(init?.['params']).toMatchObject({
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    })
    // The home's config.yaml carries clawboo's servers, so none are declared here.
    expect(msgs.find((m) => m['method'] === 'session/new')?.['params']).toEqual({
      cwd: dir,
      mcpServers: [],
    })
    expect(msgs.find((m) => m['method'] === 'session/set_mode')?.['params']).toEqual({
      sessionId: 's-1',
      modeId: 'dont_ask',
    })
    // The provider the key implies, pinned together with its default model.
    expect(msgs.find((m) => m['method'] === 'session/set_model')?.['params']).toEqual({
      sessionId: 's-1',
      modelId: 'openrouter:openai/gpt-4o-mini',
    })
    expect(msgs.find((m) => m['method'] === 'session/prompt')?.['params']).toEqual({
      sessionId: 's-1',
      prompt: [{ type: 'text', text: 'do the task' }],
    })
  })

  it('reads a turn that reports no usage as failed, with the error Hermes logged', async () => {
    const { driver, seen } = driverFor('failed')
    await driver.start()
    await until(() => seen.some((e) => e.type === 'result'))
    const result = resultOf(seen)
    expect(result.ok).toBe(false)
    expect(result.errorMessage).toContain('Non-retryable client error (HTTP 401)')
    expect(result.errorMessage).not.toContain('[INFO]')
    // The provider's own cause, from the error body Hermes logged.
    expect(result.errorCode).toBe('invalid_api_key')
  })

  it('fails the refused-key turn exactly as Hermes 0.19.0 sends it', async () => {
    const { driver, seen } = driverFor('failed-live')
    await driver.start()
    await until(() => seen.some((e) => e.type === 'result'))
    const result = resultOf(seen)
    expect(result.ok).toBe(false)
    expect(result.errorMessage).toContain('Non-retryable client error (HTTP 401)')
    expect(result.errorMessage).toContain("Error code: 401 - {'error'")
  })

  it('answers a permission request with allow-once, as the quiet path runs with --yolo', async () => {
    const { driver, seen } = driverFor('permission')
    await driver.start()
    await until(() => seen.some((e) => e.type === 'result'))
    expect(resultOf(seen).ok).toBe(true)
    const answer = (await received()).find((m) => m['id'] === 'perm-1')
    expect(answer?.['result']).toEqual({ outcome: { outcome: 'selected', optionId: 'allow' } })
    // An edit reports the file it changed.
    expect(seen.find((e) => e.type === 'tool-result')).toMatchObject({
      name: 'write_file',
      output: 'edited a.txt',
    })
  })

  it('refuses the file-system requests it did not advertise, rather than leave them waiting', async () => {
    const { driver, seen } = driverFor('fs-request')
    await driver.start()
    await until(() => seen.some((e) => e.type === 'result'))
    const answer = (await received()).find((m) => m['id'] === 'fs-1')
    expect(answer?.['error']).toMatchObject({ code: -32601 })
  })

  it('steers a running turn with /steer, keeping the acknowledgement out of the output', async () => {
    const { driver, seen } = driverFor('steer')
    await driver.start()
    await until(() => seen.some((e) => e.type === 'tool-call'))
    await expect(driver.steer!('use the prod config')).resolves.toBe(true)
    await until(() => seen.some((e) => e.type === 'result'))
    const prompts = (await received()).filter((m) => m['method'] === 'session/prompt')
    expect(
      prompts.map((m) => (m['params'] as { prompt: Array<{ text: string }> }).prompt[0]!.text),
    ).toEqual(['do the task', '/steer use the prod config'])
    const texts = seen.flatMap((e) => (e.type === 'message' ? [e.text] : []))
    expect(texts).toEqual(['Steered.'])
    // A tool call was open when it arrived, so Hermes read it after the call: no
    // extra turn.
    expect(resultOf(seen)).toMatchObject({ ok: true, summary: 'Steered.' })
  })

  it('never sends a prompt or steer that Hermes would run as one of its slash commands', async () => {
    const { driver, seen } = driverFor('steer', ctxFor(), undefined, undefined, {
      ...OPTS,
      message: '/model some/cheaper-model',
    })
    await driver.start()
    await until(() => seen.some((e) => e.type === 'tool-call'))
    await expect(driver.steer!('/reset and start over')).resolves.toBe(true)
    await until(() => seen.some((e) => e.type === 'result'))
    const [first, steer] = (await received())
      .filter((m) => m['method'] === 'session/prompt')
      .map((m) => (m['params'] as { prompt: Array<{ text: string }> }).prompt[0]!.text)
    // Hermes trims, then treats a leading slash as a command.
    expect(first!.trim().startsWith('/')).toBe(false)
    expect(first).toContain('/model some/cheaper-model')
    expect(steer!.startsWith('/steer ')).toBe(true)
    const steerArg = steer!.slice('/steer '.length)
    expect(steerArg.trim().startsWith('/')).toBe(false)
    expect(steerArg).toContain('/reset and start over')
  })

  it('delivers a steer that came while Hermes wrote its final answer as one more turn', async () => {
    const { driver, seen } = driverFor('late-steer')
    await driver.start()
    await until(() => seen.some((e) => e.type === 'message'))
    await expect(driver.steer!('also add a summary')).resolves.toBe(true)
    await until(() => seen.some((e) => e.type === 'result'))
    const prompts = (await received()).filter((m) => m['method'] === 'session/prompt')
    expect(prompts).toHaveLength(3)
    const followUp = (prompts[2]!['params'] as { prompt: Array<{ text: string }> }).prompt[0]!.text
    expect(followUp).toContain('also add a summary')
    expect(resultOf(seen)).toMatchObject({
      ok: true,
      summary: 'Took it in.',
      usage: { inputTokens: 200, outputTokens: 30 },
    })
  })

  it('cancels a turn on abort, and the run ends aborted', async () => {
    const { driver, seen } = driverFor('cancel')
    await driver.start()
    await untilReceived('session/prompt')
    await driver.abort()
    await until(() => seen.some((e) => e.type === 'result'))
    expect(resultOf(seen)).toMatchObject({ ok: true, aborted: true })
    expect((await received()).some((m) => m['method'] === 'session/cancel')).toBe(true)
  })

  it("loads a known session without streaming its history as this run's output", async () => {
    const { driver, seen } = driverFor(
      'resume',
      ctxFor({ resume: 'old-1', homeDir: path.join(dir, 'home') }),
    )
    // A session resumes only into a home that already existed.
    await (
      await import('../hermesHome')
    ).provisionHermesHome(path.join(dir, 'home'), {
      mcpServers: null,
    })
    await driver.start()
    await until(() => seen.some((e) => e.type === 'result'))
    expect(seen.find((e) => e.type === 'session')).toMatchObject({ sessionId: 'old-1' })
    const texts = seen.flatMap((e) => (e.type === 'message' ? [e.text] : []))
    expect(texts).not.toContain('OLD HISTORY')
    expect(
      (await received()).find((m) => m['method'] === 'session/load')?.['params'],
    ).toMatchObject({
      sessionId: 'old-1',
    })
  })

  it('starts a fresh session when the one to resume is gone', async () => {
    await (
      await import('../hermesHome')
    ).provisionHermesHome(path.join(dir, 'home'), {
      mcpServers: null,
    })
    const { driver, seen } = driverFor('resume-missing', ctxFor({ resume: 'gone-1' }))
    await driver.start()
    await until(() => seen.some((e) => e.type === 'result'))
    expect(resultOf(seen)).toMatchObject({ ok: true, sessionId: 's-2' })
  })

  it('fails a turn Hermes refused', async () => {
    const { driver, seen } = driverFor('refusal')
    await driver.start()
    await until(() => seen.some((e) => e.type === 'result'))
    expect(resultOf(seen)).toMatchObject({
      ok: false,
      errorMessage: expect.stringContaining('refusal'),
    })
  })

  it('fails a run whose process exits mid-turn, with the error it printed', async () => {
    const { driver, seen } = driverFor('exit-mid-turn')
    await driver.start()
    await until(() => seen.some((e) => e.type === 'result'))
    expect(resultOf(seen)).toMatchObject({
      ok: false,
      errorMessage: expect.stringContaining('the model backend crashed'),
    })
  })

  it('falls back to the quiet path when this Hermes has no ACP mode', async () => {
    const reasons: string[] = []
    let quietStarted = false
    const quietHandlers: Array<(ev: HermesNativeEvent) => void> = []
    const quiet: HermesDriver = {
      async start() {
        quietStarted = true
        for (const h of quietHandlers) h({ type: 'result', ok: true, summary: 'quiet ran' })
      },
      onEvent(h) {
        quietHandlers.push(h)
        return () => undefined
      },
      async abort() {},
      async setModel() {},
      async writeContext() {},
    }
    const { driver, seen } = driverFor(
      'no-acp',
      ctxFor(),
      () => quiet,
      (r) => reasons.push(r),
    )
    await driver.start()
    await until(() => seen.some((e) => e.type === 'result'))
    expect(quietStarted).toBe(true)
    expect(resultOf(seen)).toMatchObject({ ok: true, summary: 'quiet ran' })
    expect(reasons.join(' ')).toContain('ACP dependencies not installed')
  })
})

describe('Hermes ACP helpers', () => {
  it('names the tool a Hermes title describes', () => {
    expect(hermesToolName('terminal: ls -la')).toBe('terminal')
    expect(hermesToolName('mcp_clawboo-tasks_update_task: done')).toBe(
      'mcp_clawboo-tasks_update_task',
    )
    expect(hermesToolName('todo')).toBe('todo')
    expect(hermesToolName('')).toBe('tool')
  })

  it('gives text that starts with a slash a lead line, and leaves other text alone', () => {
    expect(hermesPromptText('do the task')).toBe('do the task')
    expect(hermesPromptText('write it to /tmp/out')).toBe('write it to /tmp/out')
    // Python's str.strip() also drops \x1c to \x1f and \x85, which JavaScript's \s
    // does not match.
    for (const t of [
      '/model openai/gpt-4o',
      '  /reset',
      '\n/compact now',
      '\x1c/model cheap',
      '\x1f\x85/reset',
      ' /tools',
    ]) {
      const out = hermesPromptText(t)
      expect(out.trim().startsWith('/')).toBe(false)
      expect(out.endsWith(t)).toBe(true)
    }
  })

  it('starts a late-steer turn with its own sentence, never with the steer text', () => {
    const p = hermesLateSteerPrompt(['/model cheap', 'and add tests'])
    expect(p.trim().startsWith('/')).toBe(false)
    expect(p).toContain('/model cheap')
    expect(p).toContain('and add tests')
  })

  it('keeps only the error lines of what Hermes logged', () => {
    expect(
      hermesAcpFailure('[INFO] a: fine\n❌ Non-retryable error (HTTP 402)\n[INFO] b: more\n'),
    ).toBe('❌ Non-retryable error (HTTP 402)')
    expect(hermesAcpFailure('[INFO] nothing wrong')).toBe('Hermes ended the turn without a result.')
  })
})
