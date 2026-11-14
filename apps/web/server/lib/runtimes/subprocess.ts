// Shared subprocess-driver substrate for the spawned runtimes (Codex, Hermes).
// Buffers native events until the adapter subscribes (so frames emitted between
// `start()` and `onEvent()` are never dropped), parses stdout line-by-line, and
// ALWAYS synthesizes a terminal native event on process exit — so a run's
// lifecycle completes even if mid-stream parsing misses an event.
//
// Spawning is ALWAYS `shell: false` so an untrusted prompt passed as argv is
// never shell-interpreted. `resolveWindowsSpawn` handles the one case a bare
// `shell: false` can't — a Windows `.cmd`/`.bat` shim, which Node refuses to
// spawn without a shell — by routing it through cmd.exe with every argument
// quoted + caret-escaped (so cmd metacharacters in the prompt are inert).

import type { ChildProcess } from 'node:child_process'
import path from 'node:path'

import { agentMkdir, agentStat, agentWriteFile } from '../agentUser/agentFs'
import { isWindows } from '../platform'
import { buildChildEnv } from './childEnv'
import { killProcessTree, killProcessTreeByPid } from './killTree'
import { recordRuntimePid } from './runtimePidFile'
import {
  agentBinaryProblem,
  isAgentUserMode,
  isHostedAgentProcess,
  spawnAgentProcess,
  type AgentProcess,
} from './spawner'
import { resolveWindowsSpawn, type WinSpawnPlan } from './winSpawn'

/**
 * Every spawned runtime child that is still running.
 *
 * Children are spawned `detached` (POSIX) so `abort()` can signal the whole
 * process group, and they are deliberately never `unref`'d. That means a server
 * exit does NOT take them with it: without this registry a Ctrl-C or crash leaves
 * an agent CLI running against a task worktree, still burning provider spend,
 * while boot-time reconciliation releases that task for another runner to claim —
 * two live runs on one worktree.
 */
const liveChildren = new Set<AgentProcess>()

/**
 * Connector children, tracked by PID because we never hold their handle.
 *
 * The MCP SDK's stdio transport owns the ChildProcess and exposes only `.pid`,
 * and its own `close()` signals just that direct process -- which for an
 * `npx -y <pkg>` launch is a wrapper, leaving the real server orphaned. Tracking
 * the pid here puts connectors into the SAME awaited shutdown as every other
 * spawned child, rather than into `cleanup()`, which runs after the wait and is
 * followed immediately by `process.exit(0)` -- killing the SIGKILL escalation
 * timer with the process, which is the exact failure this registry was written
 * to prevent for runtime children.
 */
const liveConnectorPids = new Set<number>()

/**
 * Also write a runtime child into the durable pid record until it closes.
 *
 * Both registries above live in memory, so they only help a shutdown that gets
 * to run. An engine that is force-killed or crashes leaves its children running,
 * and the record (`runtimePidFile.ts`) is how the next boot finds and reaps them.
 */
function recordUntilClose(child: AgentProcess): void {
  // A process the agent host started is the agent user's: this server could not
  // signal it from a record, and the boot reap in that mode stops every process
  // of the agent user instead (agentUser/stop.ts).
  if (isHostedAgentProcess(child)) return
  if (!child.pid) return
  const forget = recordRuntimePid(
    child.pid,
    child.spawnfile ? path.basename(child.spawnfile) : undefined,
  )
  child.once('close', forget)
}

/**
 * Track a child spawned by a LOCAL TOOL so shutdown reaps its whole tree.
 *
 * `liveChildren` is module-private, and every existing writer is a runtime
 * launcher in this file. A tool that spawns its own child would therefore be
 * invisible to `killLiveSubprocesses`, and would survive a Ctrl-C, a self
 * restart, and the shutdown wait that exists precisely to stop a child outliving
 * the server. That is the failure class this registry was written to prevent, so
 * a new spawner joins it rather than keeping its own.
 *
 * Handle-based, unlike `registerConnectorPid`: a local tool owns its
 * `ChildProcess` outright, so the richer `killProcessTree` is available and the
 * pid-only path is unnecessary.
 */
