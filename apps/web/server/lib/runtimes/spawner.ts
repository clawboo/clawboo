// THE seam every agent process starts through.
//
// "Agent process" means anything that runs model-directed work or runs in a
// folder an agent can write: a runtime CLI, Native's approved command, the
// verify gate's command, a connector with local reach, a per-agent browser, a
// long-lived runtime service, git in an agent's checkout.
//
// With agent isolation off this is `child_process.spawn` with the caller's
// options, nothing more. With CLAWBOO_AGENT_USER set, the agent host (running as
// the agent user) starts the process, and the caller gets a ChildProcess-shaped
// proxy. With CLAWBOO_AGENT_USERS set, each agent has a host of its own, and the
// process starts on the host of the agent it names (or, naming none, of the
// share its working folder belongs to). The local branch is never taken in
// either mode, so an agent process can only start as an agent user, and a call
// site that bypasses this function is caught by `spawnSites.test.ts`, which
// lists every spawn in the server.

import { spawn, type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'

import { spawnDeferred, type AgentHostClient } from '../agentUser/client'
import { isAgentPoolMode, isAgentUserMode } from '../agentUser/config'
import { UnknownAgentError } from '../agentUser/poolAssignments'
import { actingAgent, hostForAgent } from '../agentUser/poolRoute'
import { activeAgentHost } from '../agentUser/state'
import { SERVER_IDENTITY_ENV_KEYS } from './childEnv'

export { isAgentUserMode }

export type AgentSpawnKind =
  /** a runtime CLI run: codex exec / app-server, hermes acp, the Claude Code CLI */
  | 'runtime'
  /** a long-lived runtime service, such as `hermes gateway` */
  | 'gateway'
  /** Native's approved command */
  | 'tool'
  /** the verify gate's command */
  | 'verify'
  /** an MCP stdio connector with local reach */
  | 'connector'
  /** a per-agent browser connector */
  | 'browser'
  /** git in an agent-writable tree */
  | 'git'
  /** a device login run as the agent */
  | 'login'
  /** a short check: a version, a model list */
  | 'probe'

type StdioSlot = 'pipe' | 'ignore'

export interface AgentSpawnOptions {
  kind: AgentSpawnKind
  /**
   * The agent this process works for. With a user per agent
   * (CLAWBOO_AGENT_USERS) it runs as that agent's user; a process that names
   * no agent (git in a checkout, a reviewer) runs for the share its `cwd` is in.
   */
  agentId?: string | null
  command: string
  args: readonly string[]
  cwd?: string
  /**
   * The child's WHOLE environment. Build it with `buildChildEnv(extra)`: with
   * agent isolation on, that leaves out the server user's identity and private
   * locations, and the host fills HOME, USER, LOGNAME, SHELL and TMPDIR with
   * the agent user's. Secrets belong here, never in `args` (every local user
   * can read a process's arguments).
   */
  env: NodeJS.ProcessEnv | Record<string, string>
  /** Default `['ignore', 'pipe', 'pipe']`. */
  stdio?: readonly [StdioSlot, StdioSlot, StdioSlot]
  /** Start as a process-group leader on POSIX, so the whole tree can be stopped. Default true. */
  detached?: boolean
  signal?: AbortSignal
  windowsHide?: boolean
  windowsVerbatimArguments?: boolean
}

/**
 * What a started agent process looks like. A real `ChildProcess` satisfies it,
 * and so does the host's proxy.
 */
export interface AgentProcess extends EventEmitter {
  readonly pid?: number | undefined
  readonly stdin: NodeJS.WritableStream | null
  readonly stdout: NodeJS.ReadableStream | null
  readonly stderr: NodeJS.ReadableStream | null
  readonly exitCode: number | null
  readonly signalCode: NodeJS.Signals | null
  readonly killed: boolean
  readonly spawnfile: string
  kill(signal?: NodeJS.Signals | number): boolean
}

/** A process the agent host started (it has a host-side tree kill). */
export interface HostedAgentProcess extends AgentProcess {
  killTree(graceMs?: number): void
}

export function isHostedAgentProcess(p: unknown): p is HostedAgentProcess {
  return (
    !!p &&
    typeof (p as { killTree?: unknown }).killTree === 'function' &&
    typeof (p as { kill?: unknown }).kill === 'function'
  )
}

/**
 * The environment a host-started process gets.
 *
 * A variable that names who the server runs as or where its private state is
 * (HOME, TMPDIR, the ssh agent socket, CLAWBOO_HOME, ...) is dropped when it
 * still holds the server's own value: it was inherited, not chosen, whichever
 * env builder the call site used. A caller that sets one on purpose (an
 * isolated HOME for a runtime) sets a different value, and keeps it.
 */
function agentEnv(env: AgentSpawnOptions['env']): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(env)) {
    if (typeof v !== 'string') continue
    if (SERVER_IDENTITY_ENV_KEYS.has(k.toUpperCase()) && process.env[k] === v) continue
    out[k] = v
  }
  return out
}

