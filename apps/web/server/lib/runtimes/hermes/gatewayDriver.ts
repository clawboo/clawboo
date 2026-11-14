// A Hermes run through the supervised gateway: the agent's profile is made
// ready, the run is started with `POST /p/<profile>/v1/runs`, and its event
// stream is read until it ends.
//
// Mapping (verified against a live v0.23.1 gateway):
//   message.delta   -> the agent's text, as it streams
//   tool.started    -> a tool call (Hermes sends the tool and a preview of its
//                      arguments, not the arguments themselves)
//   tool.completed  -> its result (Hermes sends whether it failed, no output)
//   approval.*      -> a Clawboo approval card, answered back to Hermes
//   run.completed   -> success, with the run's tokens (no dollars: cost is an
//                      estimate from tokens, as before)
//   run.failed      -> failure, its reason read for the provider's cause
//   run.cancelled   -> the stop this driver asked for
//
// - Working folder: the API has none, so the profile's `.env` names it
//   (`TERMINAL_CWD`) before each run. An agent's runs go one at a time, and a run
//   Clawboo stops watching before Hermes says it ended (a stop Hermes has not
//   honoured yet, a lost gateway) keeps the profile until Hermes says it has, so
//   the next run never shares its folder. A session keeps the folder its agent
//   last `cd`'d into, so a session last used in another folder (recorded in the
//   profile, so a restart remembers it) is not resumed: the run starts a new one.
//   A job of the agent's own that Hermes fires during a run reads the same
//   `.env`, so it works in that run's folder.
// - MCP: an agent's profile holds one live URL per Clawboo server, and its calls
//   are bound to this run while it lasts (`bindLiveRun`). A run with no identity
//   home (the reviewer's) gets a throwaway profile with this run's own URLs,
//   removed when the run ends, so it shares no memory with the builder.
// - Steering is live: `POST .../steer` reaches the run after its current tool
//   batch, or before its next model call. One that arrives while Hermes writes
//   its final answer runs as a follow-up turn in the same run, so it is never
//   dropped. A passive steer is sent only while a tool call is open, so an FYI
//   never buys a turn of its own.

import { randomUUID } from 'node:crypto'
import path from 'node:path'

import type { HermesDriver, HermesNativeEvent } from '@clawboo/adapter-hermes'
import type { ClawbooDb } from '@clawboo/db'
import type { StartOpts, SteerOptions, Usage } from '@clawboo/executor'
import { createLogger } from '@clawboo/logger'

import { agentReadFile, agentRemove, agentWriteFile } from '../../agentUser/agentFs'
import { getDb } from '../../db'
import { bindLiveRun } from '../../mcpLiveBindings'
import type { RuntimeRunContext } from '../types'
import {
  openHermesApproval,
  parseHermesApprovalEvent,
  settleHermesApproval,
  settleRunApprovals,
  hermesApprovalId,
} from './approvals'
import {
  HermesApiError,
  type HermesClient,
  type HermesRunEvent,
  type HermesRunStatus,
} from './client'
import { hermesFailure } from './failure'
import type { HermesGatewaySupervisor } from './gateway'
import { ensureTeamWorkdir } from '../teamWorkdir'
import {
  derivedHermesKey,
  hermesJobsFolder,
  hermesProfileDir,
  hermesProfileName,
  provisionProfile,
  setProfileTerminalCwd,
  throwawayProfileName,
} from './profiles'
import { hermesAgentMcpServers, hermesRunMcpServers, resolveHermesRunSettings } from './runSettings'

const log = createLogger('hermes-gateway-driver')

/** While a tool call or an approval is open, how often the run says it is alive. */
export const HERMES_HEARTBEAT_MS = 60_000
/** How long it keeps saying so; past this a silent run meets the silence limits. */
export const HERMES_HEARTBEAT_MAX_MS = 2 * 60 * 60_000
/** How long a stopped run may take to report it stopped. */
const STOP_GRACE_MS = 15_000
/** Stream opens in a row that bring no new event before the run is read by polling. */
const STREAM_REOPENS = 3
/** How long a profile may take to be served. The gateway's watcher picks up a
 *  new profile within about 30 seconds of it being written. */