export function registerRuntimeChild(child: AgentProcess): void {
  // Before the shutdown check: a late registrant is only signalled below, and if
  // it outlives this process the next boot still has its pid.
  recordUntilClose(child)
  // Shutdown has already taken its snapshot, so a late registrant would outlive
  // the server. Kill it on arrival, exactly as a late connector pid is.
  if (shuttingDown) {
    killProcessTree(child)
    return
  }
  liveChildren.add(child)
}

/** Stop tracking a local-tool child that closed cleanly. */
export function unregisterRuntimeChild(child: AgentProcess): void {
  liveChildren.delete(child)
}

/** Track a connector child so shutdown reaps its whole tree. */
export function registerConnectorPid(pid: number | null | undefined): void {
  if (typeof pid !== 'number' || pid <= 0) return
  // Shutdown has already taken its snapshot, so a late registrant would outlive
  // the server. Kill it on arrival instead, exactly as a late ChildProcess is.
  if (shuttingDown) {
    killProcessTreeByPid(pid)
    return
  }
  liveConnectorPids.add(pid)
}

/** Stop tracking a connector child that closed cleanly. */
export function unregisterConnectorPid(pid: number | null | undefined): void {
  if (typeof pid === 'number') liveConnectorPids.delete(pid)
}

/** Whether a pid is still alive. `kill(pid, 0)` signals nothing and throws ESRCH
 *  when the process is gone, which is the only handle-free liveness test. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * Set once shutdown has begun. A run that spawns after this point is killed as
 * soon as it registers: shutdown has already taken its snapshot, so an unsignalled
 * late child would otherwise outlive the server.
 */
let shuttingDown = false

/** Whether the server has begun shutting down: a supervisor must not restart a
 *  child that shutdown is about to stop. */
export function isSubprocessShutdown(): boolean {
  return shuttingDown
}

/**
 * Kill every still-running runtime child. Called from the server's shutdown path
 * so a graceful stop doesn't orphan agent processes. Best-effort and synchronous:
 * it runs inside a signal handler, just before `process.exit`.
 */
export function killLiveSubprocesses(): number {
  // `true`, not `false`. The flag exists so a run that spawns AFTER shutdown
  // begins is killed the moment it registers (see the registration guard). This
  // function runs from the synchronous 'exit' hook, i.e. AFTER the async
  // graceful path: clearing the flag here re-opened the exact window the flag
  // was added to close, letting a late child outlive the server.
  shuttingDown = true
  const count = liveChildren.size + liveConnectorPids.size
  for (const child of liveChildren) {
    try {
      killProcessTree(child)
    } catch {
      // Best effort — one stubborn child must not block the rest of shutdown.
    }
  }
  for (const pid of liveConnectorPids) {
    try {
      killProcessTreeByPid(pid)
    } catch {
      /* best effort */
    }
  }
  liveChildren.clear()
  liveConnectorPids.clear()
  return count
}

/**
 * How long shutdown waits for signalled children to actually die.
 *
 * Must exceed `killTree`'s SIGTERM→SIGKILL grace (3s): exiting sooner would kill
 * the escalation timer before it fires, leaving a child that ignores SIGTERM
 * running after the server is gone.
 */
export const SHUTDOWN_WAIT_MS = 5_000

/**
 * Signal every live runtime child and WAIT for it to exit (bounded).
 *
 * `killLiveSubprocesses` only sends SIGTERM; `killProcessTree` then schedules a
 * SIGKILL escalation on a timer. A signal handler that calls `process.exit(0)`
 * immediately afterwards kills that timer with the process, so a child ignoring
 * SIGTERM survives. Awaiting here gives the escalation room to run.
 *
 * Bounded by design: a hung child must never prevent the server from exiting, so
 * the wait resolves on the deadline regardless. Never rejects.
 */
