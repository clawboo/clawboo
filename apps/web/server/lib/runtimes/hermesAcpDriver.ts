// Hermes driver over its Agent Client Protocol mode (`hermes acp`): the run is
// hosted in Hermes's ACP server on stdio instead of the quiet one-shot `hermes chat
// -q … -Q`, so the run streams its text, reasoning and tool calls as they happen,
// reports token usage, and takes a steer without being stopped.
//
// One driver = one run = one `hermes acp` process: `initialize`, then
// `session/load` (a known session in a home that already existed) or
// `session/new`, then the mode and model, then ONE `session/prompt`, then the
// process is shut down. The home, provider, model and keys are resolved exactly as
// for the quiet path (`resolveHermesRun`), and clawboo's MCP servers come from the
// home's config.yaml as they do there; they are declared in `session/new` only
// when that file could not carry them. The headless posture matches `--yolo`:
// `HERMES_YOLO_MODE`, the `dont_ask` edit mode, and any permission request
// answered with allow-once (the task's worktree is the isolation boundary).
//
// What ACP does not carry, and how this driver makes up for it (verified against
// the Hermes ACP server source, 0.15.2 to 0.22.6):
//   - A FAILED TURN. Hermes's loop returns `failed` with an `error`, but its ACP
//     server answers `stopReason: end_turn` all the same, without the text and
//     without `usage`. A finished turn always reports usage, so a turn that ends
//     with none failed; its reason is the error Hermes logged on stderr.
//   - A STEER THAT CAME TOO LATE. `/steer <text>` during a turn is folded into the
//     next tool result. One sent while Hermes writes its final answer, with no tool
//     call after it, is returned to the caller as `pending_steer`, which the ACP
//     server drops. This driver sends such a steer as one more turn, so it is read.
//   - Steer acknowledgements. Hermes answers `/steer` with a short message on the
//     session's text stream ("Steer queued for the active turn: …"); those are not
//     the agent's words and are kept out of the run's output.
//
// A Hermes without ACP (installed without the `acp` extra, or older than its ACP
// mode) fails the handshake before any turn starts; the run then FALLS BACK to the
// quiet driver (injected), which steers by stop-and-resume.

import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import type { HermesDriver, HermesNativeEvent } from '@clawboo/adapter-hermes'
import type { StartOpts, SteerOptions, Usage } from '@clawboo/executor'

import { isWindows } from '../platform'
import { createAcpConnection, type AcpConnection, type AcpSessionUpdate } from './acp/connection'
import { acpPromptUsage, acpStopReason, normalizeAcpUpdate } from './acp/updates'
import { buildChildEnv } from './childEnv'
import {
  HERMES_HEARTBEAT_MAX_MS,
  HERMES_HEARTBEAT_MS,
  hermesErrorCode,
  hermesMcpServers,
  resolveHermesRun,
  type HermesRunSettings,
} from './hermesDriver'
import { provisionHermesHome, type ProvisionedHermesHome } from './hermesHome'
import { killProcessTree } from './killTree'
import { registerRuntimeChild, unregisterRuntimeChild } from './subprocess'
import type { RuntimeRunContext } from './types'
import { resolveWindowsSpawn } from './winSpawn'

export interface HermesAcpDeps {
  /** The quiet `hermes chat -Q` driver, run instead when ACP can't be reached. */
  fallback: () => HermesDriver
  /** Test seam: the command that starts Hermes (default: the resolved `hermes`). */
  command?: string
  /** Test seam: the args before `acp` (e.g. a fake ACP agent script). */
  args?: string[]
  /** How long `initialize` may take before falling back. */
  handshakeTimeoutMs?: number
  /** While a tool call is open, how often the run reports it is still alive. */
  heartbeatMs?: number
  heartbeatMaxMs?: number
  /** How long a cancelled turn may take to answer before its process is killed. */
  cancelGraceMs?: number
  /** Told when the handshake failed because this Hermes has no ACP mode. */
  onAcpUnavailable?: (reason: string) => void
  /** Test seam: the longest unterminated stdout line (default MAX_ACP_LINE_CHARS). */
  maxLineChars?: number
}