const PROFILE_READY_MS = 45_000

/** Hermes refuses a run on a profile its gateway does not serve yet (written
 *  since its last scan) with 409 `profile_mismatch`. Nothing was started. */
function notServedYet(err: unknown): boolean {
  return (
    err instanceof HermesApiError &&
    err.status === 409 &&
    (err.code === 'profile_mismatch' || /profile_mismatch/.test(err.message))
  )
}
/** How long a run Clawboo stopped watching may hold its agent's profile before
 *  the agent runs again regardless. */
const LINGER_MAX_MS = HERMES_HEARTBEAT_MAX_MS
/** The run states Hermes ends a run in. */
const TERMINAL_RUN_STATUSES = new Set(['completed', 'failed', 'cancelled', 'interrupted'])

/**
 * One run per agent profile at a time, from start until Hermes says it ended. A
 * profile's working folder (`TERMINAL_CWD`) and the binding of its live MCP
 * calls hold one run's values, so two runs in flight for one agent would each
 * see the other's. The callers already serialize an agent's runs (the identity
 * home lock); this keeps it true for any caller that does not, and for a run
 * Hermes is still finishing after Clawboo stopped watching it.
 */
const profileLocks = new Map<string, Promise<void>>()

/** A place in a profile's queue: `acquired` resolves at the front; `release`
 *  may be called at any time, also while still waiting. */
function lockProfile(profile: string): { acquired: Promise<void>; release: () => void } {
  const previous = profileLocks.get(profile) ?? Promise.resolve()
  let release: () => void = () => undefined
  const mine = new Promise<void>((r) => (release = r))
  const tail = previous.then(() => mine)
  profileLocks.set(profile, tail)
  // Forgotten only once everything queued before it is done, so a newcomer
  // never skips a holder that is still running.
  void tail.then(() => {
    if (profileLocks.get(profile) === tail) profileLocks.delete(profile)
  })
  let released = false
  return {
    acquired: previous,
    release: () => {
      if (released) return
      released = true
      release()
    },
  }
}

/** The folder each session of a profile was last run in, kept in the profile so
 *  a restart remembers it. */
const SESSION_FOLDERS_FILE = '.clawboo-sessions.json'
const SESSION_FOLDERS_MAX = 200

async function readSessionFolders(dir: string): Promise<Record<string, string | null>> {
  try {
    const buf = await agentReadFile(path.join(dir, SESSION_FOLDERS_FILE), { maxBytes: 1 << 20 })
    if (!buf) return {}
    const parsed: unknown = JSON.parse(buf.toString('utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: Record<string, string | null> = {}
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === 'string' || v === null) out[k] = v
    }
    return out
  } catch {
    return {}
  }
}

async function recordSessionFolder(dir: string, session: string, cwd: string | null) {
  const all = await readSessionFolders(dir)
  delete all[session]
  all[session] = cwd
  const keys = Object.keys(all)
  for (const k of keys.slice(0, Math.max(0, keys.length - SESSION_FOLDERS_MAX))) delete all[k]
  await agentWriteFile(path.join(dir, SESSION_FOLDERS_FILE), JSON.stringify(all))
}

export interface HermesGatewayDriverDeps {
  supervisor: HermesGatewaySupervisor
  db?: () => ClawbooDb
  heartbeatMs?: number
  heartbeatMaxMs?: number
  stopGraceMs?: number
  profileReadyMs?: number
  pollMs?: number
  lingerMaxMs?: number
  /** How long a run's event stream may send nothing before it is read again
   *  (default `STREAM_IDLE_MS`). */
  streamIdleMs?: number
}

type ResultFields = Omit<Extract<HermesNativeEvent, { type: 'result' }>, 'type'>

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/**
 * Hold a profile for a run Clawboo stopped watching until Hermes says the run
 * ended, asking it once more to stop. Let go when it has, when the gateway that
 * ran it is gone (its runs end with it), or after `maxMs`.
 */