/**
 * Runtime binaries the startup check found the agent user cannot execute, with
 * the reason (design 4.6 step 9). A run that would start one fails with that
 * reason instead of an unexplained ENOENT or EACCES.
 */
const unavailable = new Map<string, string>()

export function setUnavailableAgentBinaries(
  list: readonly { path: string; reason: string }[],
): void {
  unavailable.clear()
  for (const b of list) unavailable.set(b.path, b.reason)
}

/** Why the agent user cannot run `command`, or null. */
export function agentBinaryProblem(command: string): string | null {
  return unavailable.get(command) ?? null
}

/** A process that never started, failing with `reason`, as Node reports one. */
function failedStart(command: string, reason: string): ChildProcess {
  const proc = new EventEmitter() as EventEmitter & Record<string, unknown>
  Object.assign(proc, {
    pid: undefined,
    stdin: null,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: null,
    signalCode: null,
    killed: false,
    spawnfile: command,
    kill: () => false,
  })
  setImmediate(() => {
    proc.emit(
      'error',
      Object.assign(new Error(`not available to the agent user: ${reason}`), { code: 'EACCES' }),
    )
    ;(proc['stdout'] as PassThrough).end()
    ;(proc['stderr'] as PassThrough).end()
    proc['exitCode'] = -13
    proc.emit('close', -13, null)
  })
  return proc as unknown as ChildProcess
}

/**
 * The host a pooled process starts on: its agent's, or, for one that names no
 * agent or a name that is no agent (a reviewer's `critic`), the agent whose
 * work is under way (`runAsAgent`). Never some other member of a team: work a
 * teammate wrote must not run as whichever agent happens to be first.
 */
function poolHostFor(opts: AgentSpawnOptions): Promise<AgentHostClient> {
  const noAgent = (): Promise<AgentHostClient> => {
    const ambient = actingAgent()
    if (ambient) return hostForAgent(ambient)
    return Promise.reject(
      Object.assign(
        new Error(
          `a ${opts.kind} process names no agent, so it has no agent user to run as (each agent runs as its own user)`,
        ),
        { code: 'EACCES' },
      ),
    )
  }
  if (opts.agentId) {
    return hostForAgent(opts.agentId).catch((err: unknown) => {
      if (err instanceof UnknownAgentError) return noAgent()
      throw err
    })
  }
  return noAgent()
}

/**
 * Start an agent process: locally as today, or through the agent host as the
 * agent user. The return is typed as `ChildProcess` for the call sites that
 * hand it to code expecting one (the Agent SDK's spawn hook, stream helpers);
 * in agent mode it is the host's proxy, which implements every member those
 * call sites use (see `AgentProcess`).
 */
export function spawnAgentProcess(opts: AgentSpawnOptions): ChildProcess {
  const stdio = opts.stdio ?? (['ignore', 'pipe', 'pipe'] as const)
  const detached = opts.detached ?? process.platform !== 'win32'
  if (!isAgentUserMode()) {
    return spawn(opts.command, [...opts.args], {
      ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
      env: opts.env as NodeJS.ProcessEnv,
      stdio: [stdio[0], stdio[1], stdio[2]],
      shell: false,
      detached,
      ...(opts.signal ? { signal: opts.signal } : {}),
      ...(opts.windowsHide !== undefined ? { windowsHide: opts.windowsHide } : {}),
      ...(opts.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
    })
  }
  const problem = agentBinaryProblem(opts.command)
  if (problem) return failedStart(opts.command, problem)
  if (isAgentPoolMode()) {
    return spawnDeferred(poolHostFor(opts), {
      command: opts.command,
      args: opts.args,
      ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
      env: agentEnv(opts.env),
      stdio: [stdio[0], stdio[1], stdio[2]],
      group: detached,
      ...(opts.signal ? { signal: opts.signal } : {}),
    }) as unknown as ChildProcess
  }
  const { client } = activeAgentHost()
  return client.spawn({
    command: opts.command,
    args: opts.args,
    ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
    env: agentEnv(opts.env),
    stdio: [stdio[0], stdio[1], stdio[2]],
    group: detached,
    ...(opts.signal ? { signal: opts.signal } : {}),
  }) as unknown as ChildProcess
}