/** Python imports make `hermes acp` slow to answer its first message. */
const HANDSHAKE_TIMEOUT_MS = 30_000
const CANCEL_GRACE_MS = 3_000
/** The longest stdout line `hermes acp` may write before the run fails. A tool
 *  result rides in one line, so this is generous. */
export const MAX_ACP_LINE_CHARS = 32 * 1024 * 1024

/** Hermes's own answers to `/steer` and to a prompt sent mid-turn. They arrive on
 *  the text stream but are not the agent's words. */
const STEER_ACK_RE =
  /^\s*(?:⏩\s*Steer queued|Redirected the active turn|Queued for the next turn|No active turn|⚠️\s*Steer failed|Usage: \/steer)/u
/** An acknowledgement that the steer joined the running turn. */
const STEER_JOINED_RE = /^\s*(?:⏩\s*Steer queued|Redirected the active turn)/u
/** An acknowledgement that Hermes queued it as a turn of its own after this one. */
const STEER_QUEUED_RE = /^\s*(?:No active turn|Queued for the next turn)/u

/** Lines on Hermes's stderr that state why a turn failed. */
const STDERR_ERROR_RE = /❌|\[ERROR\]|Error code:|\bError:/

/** The tool a Hermes tool-call title names: Hermes titles a call
 *  `<tool name>: <preview>`, or the bare name when there is no preview. */
export function hermesToolName(title: string): string {
  const i = title.indexOf(': ')
  return (i > 0 ? title.slice(0, i) : title).trim() || 'tool'
}

/** Put before text that starts with a slash, so Hermes reads it as text. */
const SLASH_TEXT_LEAD = 'The message below is text for you to read, not a Hermes command.'

/**
 * Text as Hermes should receive it in a prompt or a steer.
 *
 * Hermes's ACP server runs a text prompt that starts with `/`, after trimming, as
 * one of its own commands (`/model`, `/reset`, `/compact` and others) instead of
 * sending it to the model, and a `/steer` that finds no turn running is rewritten
 * into such a prompt. A task, chat message or comment that starts with a slash
 * must still reach the model as text, so it gets a plain lead line. The driver's
 * own `/steer` is added after this.
 *
 * Python's `strip()` removes more than JavaScript's `\s` (the separators
 * `\x1c` to `\x1f` and `\x85`, for one), so every leading whitespace, control
 * or format character is skipped before looking for the slash.
 */
export function hermesPromptText(text: string): string {
  return SLASH_LED_RE.test(text) ? `${SLASH_TEXT_LEAD}\n\n${text}` : text
}
const SLASH_LED_RE = /^[\s\p{Z}\p{Cc}\p{Cf}]*\//u

/** The turn a steer becomes when it arrived too late for the turn it was sent to. */
export function hermesLateSteerPrompt(texts: string[]): string {
  return [
    'This arrived while you were finishing your last answer. Take it into account and carry on.',
    ...texts,
  ].join('\n\n')
}

/** Why a turn that reported no usage failed: the error lines Hermes logged on
 *  stderr while it ran, else a plain statement. */
export function hermesAcpFailure(stderr: string): string {
  const lines = stderr
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && STDERR_ERROR_RE.test(l))
  const unique = [...new Set(lines)]
  const text = unique.slice(-4).join('\n')
  return text ? text.slice(-1500) : 'Hermes ended the turn without a result.'
}

type ResultFields = Omit<Extract<HermesNativeEvent, { type: 'result' }>, 'type'>