async function holdUntilEnded(
  c: HermesClient,
  runId: string,
  gatewayPid: number | null,
  deps: HermesGatewayDriverDeps,
  release: () => void,
): Promise<void> {
  const deadline = Date.now() + (deps.lingerMaxMs ?? LINGER_MAX_MS)
  const pollMs = deps.pollMs ?? 2_000
  let stopSent = false
  try {
    while (Date.now() < deadline) {
      if (deps.supervisor.status().pid !== gatewayPid) return
      try {
        const s = await c.getRun(runId)
        if (TERMINAL_RUN_STATUSES.has(s.status)) return
        if (!stopSent) {
          stopSent = true
          await c.stopRun(runId).catch(() => undefined)
        }
      } catch (err) {
        // Gone from Hermes's records: nothing left running.
        if (err instanceof HermesApiError && err.status === 404) return
        // Otherwise the gateway is busy or restarting: ask again.
      }
      await sleep(pollMs)
    }
    log.warn({ runId }, 'a Hermes run did not end after it was stopped; its agent runs again')
  } finally {
    release()
  }
}

/** Hermes's token counts as Clawboo's usage. */
export function hermesUsage(raw: unknown): Usage | undefined {
  const u = raw as { input_tokens?: unknown; output_tokens?: unknown } | null
  const input = typeof u?.input_tokens === 'number' ? u.input_tokens : null
  const output = typeof u?.output_tokens === 'number' ? u.output_tokens : null
  if (input === null && output === null) return undefined
  return { inputTokens: input ?? 0, outputTokens: output ?? 0 }
}

/** What an approval settled as, in the row's own words, when the event says
 *  (v0.23.1's `approval.settled` names no choice: null then). */
function settledStatus(ev: HermesRunEvent): string | null {
  const choice = typeof ev['choice'] === 'string' ? ev['choice'] : ''
  if (choice === 'deny') return 'deny'
  if (choice === 'once' || choice === 'session' || choice === 'always') return 'allow_once'
  return null
}

