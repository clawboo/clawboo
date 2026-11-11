// THE seam every agent process starts through.
//
// "Agent process" means anything that runs model-directed work or runs in a
// folder an agent can write: a runtime CLI, Native's approved command, the
// verify gate's command, a connector with local reach, a per-agent browser, a
// long-lived runtime service, git in an agent's checkout.
//
// With CLAWBOO_AGENT_USER unset this is `child_process.spawn` with the caller's
// options, nothing more. With it set, the agent host (running as the agent
// user) starts the process, and the caller gets a ChildProcess-shaped proxy. The
// local branch is never taken in that mode, so an agent process can only start
// as the agent user, and a call site that bypasses this function is caught by
// `spawnSeam.test.ts`, which lists every spawn in the server.

import { spawn, type ChildProcess } from 'node:child_process'
import type { EventEmitter } from 'node:events'

import { isAgentUserMode } from '../agentUser/config'
import { activeAgentHost } from '../agentUser/state'

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

function envRecord(env: AgentSpawnOptions['env']): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(env)) if (typeof v === 'string') out[k] = v
  return out
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
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
      env: opts.env as NodeJS.ProcessEnv,
      stdio: [stdio[0], stdio[1], stdio[2]],
      shell: false,
      detached,
      ...(opts.signal ? { signal: opts.signal } : {}),
      ...(opts.windowsHide !== undefined ? { windowsHide: opts.windowsHide } : {}),
      ...(opts.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
    })
  }
  const { client } = activeAgentHost()
  return client.spawn({
    command: opts.command,
    args: opts.args,
    ...(opts.cwd ? { cwd: opts.cwd } : {}),
    env: envRecord(opts.env),
    stdio: [stdio[0], stdio[1], stdio[2]],
    group: detached,
    ...(opts.signal ? { signal: opts.signal } : {}),
  }) as unknown as ChildProcess
}
