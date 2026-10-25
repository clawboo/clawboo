// Codex driver over `codex app-server`: the run is hosted in Codex's JSON-RPC
// server (stdio) instead of one-shot `codex exec`, because only the app-server
// can take input mid-turn. `steer()` sends `turn/steer`, which adds the message to
// the in-progress turn without stopping it; Codex reads it at its next model call.
//
// One driver = one run = one app-server process: `initialize`, then `thread/start`
// (or `thread/resume` when the caller hands in a prior thread id, the leader
// continuity path), then ONE `turn/start`, then the process is shut down once that
// turn completes. The headless posture matches the `exec` path's
// `--dangerously-bypass-approvals-and-sandbox`: approval policy `never`, sandbox
// `danger-full-access` (the per-task worktree is the isolation boundary). Any
// request the server sends anyway is answered with an error, never left hanging.
//
// Notifications are translated into the same `CodexNativeEvent` union the `exec`
// path produces, so the adapter and its mapper are unchanged. A Codex without
// app-server (an old CLI) fails the handshake before any turn starts; the run then
// FALLS BACK to `codex exec` (injected), which simply cannot be steered.
//
// Verified live against Codex 0.158 (`turn/steer` accepted mid-command, the steer
// recorded as a `userMessage` item in the SAME turn, which then completed once);
// the protocol types match the 0.136 CLI's `app-server generate-ts` output.

import { spawn, type ChildProcess } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

import type { CodexDriver, CodexNativeEvent } from '@clawboo/adapter-codex'
import type { StartOpts, Usage } from '@clawboo/executor'

import { isWindows, resolveRuntimeBin } from '../platform'
import { buildChildEnv } from './childEnv'
import { killProcessTree } from './killTree'
import { registerRuntimeChild, unregisterRuntimeChild } from './subprocess'
import type { RuntimeRunContext } from './types'
import { resolveWindowsSpawn } from './winSpawn'

export interface CodexAppServerDeps {
  /** Make the run's CODEX_HOME ready (auth seed, MCP config) and name it. Throws
   *  to refuse the run (no usable credential). */
  prepareHome: () => Promise<{ codexHome: string; managed: boolean }>
  /** The `codex exec` driver to run instead when app-server can't be reached. */
  fallback: () => CodexDriver
  /** Test seam: the command that starts the app-server (default: `codex`). */
  command?: string
  /** Test seam: the args before `app-server` (e.g. a fake server script). */
  args?: string[]
  /** How long the handshake (initialize) may take before falling back. */
  handshakeTimeoutMs?: number
}

/** How long the `initialize` handshake may take before the run falls back. */
const HANDSHAKE_TIMEOUT_MS = 20_000

const asRecord = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' ? (v as Record<string, unknown>) : null
const asStr = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
const asNum = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

interface TokenBreakdown {
  inputTokens: number
  cachedInputTokens: number
  outputTokens: number
}

const breakdownOf = (v: unknown): TokenBreakdown => {
  const r = asRecord(v) ?? {}
  return {
    inputTokens: asNum(r['inputTokens']),
    cachedInputTokens: asNum(r['cachedInputTokens']),
    outputTokens: asNum(r['outputTokens']),
  }
}

/** One app-server thread item as a tool call, or null for a non-tool item. */
function toolCallOf(item: Record<string, unknown>): { name: string; input: unknown } | null {
  switch (item['type']) {
    case 'commandExecution':
      return { name: 'shell', input: { command: item['command'], cwd: item['cwd'] } }
    case 'mcpToolCall':
      // The bare tool name, as the `exec` path reports it: the engine keys
      // delegation on it (`team_delegate`).
      return { name: asStr(item['tool']) ?? 'mcp_tool', input: item['arguments'] ?? {} }
    case 'dynamicToolCall':
      return { name: asStr(item['tool']) ?? 'tool', input: item['arguments'] ?? {} }
    case 'fileChange':
      return { name: 'apply_patch', input: { changes: item['changes'] } }
    case 'webSearch':
      return { name: 'web_search', input: { query: item['query'] } }
    default:
      return null
  }
}

/** A completed tool item's output, and whether it failed. */
function toolResultOf(item: Record<string, unknown>): { output: string; isError: boolean } {
  const status = asStr(item['status'])
  const failed = status === 'failed' || status === 'declined'
  switch (item['type']) {
    case 'commandExecution': {
      const exit = item['exitCode']
      return {
        output: asStr(item['aggregatedOutput']) ?? '',
        isError: failed || (typeof exit === 'number' && exit !== 0),
      }
    }
    case 'mcpToolCall': {
      const err = asRecord(item['error'])
      if (err) return { output: asStr(err['message']) ?? 'tool failed', isError: true }
      return { output: JSON.stringify(item['result'] ?? null), isError: failed }
    }
    case 'fileChange': {
      const changes = Array.isArray(item['changes']) ? item['changes'] : []
      const paths = changes.map((c) => asStr(asRecord(c)?.['path']) ?? '').filter(Boolean)
      return { output: paths.join('\n'), isError: failed }
    }
    default:
      return { output: '', isError: failed }
  }
}