export function createHermesGatewayDriver(
  opts: StartOpts,
  ctx: RuntimeRunContext,
  deps: HermesGatewayDriverDeps,
): HermesDriver {
  const handlers = new Set<(ev: HermesNativeEvent) => void>()
  const buffered: HermesNativeEvent[] = []
  let subscribed = false
  let started = false
  let finished = false
  let abortRequested = false
  let client: HermesClient | null = null
  let runId: string | null = null
  let sessionId: string | null = null
  let runModel: string | undefined
  let throwaway: string | null = null
  /** The agent's own profile, once written, and where its jobs run commands. */
  let profileDir: string | null = null
  let jobsCwd: string | null = null
  let lastSeq: number | undefined
  /** Hermes said the run ended (an end event, or an ended status). */
  let runEnded = false
  /** The gateway process the run was started on. */
  let gatewayPid: number | null = null
  let releaseBinding: () => void = () => undefined
  let releaseProfile: () => void = () => undefined
  let resolveTurnStarted: () => void = () => undefined
  const turnStarted = new Promise<void>((r) => (resolveTurnStarted = r))
  let wakeOnAbort: () => void = () => undefined
  const abortWait = new Promise<void>((r) => (wakeOnAbort = r))
  const stream = new AbortController()
  /** The card opened from a polled status, settled when the status moves on. */
  let polledApproval: string | null = null

  let allText = ''
  let closingText = ''
  const toolNames = new Map<string, string>()
  const openTools = new Set<string>()
  const openApprovals = new Set<string>()
  let heartbeat: ReturnType<typeof setInterval> | null = null
  const db = (): ClawbooDb => (deps.db ?? getDb)()

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

  /**
   * Let go of the profile once Hermes is done with the run (at once, or when
   * `holdUntilEnded` sees it end): a throwaway one is removed then, not while
   * the run may still be in it; an agent's own points its commands back at the
   * agent's jobs folder, where the jobs Hermes runs on its own work until the
   * next run, never the last task's folder.
   */
  const letGo = async (unlock: () => void): Promise<void> => {
    const tmp = throwaway
    throwaway = null
    try {
      if (tmp) await agentRemove(tmp)
      else if (profileDir && jobsCwd) await setProfileTerminalCwd(profileDir, jobsCwd)
    } catch (err) {
      log.debug(
        { err: err instanceof Error ? err.message : String(err) },
        'could not tidy the Hermes profile after a run',
      )
    } finally {
      unlock()
    }
  }

  const finish = (result: ResultFields): void => {
    if (finished) return
    finished = true
    resolveTurnStarted()
    stopHeartbeat()
    stream.abort()
    releaseBinding()
    const release = releaseProfile
    releaseProfile = () => undefined
    if (runId && client && !runEnded) void holdUntilEnded(client, runId, gatewayPid, deps, release)
    else release()
    if (runId) {
      try {
        settleRunApprovals(db(), runId)
      } catch {
        // The cards expire on their own deadline.
      }
    }
    push({
      type: 'result',
      ...result,
      ...(sessionId ? { sessionId } : {}),
      ...(runModel ? { model: runModel } : {}),
    })
  }

  const fail = (message: string): void => {
    const { errorMessage, errorCode } = hermesFailure(message)
    finish({
      ok: false,
      summary: closingText.trim() || allText.trim(),
      errorMessage,
      ...(errorCode ? { errorCode } : {}),
    })
  }

  const aborted = (): void => finish({ ok: true, aborted: true, summary: closingText.trim() })

  /** True when the event is one this run has not seen (a reopened stream
   *  replays from the last event read: never twice). */
  function isNew(ev: HermesRunEvent): boolean {
    if (typeof ev.seq !== 'number') return true
    if (lastSeq !== undefined && ev.seq <= lastSeq) return false
    lastSeq = ev.seq
    return true
  }

  /** A command Hermes holds for a person: a card, once. */
  function openApproval(ev: HermesRunEvent): string | null {
    const req = runId ? parseHermesApprovalEvent(ev, runId) : null
    if (!req || !client) return null
    try {
      const id = openHermesApproval(db(), client, {
        ...req,
        cwd: ctx.cwd ?? null,
        agentId: ctx.memoryScope?.agentId ?? opts.agentId ?? null,
        taskId: ctx.memoryScope?.boundTaskId ?? null,
      })
      openApprovals.add(id)
      return id
    } catch (err) {
      log.warn({ err }, 'could not open a card for a Hermes approval')
      return null
    }
  }

  function settleApproval(id: string, status: string | null): void {
    openApprovals.delete(id)
    try {
      settleHermesApproval(db(), id, status)
    } catch {
      // The card expires on its own deadline.
    }
  }

  /** One event off the run's stream. True once the run has ended. */
  function onEvent(ev: HermesRunEvent): boolean {
    if (ev.event.startsWith('run.') && TERMINAL_RUN_STATUSES.has(ev.event.slice(4))) {
      runEnded = true
    }
    switch (ev.event) {
      case 'message.delta': {
        const text = typeof ev['delta'] === 'string' ? ev['delta'] : ''
        if (!text) return false
        allText += text
        closingText += text
        push({ type: 'message', text })
        return false
      }
      case 'reasoning.delta': {
        const text = typeof ev['delta'] === 'string' ? ev['delta'] : ''
        if (text) push({ type: 'message', text, channel: 'reasoning' })
        return false
      }
      case 'tool.started': {
        const id =
          typeof ev['tool_call_id'] === 'string' ? ev['tool_call_id'] : `tool-${toolNames.size + 1}`
        const name = typeof ev['tool'] === 'string' ? ev['tool'] : 'tool'
        toolNames.set(id, name)
        openTools.add(id)
        closingText = ''
        const preview = typeof ev['preview'] === 'string' ? ev['preview'] : ''
        push({ type: 'tool-call', id, name, input: preview ? { preview } : {} })
        return false
      }
      case 'tool.completed': {
        const id = typeof ev['tool_call_id'] === 'string' ? ev['tool_call_id'] : ''
        const name = toolNames.get(id) ?? (typeof ev['tool'] === 'string' ? ev['tool'] : '')
        openTools.delete(id)
        const preview = typeof ev['preview'] === 'string' ? ev['preview'] : ''
        push({ type: 'tool-result', id, name, output: preview, isError: ev['error'] === true })
        return false
      }
      case 'approval.request': {
        openApproval(ev)
        push({ type: 'status', phase: 'running' })
        return false
      }
      case 'approval.settled': {
        const requestId =
          typeof ev['prompt_id'] === 'string'
            ? ev['prompt_id']
            : typeof ev['request_id'] === 'string'
              ? ev['request_id']
              : ''
        if (runId && requestId)
          settleApproval(hermesApprovalId(runId, requestId), settledStatus(ev))
        return false
      }
      case 'run.completed': {
        finish({
          ok: true,
          summary:
            (typeof ev['output'] === 'string' ? ev['output'] : '').trim() ||
            closingText.trim() ||
            allText.trim(),
          ...(hermesUsage(ev['usage']) ? { usage: hermesUsage(ev['usage'])! } : {}),
        })
        return true
      }
      case 'run.failed': {
        const error =
          typeof ev['error'] === 'string' && ev['error'].trim()
            ? ev['error']
            : typeof ev['turn_exit_reason'] === 'string'
              ? `Hermes ended the turn early: ${ev['turn_exit_reason']}`
              : 'Hermes reported the run failed without a reason.'
        fail(error)
        return true
      }
      case 'run.cancelled':
      case 'run.interrupted': {
        if (abortRequested) aborted()
        else fail(`Hermes ${ev.event === 'run.cancelled' ? 'cancelled' : 'interrupted'} the run.`)
        return true
      }
      default:
        return false
    }
  }

  /** One polled status. True once the run has ended. */
  function onStatus(status: HermesRunStatus): boolean {
    // A command held for a person shows on the status as well as the stream.
    const held =
      status.status === 'waiting_for_approval' &&
      status['approval'] &&
      typeof status['approval'] === 'object'
        ? (status['approval'] as HermesRunEvent)
        : null
    const heldId = held ? openApproval(held) : null
    if (polledApproval && polledApproval !== heldId) settleApproval(polledApproval, null)
    polledApproval = heldId
    if (!TERMINAL_RUN_STATUSES.has(status.status)) return false
    runEnded = true
    const error = typeof status['error'] === 'string' ? status['error'].trim() : ''
    if (status.status === 'completed') {
      finish({
        ok: true,
        summary: (status.output ?? '').trim() || closingText.trim() || allText.trim(),
        ...(hermesUsage(status.usage) ? { usage: hermesUsage(status.usage)! } : {}),
      })
    } else if (status.status === 'failed') {
      fail(error || (status.output ?? '').trim() || 'Hermes reported the run failed.')
    } else if (abortRequested) {
      aborted()
    } else {
      fail(
        error || `Hermes ${status.status === 'cancelled' ? 'cancelled' : 'interrupted'} the run.`,
      )
    }
    return true
  }

  /** The run's status, read by polling, for when its stream cannot be read. */
  async function settleByPolling(): Promise<void> {
    const pollMs = deps.pollMs ?? 2_000
    for (;;) {
      if (finished || !client || !runId) return
      let status
      try {
        status = await client.getRun(runId)
      } catch (err) {
        if (finished) return
        if (abortRequested) return aborted()
        if (err instanceof HermesApiError && err.status === 404) {
          return fail('The Hermes gateway no longer knows this run (it restarted).')
        }
        const why = err instanceof Error ? err.message : String(err)
        return fail(`The Hermes gateway stopped answering during the run (${why}).`)
      }
      if (finished || onStatus(status)) return
      await sleep(pollMs)
    }
  }

  async function drive(): Promise<void> {
    let fruitless = 0
    while (!finished) {
      let ended = false
      let progressed = false
      try {
        await client!.streamEvents(
          runId!,
          (ev) => {
            if (ended || finished || !isNew(ev)) return
            progressed = true
            ended = onEvent(ev)
          },
          {
            signal: stream.signal,
            ...(lastSeq !== undefined ? { lastSeq } : {}),
            ...(deps.streamIdleMs !== undefined ? { idleMs: deps.streamIdleMs } : {}),
          },
        )
      } catch (err) {
        if (finished) return
        log.debug(
          { err: err instanceof Error ? err.message : String(err) },
          'hermes event stream broke',
        )
      }
      if (finished || ended) return
      fruitless = progressed ? 0 : fruitless + 1
      if (fruitless >= STREAM_REOPENS) break
      await sleep(Math.min(250 * fruitless, 1_000))
    }
    await settleByPolling()
  }

  return {
    async start(): Promise<void> {
      if (started) return
      started = true
      try {
        const supervisor = deps.supervisor
        const conn = await supervisor.ensureRunning()
        const persistent = Boolean(ctx.homeDir)
        const profile = persistent ? hermesProfileName(ctx.homeDir!) : throwawayProfileName()
        const lock = lockProfile(profile)
        releaseProfile = () => void letGo(lock.release)
        // A stop while queued behind the agent's previous run ends this one now.
        await Promise.race([lock.acquired, abortWait])
        if (finished) {
          lock.release()
          return
        }
        if (abortRequested) {
          aborted()
          return
        }
        // Set before the profile is written, so a run that fails part way still
        // removes what it made.
        if (!persistent) throwaway = hermesProfileDir(conn.home, profile)
        const agentId = ctx.memoryScope?.agentId ?? opts.agentId ?? null
        // Commands always have a folder of their own: the run's, else the agent's
        // jobs folder (a throwaway run's own profile, when it has no agent).
        // Hermes would otherwise fall back to the gateway's home.
        if (persistent && agentId) {
          jobsCwd = hermesJobsFolder(agentId)
          await ensureTeamWorkdir(jobsCwd)
        }
        const runCwd = ctx.cwd ?? jobsCwd ?? throwaway
        const mcpServers = !ctx.mcpBaseUrl
          ? null
          : persistent && agentId
            ? hermesAgentMcpServers(ctx.mcpBaseUrl, agentId, ctx.memoryScope?.attachSecret)
            : hermesRunMcpServers(ctx.mcpBaseUrl, ctx.memoryScope ?? undefined)
        const prov = await provisionProfile({
          gatewayHome: conn.home,
          profile,
          legacyHome: persistent ? ctx.homeDir! : null,
          key: derivedHermesKey(conn.masterKey, profile),
          cwd: runCwd,
          providerEnv: ctx.apiKeyEnv ?? {},
          mcpServers,
          providerHint: ctx.providerHint ?? null,
        })
        if (persistent) profileDir = prov.dir
        if (prov.migrated) log.info({ profile }, 'moved the agent’s Hermes home into its profile')
        if (ctx.mcpBaseUrl && !prov.mcpAttached) {
          log.warn(
            { profile },
            "the agent's Hermes config.yaml has a one-line mcp_servers mapping; Clawboo's MCP servers were not attached",
          )
        }
        client = supervisor.profileClient(conn, profile)
        const servedBy = Date.now() + (deps.profileReadyMs ?? PROFILE_READY_MS)
        const settings = await resolveHermesRunSettings(opts, ctx, prov.dir)
        runModel = settings.model
        // Resume only a session this profile can hold, last run in this folder.
        const cwd = ctx.cwd ?? null
        const canResume = persistent && Boolean(ctx.resume) && !(prov.created && !prov.migrated)
        const folders = canResume ? await readSessionFolders(prov.dir) : {}
        const lastFolder =
          canResume && Object.hasOwn(folders, ctx.resume!) ? folders[ctx.resume!] : undefined
        sessionId =
          canResume && (lastFolder === undefined || lastFolder === cwd)
            ? ctx.resume!
            : `cb-${randomUUID()}`
        if (persistent && agentId && ctx.memoryScope) {
          releaseBinding = bindLiveRun(agentId, ctx.memoryScope)
        }
        push({ type: 'session', sessionId, ...(runModel ? { model: runModel } : {}) })
        if (abortRequested) {
          aborted()
          return
        }
        const body = {
          input: settings.input,
          ...(settings.model ? { model: settings.model } : {}),
          ...(settings.provider ? { provider: settings.provider } : {}),
        }
        gatewayPid = supervisor.status().pid
        const c = client
        // Sent with a key: a start whose answer is lost is asked again with the
        // same key, and Hermes answers with the run it already started.
        // A profile the gateway does not serve yet (a new one, or one back from
        // being set aside) is asked again until it is.
        const startOnce = async (session: string): Promise<{ runId: string }> => {
          const idempotencyKey = randomUUID()
          for (;;) {
            try {
              try {
                return await c.startRun({ ...body, session_id: session }, { idempotencyKey })
              } catch (err) {
                if (err instanceof HermesApiError) throw err
                return await c.startRun({ ...body, session_id: session }, { idempotencyKey })
              }
            } catch (err) {
              if (!notServedYet(err) || abortRequested) throw err
              if (Date.now() >= servedBy) {
                throw new Error(
                  'The Hermes gateway did not pick up the agent’s profile in time. Try again in a minute.',
                )
              }
              await sleep(1_000)
            }
          }
        }
        let out: { runId: string }
        try {
          out = await startOnce(sessionId)
        } catch (err) {
          // A session the API cannot continue (one an earlier Clawboo made over
          // Hermes's editor protocol, or one since deleted) is refused with 409:
          // start a new one, and the task's handoff note carries the continuity.
          if (
            !(err instanceof HermesApiError) ||
            err.status !== 409 ||
            notServedYet(err) ||
            sessionId !== ctx.resume
          ) {
            throw err
          }
          sessionId = `cb-${randomUUID()}`
          push({ type: 'session', sessionId, ...(runModel ? { model: runModel } : {}) })
          out = await startOnce(sessionId)
        }
        runId = out.runId
        if (persistent) {
          await recordSessionFolder(prov.dir, sessionId, cwd).catch((err: unknown) =>
            log.debug({ err }, 'could not record the session folder'),
          )
        }
      } catch (err) {
        // A stop asked for while the run was starting ends it as stopped.
        if (abortRequested && !runId) {
          aborted()
          return
        }
        const message = err instanceof Error ? err.message : String(err)
        fail(
          err instanceof HermesApiError
            ? `The Hermes gateway refused the run: ${message}`
            : /gateway|Hermes/.test(message)
              ? message
              : `The Hermes run could not start: ${message}`,
        )
        return
      }
      resolveTurnStarted()
      const startedAt = Date.now()
      heartbeat = setInterval(() => {
        if (Date.now() - startedAt > (deps.heartbeatMaxMs ?? HERMES_HEARTBEAT_MAX_MS)) {
          stopHeartbeat()
          return
        }
        if (openTools.size > 0 || openApprovals.size > 0) push({ type: 'status', phase: 'running' })
      }, deps.heartbeatMs ?? HERMES_HEARTBEAT_MS)
      ;(heartbeat as { unref?: () => void }).unref?.()
      if (abortRequested) void this.abort()
      void drive()
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
      wakeOnAbort()
      if (finished) return
      if (!runId || !client) {
        // Not started on Hermes's side yet: start() stops on its own.
        if (!started) aborted()
        return
      }
      try {
        await client.stopRun(runId)
      } catch (err) {
        log.debug({ err: err instanceof Error ? err.message : String(err) }, 'hermes stop failed')
      }
      // The stream reports `run.cancelled`; a gateway that does not is not waited on.
      const timer = setTimeout(() => aborted(), deps.stopGraceMs ?? STOP_GRACE_MS)
      ;(timer as { unref?: () => void }).unref?.()
    },

    async setModel(): Promise<void> {
      // The model is fixed when the run starts; a change applies to the next run.
    },

    async writeContext(): Promise<void> {
      // Context rides the input.
    },

    steering: () => 'live',

    async steer(text: string, steerOpts?: SteerOptions): Promise<boolean> {
      await turnStarted
      if (finished || !runId || !client) return false
      // An FYI rides only into a tool batch already running: sent later, Hermes
      // would answer it with a turn of its own.
      if (steerOpts?.passive && openTools.size === 0) return false
      try {
        await client.steer(runId, text)
        return true
      } catch (err) {
        if (err instanceof HermesApiError && (err.status === 409 || err.status === 404))
          return false
        if (finished) return false
        throw err
      }
    },
  }
}