export function createHermesAcpDriver(
  opts: StartOpts,
  ctx: RuntimeRunContext,
  deps: HermesAcpDeps,
): HermesDriver {
  const handlers = new Set<(ev: HermesNativeEvent) => void>()
  const buffered: HermesNativeEvent[] = []
  let subscribed = false
  let started = false
  let finished = false
  let abortRequested = false
  let child: ChildProcess | null = null
  let conn: AcpConnection | null = null
  let fallback: HermesDriver | null = null
  let handshaken = false
  let stderr = ''
  /** Where this turn's stderr starts (the failure reason is read from there on). */
  let turnStderrStart = 0

  let sessionId: string | null = null
  /** The model the run was pinned to, for the cost estimate. */
  let runModel: string | undefined
  /** The main prompt has been sent and not yet answered. */
  let promptInFlight = false
  let resolveTurnStarted: () => void = () => undefined
  const turnStarted = new Promise<void>((r) => (resolveTurnStarted = r))

  // The run's output: every assistant text, and the part since its last tool call
  // (the closing answer, which becomes the summary).
  let allText = ''
  let closingText = ''
  const toolNames = new Map<string, string>()
  const openTools = new Set<string>()
  let toolStarts = 0
  let heartbeat: ReturnType<typeof setInterval> | null = null
  let heartbeatStarted = 0
  const maxLineChars = deps.maxLineChars ?? MAX_ACP_LINE_CHARS
  /** The throwaway home this run made (no per-identity home was given): it holds
   *  a copy of the person's Hermes sign-in, so it goes when the run does. */
  let ownedHome: string | null = null
  const removeOwnedHome = (): void => {
    const dir = ownedHome
    ownedHome = null
    if (dir) void rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }

  /** A steer in flight. `passive`: an FYI, never worth a turn of its own.
   *  `toolOpen` and `toolStarts` are read when Hermes acknowledges it, which is
   *  when it decides where the steer goes, not when it was sent. */
  interface SentSteer {
    text: string
    passive: boolean
    toolOpen: boolean
    toolStarts: number
  }
  /** Steers sent and not yet acknowledged, oldest first. */
  const awaitingAck: SentSteer[] = []
  /** Steers that joined the running turn but may not have been read yet. */
  const joined: SentSteer[] = []

  const push = (ev: HermesNativeEvent): void => {
    if (!subscribed) {
      buffered.push(ev)
      return
    }
    for (const h of [...handlers]) h(ev)
  }

  const stopHeartbeat = (): void => {
    if (heartbeat) clearInterval(heartbeat)
    heartbeat = null
  }

  /** The run's one terminal; the process is then shut down. */
  const finish = (result: ResultFields): void => {
    if (finished) return
    finished = true
    promptInFlight = false
    resolveTurnStarted()
    stopHeartbeat()
    push({
      type: 'result',
      ...result,
      ...(sessionId ? { sessionId } : {}),
      ...(runModel ? { model: runModel } : {}),
    })
    conn?.close('hermes acp run ended')
    const c = child
    if (c) {
      c.stdin?.end()
      killProcessTree(c)
    }
    removeOwnedHome()
  }

  const fail = (message: string): void => {
    const errorCode = hermesErrorCode(message)
    finish({
      ok: false,
      summary: closingText.trim() || allText.trim(),
      errorMessage: message,
      ...(errorCode ? { errorCode } : {}),
    })
  }

  function onUpdate(updateSession: string, update: AcpSessionUpdate): void {
    // Before the prompt goes out, updates are the replay of a loaded session's
    // history: the transcript of earlier runs, not this one.
    if (!promptInFlight || updateSession !== sessionId) return
    for (const u of normalizeAcpUpdate(update)) {
      if (u.kind === 'text') {
        if (u.channel === 'reasoning') {
          push({ type: 'message', text: u.text, channel: 'reasoning' })
          continue
        }
        if (awaitingAck.length > 0 && STEER_ACK_RE.test(u.text)) {
          const steer = awaitingAck.shift()!
          // Where Hermes put it depends on whether a tool call was open as it
          // took the steer: a tool that finished between the send and this
          // moment carries nothing.
          steer.toolOpen = openTools.size > 0
          steer.toolStarts = toolStarts
          if (STEER_JOINED_RE.test(u.text)) joined.push(steer)
          // Queued as a turn of its own: Hermes runs it after this one, inside the
          // same prompt, so nothing is left to deliver.
          else if (!STEER_QUEUED_RE.test(u.text)) joined.push(steer)
          continue
        }
        allText += u.text
        closingText += u.text
        push({ type: 'message', text: u.text })
      } else if (u.kind === 'tool-start') {
        const name = hermesToolName(u.title)
        toolNames.set(u.id, name)
        openTools.add(u.id)
        toolStarts += 1
        closingText = ''
        push({ type: 'tool-call', id: u.id, name, input: u.input })
      } else {
        openTools.delete(u.id)
        push({
          type: 'tool-result',
          id: u.id,
          name: toolNames.get(u.id) ?? '',
          output: u.output,
          isError: u.failed,
        })
      }
    }
  }

  /** Steers that joined the turn but had nothing left to ride on: taken while no
   *  tool call was open, with no tool call after them. Hermes holds those for the
   *  next turn, which ACP never starts. A passive steer is left there: an FYI
   *  never keeps a finishing run going. */
  function unreadSteers(): string[] {
    const late = joined.filter((s) => !s.passive && !s.toolOpen && toolStarts === s.toolStarts)
    joined.length = 0
    return late.map((s) => s.text)
  }

  /** Spawn `hermes acp`. Returns false when it could not be started at all. */
  function spawnAgent(run: HermesRunSettings): boolean {
    const command = deps.command ?? run.command
    const args = [...(deps.args ?? []), 'acp', '--accept-hooks']
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
        env: buildChildEnv({
          ...run.env,
          // `--yolo` for ACP: no dangerous-command prompt in a headless run.
          HERMES_YOLO_MODE: '1',
          // `--provider` for ACP. The home config's own provider still wins, as
          // it does there; a model pins its provider through session/set_model.
          ...(run.providerFlag ? { HERMES_INFERENCE_PROVIDER: run.providerFlag } : {}),
        }),
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
    conn = createAcpConnection({
      write: (line) => {
        spawned.stdin?.write(line)
      },
      onSessionUpdate: onUpdate,
    })
    const connection = conn
    let buf = ''
    // A character split across two chunks must not decode as two U+FFFDs.
    spawned.stdout?.setEncoding('utf8')
    spawned.stdout?.on('data', (d: string) => {
      buf += d
      // One JSON-RPC message per line: a line this long without its end is not
      // one Hermes would send, and buffering it could run for hours.
      if (buf.length > maxLineChars) {
        buf = ''
        fail(`hermes acp wrote over ${maxLineChars} characters without ending the line`)
        return
      }
      let nl: number
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl)
        buf = buf.slice(nl + 1)
        if (line.trim()) connection.onLine(line)
      }
    })
    spawned.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString()
      // Keep the turn's start in view; trim only what came before it.
      if (stderr.length > 64_000) {
        const cut = Math.min(stderr.length - 32_000, turnStderrStart)
        stderr = stderr.slice(cut)
        turnStderrStart -= cut
      }
    })
    spawned.stdin?.on('error', () => undefined)
    spawned.on('error', () => undefined)
    spawned.on('close', (code) => {
      unregisterRuntimeChild(spawned)
      connection.close('hermes acp exited')
      // Before the handshake, an exit is the handshake failing: the rejected
      // `initialize` sends the run to the quiet fallback.
      if (finished || fallback || !handshaken) return
      if (abortRequested) finish({ ok: true, aborted: true, summary: closingText.trim() })
      else {
        const why = hermesAcpFailure(stderr.slice(turnStderrStart))
        fail(
          why === 'Hermes ended the turn without a result.'
            ? `hermes acp exited${code != null ? ` with code ${code}` : ''} before the turn finished`
            : why,
        )
      }
    })
    return true
  }

  /** Run the quiet driver instead. `acpMissing`: this Hermes has no ACP mode
   *  (the handshake failed), as opposed to a run ACP cannot express. */
  async function fallBack(reason: string, acpMissing: boolean): Promise<void> {
    const c = child
    child = null
    conn?.close(reason)
    if (c) killProcessTree(c)
    // The quiet driver provisions a home of its own.
    removeOwnedHome()
    resolveTurnStarted()
    if (finished) return
    if (acpMissing) deps.onAcpUnavailable?.(reason)
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

  /** One `session/prompt`, answered when the turn ends. */
  async function prompt(text: string): Promise<unknown> {
    turnStderrStart = stderr.length
    return conn!.request('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: hermesPromptText(text) }],
    })
  }

  async function drive(run: HermesRunSettings, home: ProvisionedHermesHome): Promise<void> {
    const connection = conn!
    try {
      await Promise.race([
        connection.request('initialize', {
          protocolVersion: 1,
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
          },
          clientInfo: { name: 'clawboo', title: 'clawboo', version: '0.0.0' },
        }),
        new Promise((_, reject) => {
          const timer = setTimeout(
            () => reject(new Error('hermes acp handshake timed out')),
            deps.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS,
          )
          ;(timer as { unref?: () => void }).unref?.()
        }),
      ])
      handshaken = true
    } catch (err) {
      if (!finished) {
        const detail = stderr.trim().split('\n').slice(-2).join(' ')
        await fallBack(detail || (err instanceof Error ? err.message : String(err)), true)
      }
      return
    }

    try {
      const cwd = ctx.cwd ?? process.cwd()
      // clawboo's servers normally reach Hermes through the home's config.yaml.
      // When that file could not carry them, declare them for this session.
      const mcpServers =
        ctx.mcpBaseUrl && !home.mcpAttached
          ? Object.entries(hermesMcpServers(ctx.mcpBaseUrl, ctx.memoryScope ?? undefined)).map(
              ([name, cfg]) => ({ type: 'http', name, url: cfg.url, headers: [] }),
            )
          : []
      if (run.resume) {
        try {
          await connection.request('session/load', { sessionId: run.resume, cwd, mcpServers })
          sessionId = run.resume
        } catch {
          // The session is gone (a pruned state.db, another home): start fresh.
          // The task's handoff note carries the continuity.
          sessionId = null
        }
      }
      if (!sessionId) {
        const created = (await connection.request('session/new', { cwd, mcpServers })) as {
          sessionId?: unknown
        } | null
        sessionId = typeof created?.sessionId === 'string' ? created.sessionId : null
        if (!sessionId) throw new Error('hermes acp returned no session id')
      }
      push({ type: 'session', sessionId, ...(run.model ? { model: run.model } : {}) })
      // Edits without a prompt, like `--yolo`. Older versions without the mode
      // ask instead, and the permission answer covers them.
      await connection
        .request('session/set_mode', { sessionId, modeId: 'dont_ask' })
        .catch(() => undefined)
      if (run.model) {
        const modelId = run.providerFlag ? `${run.providerFlag}:${run.model}` : run.model
        await connection.request('session/set_model', { sessionId, modelId })
      }
      if (abortRequested) {
        finish({ ok: true, aborted: true, summary: '' })
        return
      }

      promptInFlight = true
      resolveTurnStarted()
      heartbeatStarted = Date.now()
      heartbeat = setInterval(() => {
        // A long tool call prints nothing; say the run is alive while one is open.
        // The beat stops at the cap, so a hung tool meets the silence limits.
        if (Date.now() - heartbeatStarted > (deps.heartbeatMaxMs ?? HERMES_HEARTBEAT_MAX_MS)) {
          stopHeartbeat()
          return
        }
        if (openTools.size > 0) push({ type: 'status', phase: 'running' })
      }, deps.heartbeatMs ?? HERMES_HEARTBEAT_MS)
      ;(heartbeat as { unref?: () => void }).unref?.()

      let text = run.prompt
      for (;;) {
        const result = await prompt(text)
        if (finished) return
        if (abortRequested) {
          finish({ ok: true, aborted: true, summary: closingText.trim() })
          return
        }
        const stop = acpStopReason(result)
        const usage: Usage | undefined = acpPromptUsage(result)
        if (stop !== 'end_turn') {
          const why = hermesAcpFailure(stderr.slice(turnStderrStart))
          fail(
            why === 'Hermes ended the turn without a result.'
              ? `Hermes stopped the turn (${stop ?? 'no reason given'})`
              : why,
          )
          return
        }
        // A finished turn reports its usage; one that failed reports none.
        if (!usage) {
          fail(hermesAcpFailure(stderr.slice(turnStderrStart)))
          return
        }
        const late = unreadSteers()
        if (late.length > 0) {
          text = hermesLateSteerPrompt(late)
          closingText = ''
          continue
        }
        finish({ ok: true, summary: closingText.trim() || allText.trim(), usage })
        return
      }
    } catch (err) {
      if (finished) return
      if (abortRequested) finish({ ok: true, aborted: true, summary: closingText.trim() })
      else fail(err instanceof Error ? err.message : String(err))
    }
  }

  return {
    async start(): Promise<void> {
      if (started) return
      started = true
      let run: HermesRunSettings
      let home: ProvisionedHermesHome
      try {
        // Persistent per-identity home when the runner materialized one;
        // otherwise a throwaway home (the conservative one-shot default).
        let homeDir = ctx.homeDir
        if (!homeDir) {
          homeDir = await mkdtemp(path.join(os.tmpdir(), 'clawboo-hermes-home-'))
          ownedHome = homeDir
        }
        home = await provisionHermesHome(homeDir, {
          mcpServers: ctx.mcpBaseUrl
            ? hermesMcpServers(ctx.mcpBaseUrl, ctx.memoryScope ?? undefined)
            : null,
        })
        run = await resolveHermesRun(opts, ctx, home)
        runModel = run.model
      } catch (err) {
        finish({
          ok: false,
          summary: '',
          errorMessage: err instanceof Error ? err.message : String(err),
        })
        return
      }
      // ACP pins a provider only together with a model. A provider picked for the
      // agent with no model to go with it is the quiet path's `--provider` alone.
      if (run.pickedProvider && !run.model) {
        await fallBack('a provider without a model is pinned only by the quiet path', false)
        return
      }
      if (!spawnAgent(run)) {
        await fallBack('hermes acp could not be started', true)
        return
      }
      void drive(run, home)
    },

    onEvent(handler: (ev: HermesNativeEvent) => void): () => void {
      handlers.add(handler)
      if (!subscribed) {
        subscribed = true
        for (const ev of buffered.splice(0)) handler(ev)
      }
      return () => handlers.delete(handler)
    },

    async abort(): Promise<void> {
      abortRequested = true
      if (fallback) return fallback.abort()
      if (finished) return
      if (!promptInFlight || !sessionId || !conn) {
        // The turn has not started: nothing to cancel, just stop.
        if (handshaken || !child) finish({ ok: true, aborted: true, summary: '' })
        else {
          const c = child
          child = null
          killProcessTree(c)
          finish({ ok: true, aborted: true, summary: '' })
        }
        return
      }
      conn.notify('session/cancel', { sessionId })
      // The cancelled turn answers its prompt; a Hermes that does not is killed.
      const timer = setTimeout(
        () => finish({ ok: true, aborted: true, summary: closingText.trim() }),
        deps.cancelGraceMs ?? CANCEL_GRACE_MS,
      )
      ;(timer as { unref?: () => void }).unref?.()
    },

    async setModel(): Promise<void> {
      // The model is fixed when the session starts; a change applies to the next run.
    },

    async writeContext(): Promise<void> {
      // Context rides the prompt.
    },

    // Live over ACP; once this run has fallen back, the quiet driver's way.
    steering: () => (fallback ? 'interrupt-resume' : 'live'),

    async steer(text: string, steerOpts?: SteerOptions): Promise<boolean> {
      await turnStarted
      if (fallback) {
        // The quiet path steers by stopping the run, never worth it for an FYI.
        if (steerOpts?.passive || !fallback.steer) return false
        return fallback.steer(text, steerOpts)
      }
      if (finished || !promptInFlight || !conn || !sessionId) return false
      // The send-time view, kept only if no acknowledgement comes to refine it.
      const steer: SentSteer = {
        text,
        passive: steerOpts?.passive === true,
        toolOpen: openTools.size > 0,
        toolStarts,
      }
      awaitingAck.push(steer)
      try {
        await conn.request('session/prompt', {
          sessionId,
          prompt: [{ type: 'text', text: `/steer ${hermesPromptText(text)}` }],
        })
      } catch (err) {
        const i = awaitingAck.indexOf(steer)
        if (i >= 0) awaitingAck.splice(i, 1)
        if (finished) return false
        throw err
      }
      // No acknowledgement came (a version that answers differently): count it as
      // joined, so a steer that came too late is still delivered.
      const i = awaitingAck.indexOf(steer)
      if (i >= 0) {
        awaitingAck.splice(i, 1)
        joined.push(steer)
      }
      return true
    },
  }
}