export async function shutdownLiveSubprocesses(
  timeoutMs: number = SHUTDOWN_WAIT_MS,
): Promise<{ signalled: number; exited: number }> {
  shuttingDown = true
  const children = [...liveChildren]
  const pids = [...liveConnectorPids]
  if (children.length === 0 && pids.length === 0) return { signalled: 0, exited: 0 }

  for (const child of children) {
    try {
      killProcessTree(child)
    } catch {
      // Best effort — one stubborn child must not block the rest of shutdown.
    }
  }
  for (const pid of pids) {
    try {
      killProcessTreeByPid(pid)
    } catch {
      /* best effort */
    }
  }

  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs)
    // Never let the deadline itself hold the event loop open.
    timer.unref?.()
  })
  // A connector has no handle and therefore no 'close' event, so its exit is
  // POLLED. 50ms is short enough to add nothing meaningful to shutdown and long
  // enough that the loop is not a spin.
  const pollDeadline = Date.now() + timeoutMs
  const pidsGone = (async () => {
    // Bounded by the SAME deadline the race uses. An unbounded loop would keep
    // chaining timers for a pid that never dies, holding the event loop open
    // long after the deadline had already won and the server tried to exit.
    while (pids.some(isAlive) && Date.now() < pollDeadline) {
      await new Promise((r) => {
        const handle = setTimeout(r, 50)
        handle.unref?.()
      })
    }
  })()

  const allClosed = Promise.all([
    ...children.map((child) =>
      // Already reaped (its 'close' fired) — nothing left to await.
      child.exitCode !== null || child.signalCode !== null
        ? Promise.resolve()
        : new Promise<void>((resolve) => child.once('close', () => resolve())),
    ),
    pidsGone,
  ]).then(() => undefined)

  try {
    await Promise.race([allClosed, deadline])
  } finally {
    if (timer) clearTimeout(timer)
  }

  // Untrack only what this pass signalled. A child that registered during the wait
  // was killed on registration but stays tracked, so the synchronous fallback in
  // `cleanup()` still sees it rather than it vanishing from the registry.
  const exited =
    children.reduce((n, c) => n + (liveChildren.has(c) ? 0 : 1), 0) +
    pids.reduce((n, pid) => n + (isAlive(pid) ? 0 : 1), 0)
  for (const child of children) liveChildren.delete(child)
  for (const pid of pids) liveConnectorPids.delete(pid)
  return { signalled: children.length + pids.length, exited }
}

export interface ResolvedSpawn {
  command: string
  args: string[]
  cwd?: string | null
  env?: Record<string, string>
}

export interface SpawnDriverConfig<N> {
  /** Async prep (write isolated config/home, build argv) run once on `start()`. */
  resolve: () => Promise<ResolvedSpawn>
  /** Parse one stdout line into zero+ native events. */
  parseLine: (line: string) => N[]
  /** Synthesize the terminal native event(s) when the process exits. `signal` is
   *  the kill signal when the process was terminated by one (SIGTERM/SIGKILL on a
   *  deliberate abort) — drivers map that to a `done:aborted` terminal. */
  onClose: (
    code: number | null,
    signal: NodeJS.Signals | null,
    stdout: string,
    stderr: string,
  ) => N[]
  /** A liveness event pushed every `everyMs` from the first spawn until the run
   *  ends, for a CLI that prints nothing until it exits. It says the process is
   *  alive, not that it is making progress, so it stops after `maxMs`: from then
   *  on the host's silence limits apply again and can stop a hung process. */
  heartbeat?: { everyMs: number; maxMs: number; event: () => N }
}

export interface SpawnDriver<N> {
  start(): Promise<void>
  onEvent(handler: (ev: N) => void): () => void
  abort(): Promise<void>
  setModel(model: string): Promise<void>
  writeContext(key: string, value: string): Promise<void>
  /**
   * Replace the running process with another one INSIDE THIS RUN: stop the
   * current process, wait for it to exit, then spawn the one `next` resolves.
   * The stopped process's exit is absorbed (no `onClose` terminal, its unparsed
   * output dropped), so whoever is reading the event stream sees one run that
   * carries on. This is how a one-shot CLI is steered: stop it, resume the same
   * session with new input.
   *
   * Resolves false, replacing nothing, when there is no process to replace (never
   * started, already exited, or aborted). If an abort lands while the old process
   * is stopping, the run ends there with an aborted terminal. If `next` throws or
   * the replacement cannot be spawned, the run ends with that error.
   */
  relaunch(next: () => Promise<ResolvedSpawn>): Promise<boolean>
}

/**
 * Every driver's `writeContext`: a file the run reads, under its working folder.
 *
 * That folder is agent space (a task worktree or a team folder), so the write
 * goes through the agent-space file verbs: with agents on their own OS user the
 * agent host makes it, and either way a link planted at the file's path is
 * replaced, never followed. A missing parent is made; one that exists keeps its
 * mode (a team folder is owner-only). The modes are what a plain write gets
 * under the usual umask.
 */