export function createCodexAppServerDriver(
  opts: StartOpts,
  ctx: RuntimeRunContext,
  deps: CodexAppServerDeps,
): CodexDriver {
  const handlers = new Set<(ev: CodexNativeEvent) => void>()
  const buffered: CodexNativeEvent[] = []
  let subscribed = false
  let started = false
  let finished = false
  let abortRequested = false
  let child: ChildProcess | null = null
  let fallback: CodexDriver | null = null
  /** `initialize` answered: from here on the run is app-server's to finish. */
  let handshaken = false
  let stderrTail = ''

  let threadId: string | null = null
  let model: string | undefined
  let turnId: string | null = null
  let resolveTurn: (id: string | null) => void = () => undefined
  const turnReady = new Promise<string | null>((resolve) => {
    resolveTurn = resolve
  })

  // What the run has produced so far.
  let lastAgentText = ''
  let lastError: string | null = null
  const agentTextItems = new Set<string>()
  let usageBaseline: TokenBreakdown | null = null
  let usageTotal: TokenBreakdown | null = null

  const push = (ev: CodexNativeEvent): void => {
    if (!subscribed) {
      buffered.push(ev)
      return
    }
    for (const h of [...handlers]) h(ev)
  }

  const runUsage = (): Usage | undefined => {
    if (!usageTotal) return undefined
    const base = usageBaseline ?? { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 }
    const u = {
      inputTokens: Math.max(0, usageTotal.inputTokens - base.inputTokens),
      outputTokens: Math.max(0, usageTotal.outputTokens - base.outputTokens),
      cachedInputTokens: Math.max(0, usageTotal.cachedInputTokens - base.cachedInputTokens),
    }
    return u.inputTokens || u.outputTokens ? u : undefined
  }

  /** The run's one terminal; the app-server is then shut down. */
  const finish = (result: Omit<Extract<CodexNativeEvent, { type: 'result' }>, 'type'>): void => {
    if (finished) return
    finished = true
    resolveTurn(null)
    const usage = runUsage()
    push({
      type: 'result',
      ...result,
      ...(usage ? { usage } : {}),
      ...(model ? { model } : {}),
      ...(threadId ? { threadId } : {}),
    })
    for (const [, p] of pending) p.reject(new Error('codex app-server run ended'))
    pending.clear()
    const c = child
    if (c) {
      c.stdin?.end()
      killProcessTree(c)
    }
  }

  // ─── JSON-RPC over stdio ────────────────────────────────────────────────────
  let nextId = 1
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()

  const write = (msg: Record<string, unknown>): void => {
    try {
      child?.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`)
    } catch {
      // A closed pipe surfaces as the process exit below.
    }
  }

  const request = <T>(method: string, params: unknown): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      if (finished || !child) {
        reject(new Error('codex app-server is not running'))
        return
      }
      const id = nextId++
      pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
      write({ id, method, params })
    })

  function onNotification(method: string, params: Record<string, unknown>): void {
    switch (method) {
      case 'item/agentMessage/delta': {
        const delta = asStr(params['delta'])
        const itemId = asStr(params['itemId']) ?? ''
        if (!delta) return
        // A later message in the same turn starts on its own paragraph.
        const prefix = !agentTextItems.has(itemId) && agentTextItems.size > 0 ? '\n\n' : ''
        agentTextItems.add(itemId)
        push({ type: 'text', text: prefix + delta })
        return
      }
      case 'item/reasoning/summaryTextDelta':
      case 'item/reasoning/textDelta': {
        const delta = asStr(params['delta'])
        if (delta) push({ type: 'text', text: delta, channel: 'reasoning' })
        return
      }
      case 'item/started': {
        const item = asRecord(params['item'])
        if (!item) return
        const call = toolCallOf(item)
        if (call) push({ type: 'tool-call', id: asStr(item['id']) ?? call.name, ...call })
        return
      }
      case 'item/completed': {
        const item = asRecord(params['item'])
        if (!item) return
        if (item['type'] === 'agentMessage') {
          const text = asStr(item['text']) ?? ''
          const itemId = asStr(item['id']) ?? ''
          // A message that streamed no deltas still reaches the stream.
          if (text && !agentTextItems.has(itemId)) {
            const prefix = agentTextItems.size > 0 ? '\n\n' : ''
            agentTextItems.add(itemId)
            push({ type: 'text', text: prefix + text })
          }
          if (text) lastAgentText = text
          return
        }
        const call = toolCallOf(item)
        if (call) {
          const result = toolResultOf(item)
          push({
            type: 'tool-result',
            id: asStr(item['id']) ?? call.name,
            name: call.name,
            ...result,
          })
        }
        return
      }
      case 'thread/tokenUsage/updated': {
        const usage = asRecord(params['tokenUsage'])
        if (!usage) return
        const total = breakdownOf(usage['total'])
        // Everything before this run's first request: the thread's earlier turns
        // (a resumed leader thread carries them). Subtracted, so the run reports
        // its own tokens only.
        if (!usageBaseline) {
          const last = breakdownOf(usage['last'])
          usageBaseline = {
            inputTokens: total.inputTokens - last.inputTokens,
            cachedInputTokens: total.cachedInputTokens - last.cachedInputTokens,
            outputTokens: total.outputTokens - last.outputTokens,
          }
        }
        usageTotal = total
        return
      }
      case 'error': {
        const err = asRecord(params['error'])
        if (params['willRetry'] !== true && err) lastError = asStr(err['message']) ?? lastError
        return
      }
      case 'turn/completed': {
        const turn = asRecord(params['turn']) ?? {}
        if (turnId && asStr(turn['id']) && turn['id'] !== turnId) return
        const status = asStr(turn['status'])
        if (status === 'completed') {
          finish({ ok: true, summary: lastAgentText })
        } else if (status === 'interrupted' && abortRequested) {
          finish({ ok: true, aborted: true, summary: lastAgentText })
        } else {
          const err = asRecord(turn['error'])
          finish({
            ok: false,
            summary: lastAgentText,
            errorMessage:
              asStr(err?.['message']) ?? lastError ?? `codex turn ended: ${status ?? 'unknown'}`,
          })
        }
        return
      }
      default:
        return
    }
  }

  function onLine(line: string): void {
    let msg: Record<string, unknown> | null
    try {
      msg = asRecord(JSON.parse(line))
    } catch {
      return
    }
    if (!msg) return
    const id = msg['id']
    const method = asStr(msg['method'])
    if (typeof id === 'number' && !method && pending.has(id)) {
      const p = pending.get(id)!
      pending.delete(id)
      const err = asRecord(msg['error'])
      if (err) p.reject(new Error(asStr(err['message']) ?? 'codex app-server error'))
      else p.resolve(msg['result'])
      return
    }
    if (method && id !== undefined && id !== null) {
      // A request from the server (an approval, an elicitation, a user-input
      // prompt). Nobody is there to answer it in a headless run: refuse it rather
      // than leave the turn waiting forever.
      write({ id, error: { code: -32601, message: 'clawboo runs Codex headless' } })
      return
    }
    if (method) onNotification(method, asRecord(msg['params']) ?? {})
  }

  /** Spawn the app-server. Returns false when it could not be started at all. */
  function spawnServer(codexHome: string): boolean {
    const command = deps.command ?? resolveRuntimeBin('codex') ?? 'codex'
    const args = [...(deps.args ?? []), 'app-server']
    let plan: ReturnType<typeof resolveWindowsSpawn>
    try {
      plan = resolveWindowsSpawn({ command, args })
    } catch {
      return false
    }
    let spawned: ChildProcess
    try {
      spawned = spawn(plan.command, plan.args, {
        cwd: ctx.cwd ?? undefined,
        env: buildChildEnv({ CODEX_HOME: codexHome, ...(ctx.apiKeyEnv ?? {}) }),
        shell: false,
        windowsHide: isWindows,
        detached: !isWindows,
        ...(plan.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    } catch {
      return false
    }
    child = spawned
    registerRuntimeChild(spawned)
    let buf = ''
    spawned.stdout?.on('data', (d: Buffer) => {
      buf += d.toString()
      let nl: number
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl)
        buf = buf.slice(nl + 1)
        if (line.trim()) onLine(line)
      }
    })
    spawned.stderr?.on('data', (d: Buffer) => {
      stderrTail = (stderrTail + d.toString()).slice(-4000)
    })
    spawned.stdin?.on('error', () => undefined)
    spawned.on('error', () => undefined)
    spawned.on('close', () => {
      unregisterRuntimeChild(spawned)
      for (const [, p] of pending) p.reject(new Error('codex app-server exited'))
      pending.clear()
      // Before the handshake, an exit is the handshake failing: the rejection
      // above sends the run to the `exec` fallback, which ends it.
      if (finished || fallback || !handshaken) return
      if (abortRequested) finish({ ok: true, aborted: true, summary: lastAgentText })
      else
        finish({
          ok: false,
          summary: lastAgentText,
          errorMessage:
            lastError ?? (stderrTail.trim() || 'codex app-server exited before the turn finished'),
        })
    })
    return true
  }

  /** Run `codex exec` instead (app-server unavailable). */
  async function fallBack(): Promise<void> {
    const c = child
    child = null
    if (c) killProcessTree(c)
    resolveTurn(null)
    if (finished) return
    fallback = deps.fallback()
    fallback.onEvent((ev) => {
      if (ev.type === 'result') {
        if (finished) return
        finished = true
      }
      push(ev)
    })
    if (abortRequested) {
      finished = true
      push({ type: 'result', ok: true, aborted: true, summary: '' })
      return
    }
    await fallback.start()
  }

  /** initialize → thread → turn, in the background once the process is up. */
  async function drive(): Promise<void> {
    // The handshake decides between app-server and the `exec` fallback: a CLI that
    // can't hold it never started a turn, so nothing is lost by switching.
    let handshake: boolean
    try {
      await Promise.race([
        request('initialize', {
          clientInfo: { name: 'clawboo', title: 'clawboo', version: '0.0.0' },
          capabilities: null,
        }),
        new Promise((_, reject) => {
          const timer = setTimeout(
            () => reject(new Error('codex app-server handshake timed out')),
            deps.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS,
          )
          ;(timer as { unref?: () => void }).unref?.()
        }),
      ])
      handshake = true
      handshaken = true
    } catch {
      handshake = false
    }
    if (!handshake) {
      if (!finished) await fallBack()
      return
    }
    write({ method: 'initialized' })
    try {
      const posture = {
        cwd: ctx.cwd ?? null,
        approvalPolicy: 'never',
        sandbox: 'danger-full-access',
        ...((ctx.model ?? opts.model) ? { model: ctx.model ?? opts.model } : {}),
      }
      // A prior thread id continues that thread (the managed home keeps it); the
      // caller clears a pointer whose resume fails, exactly as for `exec resume`.
      const thread = asRecord(
        ctx.resume
          ? await request('thread/resume', { threadId: ctx.resume, ...posture })
          : await request('thread/start', posture),
      )
      threadId = asStr(asRecord(thread?.['thread'])?.['id']) ?? null
      model = asStr(thread?.['model'])
      if (!threadId) throw new Error('codex app-server returned no thread id')
      push({ type: 'thread', threadId, ...(model ? { model } : {}) })
      const prompt = opts.context ? `${opts.context}\n\n${opts.message}` : opts.message
      const turn = asRecord(
        await request('turn/start', { threadId, input: [{ type: 'text', text: prompt }] }),
      )
      turnId = asStr(asRecord(turn?.['turn'])?.['id']) ?? null
      resolveTurn(turnId)
    } catch (err) {
      if (abortRequested) finish({ ok: true, aborted: true, summary: '' })
      else
        finish({
          ok: false,
          summary: '',
          errorMessage: err instanceof Error ? err.message : String(err),
        })
    }
  }

  return {
    async start(): Promise<void> {
      if (started) return
      started = true
      let home: { codexHome: string; managed: boolean }
      try {
        home = await deps.prepareHome()
      } catch (err) {
        finish({
          ok: false,
          summary: '',
          errorMessage: err instanceof Error ? err.message : String(err),
        })
        return
      }
      if (!spawnServer(home.codexHome)) {
        await fallBack()
        return
      }
      void drive()
    },
    onEvent(handler: (ev: CodexNativeEvent) => void): () => void {
      handlers.add(handler)
      if (!subscribed) {
        subscribed = true
        const pendingEvents = buffered.splice(0)
        for (const ev of pendingEvents) handler(ev)
      }
      return () => handlers.delete(handler)
    },
    async abort(): Promise<void> {
      abortRequested = true
      if (fallback) {
        await fallback.abort()
        return
      }
      // Kill the tree (the app-server and every command it spawned). Its exit is
      // reported as an aborted terminal.
      if (child) killProcessTree(child)
      else if (!finished) finish({ ok: true, aborted: true, summary: '' })
    },
    async setModel(): Promise<void> {
      // The thread's model is fixed for the run.
    },
    async writeContext(key: string, value: string): Promise<void> {
      if (!ctx.cwd) return
      const target = path.join(ctx.cwd, key)
      await mkdir(path.dirname(target), { recursive: true })
      await writeFile(target, value, 'utf8')
    },
    // `turn/steer` only ever joins the turn in progress (a finished one refuses
    // it), so a passive steer needs no different handling.
    async steer(text: string): Promise<boolean> {
      if (fallback) throw new Error('this Codex has no app-server, so a run cannot be steered')
      if (!started || finished || abortRequested) return false
      const id = await turnReady
      if (!id || finished) return false
      try {
        await request('turn/steer', {
          threadId,
          expectedTurnId: id,
          input: [{ type: 'text', text }],
        })
        return true
      } catch (err) {
        // The turn completing under the steer is a race, not a refusal.
        if (finished) return false
        throw err
      }
    },
  }
}