export async function writeRunContextFile(cwd: string, key: string, value: string): Promise<void> {
  const target = path.join(cwd, key)
  const dir = path.dirname(target)
  if (!(await agentStat(dir))) await agentMkdir(dir, { mode: 0o755 })
  await agentWriteFile(target, value, { mode: 0o644 })
}

/** How long a relaunch waits for the stopped process to exit. `killProcessTree`
 *  escalates to SIGKILL after 3s, so this only bounds a process that survives even
 *  that. */
const RELAUNCH_EXIT_WAIT_MS = 10_000

export function createSpawnDriver<N>(cfg: SpawnDriverConfig<N>): SpawnDriver<N> {
  const handlers = new Set<(ev: N) => void>()
  const buffered: N[] = []
  let subscribed = false
  let started = false
  let child: ChildProcess | null = null
  let cwd: string | null = null
  let stdoutAll = ''
  let stderrAll = ''
  /** Bumped by a relaunch, so the process it replaces closes into nothing. */
  let generation = 0
  /** The current process has exited and its terminal was produced. */
  let exited = false
  let abortRequested = false

  const push = (ev: N): void => {
    if (!subscribed) {
      buffered.push(ev)
      return
    }
    for (const h of [...handlers]) h(ev)
  }

  let beat: ReturnType<typeof setInterval> | null = null
  const stopHeartbeat = (): void => {
    if (beat) clearInterval(beat)
    beat = null
  }
  const startHeartbeat = (): void => {
    if (!cfg.heartbeat || beat || exited) return
    const { everyMs, maxMs, event } = cfg.heartbeat
    const until = Date.now() + maxMs
    beat = setInterval(() => {
      if (exited || Date.now() > until) stopHeartbeat()
      else push(event())
    }, everyMs)
    // Never let the heartbeat itself hold the event loop open.
    beat.unref?.()
  }

  /** End the run with the driver's own terminal for a non-exit reason. */
  const endWith = (code: number | null, signal: NodeJS.Signals | null, stderr: string): void => {
    exited = true
    stopHeartbeat()
    for (const ev of cfg.onClose(code, signal, stdoutAll, stderr)) push(ev)
  }

  /** Plan + spawn one process for the current generation. */
  /** Start the process; false when the run ended without one. */
  function launch(resolved: ResolvedSpawn): boolean {
    let plan: WinSpawnPlan
    try {
      // Planning REFUSES a Windows shim path that cmd.exe would substitute before
      // quotes take effect (`%` or `!`), and that refusal has to end the run the
      // way a failed resolve does.
      plan = resolveWindowsSpawn({ command: resolved.command, args: resolved.args })
    } catch (err) {
      endWith(null, null, err instanceof Error ? err.message : String(err))
      return false
    }
    const gen = generation
    cwd = resolved.cwd ?? null
    stdoutAll = ''
    stderrAll = ''
    // A binary the startup check found the agent user cannot run starts no
    // process: the run ends here, as a refused start does, and says so.
    const unavailable = isAgentUserMode() ? agentBinaryProblem(plan.command) : null
    if (unavailable) {
      endWith(null, null, `not available to the agent user: ${unavailable}`)
      return false
    }
    let spawned: ChildProcess
    try {
      // NEVER a shell (the seam has none): an untrusted prompt is passed as argv.
      // The Windows .cmd/.bat case is handled by resolveWindowsSpawn (cmd.exe +
      // escaping). With agents on their own OS user the agent host starts it.
      spawned = spawnAgentProcess({
        kind: 'runtime',
        command: plan.command,
        args: plan.args,
        ...(resolved.cwd != null ? { cwd: resolved.cwd } : {}),
        // Scrub clawboo's own server secrets before the untrusted agent subprocess
        // inherits them; the runtime's granted keys (resolved.env) are merged on top.
        env: buildChildEnv(resolved.env),
        windowsHide: isWindows,
        // POSIX: become a process-group leader so abort() can SIGTERM the whole
        // tree (the CLI may spawn grandchildren). We never unref: the run is
        // tracked + killed explicitly. (No effect on Windows; tree-kill there is
        // taskkill /T.)
        detached: !isWindows,
        ...(plan.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (err) {
      // A start refused before any process exists (the agent host is down)
      // ends the run the way a failed resolve does, so it still gets a terminal.
      endWith(null, null, err instanceof Error ? err.message : String(err))
      return false
    }
    child = spawned
    // Track it so a server shutdown can reap it instead of orphaning it.
    // (Deregistered in the 'close' handler below.)
    liveChildren.add(spawned)
    recordUntilClose(spawned)
    if (shuttingDown) {
      // Spawned after shutdown began — it missed the snapshot, so signal it now
      // rather than let it run on past process exit.
      try {
        killProcessTree(spawned)
      } catch {
        // Best effort — it may already be gone.
      }
    }
    let buf = ''
    const current = (): boolean => gen === generation
    spawned.stdout?.on('data', (d: Buffer) => {
      if (!current()) return
      const s = d.toString()
      stdoutAll += s
      buf += s
      let nl: number
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl)
        buf = buf.slice(nl + 1)
        if (line.trim()) for (const ev of cfg.parseLine(line)) push(ev)
      }
    })
    spawned.stderr?.on('data', (d: Buffer) => {
      if (current()) stderrAll += d.toString()
    })
    spawned.on('error', (err: Error) => {
      if (!current()) return
      stopHeartbeat()
      for (const ev of cfg.onClose(null, null, stdoutAll, `${stderrAll}\n${err.message}`)) push(ev)
    })
    spawned.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      // No longer running — drop it from the shutdown-reap registry.
      liveChildren.delete(spawned)
      // A relaunched-away process ends silently: the run goes on without it.
      if (!current()) return
      exited = true
      stopHeartbeat()
      if (buf.trim()) for (const ev of cfg.parseLine(buf)) push(ev)
      // A process we asked to stop is reported as stopped however it went: a CLI
      // that traps SIGTERM exits with a code of its own (hermes -q unwinds via
      // KeyboardInterrupt), which would otherwise read as a failure.
      const stoppedBy = abortRequested ? (signal ?? 'SIGTERM') : signal
      for (const ev of cfg.onClose(code, stoppedBy, stdoutAll, stderrAll)) push(ev)
    })
    return true
  }

  return {
    async start(): Promise<void> {
      if (started) return
      started = true
      let resolved: ResolvedSpawn
      try {
        resolved = await cfg.resolve()
      } catch (err) {
        endWith(null, null, err instanceof Error ? err.message : String(err))
        return
      }
      launch(resolved)
      startHeartbeat()
    },

    onEvent(handler: (ev: N) => void): () => void {
      handlers.add(handler)
      if (!subscribed) {
        subscribed = true
        const pending = buffered.splice(0)
        for (const ev of pending) handler(ev)
      }
      return () => handlers.delete(handler)
    },

    async abort(): Promise<void> {
      abortRequested = true
      // Kill the whole process tree (SIGTERM → SIGKILL escalation), not just the
      // direct child — codex/hermes grandchildren would otherwise survive.
      killProcessTree(child)
    },

    async setModel(): Promise<void> {
      // These CLIs fix the model at spawn time — no mid-run switch.
    },

    async writeContext(key: string, value: string): Promise<void> {
      if (!cwd) return
      await writeRunContextFile(cwd, key, value)
    },

    async relaunch(next: () => Promise<ResolvedSpawn>): Promise<boolean> {
      const old = child
      if (!old || exited || abortRequested) return false
      // From here the old process belongs to no one: its exit is absorbed.
      generation += 1
      const gone =
        old.exitCode !== null || old.signalCode !== null
          ? Promise.resolve()
          : new Promise<void>((resolve) => {
              old.once('close', () => resolve())
              const timer = setTimeout(resolve, RELAUNCH_EXIT_WAIT_MS)
              ;(timer as { unref?: () => void }).unref?.()
            })
      killProcessTree(old)
      await gone
      if (abortRequested) {
        // Stopped while it was being replaced: that is the run's end.
        endWith(null, 'SIGTERM', stderrAll)
        return false
      }
      let resolved: ResolvedSpawn
      try {
        resolved = await next()
      } catch (err) {
        endWith(null, null, err instanceof Error ? err.message : String(err))
        throw err
      }
      if (abortRequested) {
        endWith(null, 'SIGTERM', stderrAll)
        return false
      }
      // A process that could not start ended the run: the relaunch did not happen.
      return launch(resolved)
    },
  }
}
