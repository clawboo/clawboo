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

import { spawn, type ChildProcess } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { isWindows } from '../platform'
import { buildChildEnv } from './childEnv'
import { killProcessTree, killProcessTreeByPid } from './killTree'
import { resolveWindowsSpawn } from './winSpawn'

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
const liveChildren = new Set<ChildProcess>()

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
}

export interface SpawnDriver<N> {
  start(): Promise<void>
  onEvent(handler: (ev: N) => void): () => void
  abort(): Promise<void>
  setModel(model: string): Promise<void>
  writeContext(key: string, value: string): Promise<void>
}

export function createSpawnDriver<N>(cfg: SpawnDriverConfig<N>): SpawnDriver<N> {
  const handlers = new Set<(ev: N) => void>()
  const buffered: N[] = []
  let subscribed = false
  let started = false
  let child: ChildProcess | null = null
  let cwd: string | null = null
  let stdoutAll = ''
  let stderrAll = ''

  const push = (ev: N): void => {
    if (!subscribed) {
      buffered.push(ev)
      return
    }
    for (const h of [...handlers]) h(ev)
  }

  return {
    async start(): Promise<void> {
      if (started) return
      started = true
      let resolved: ResolvedSpawn
      try {
        resolved = await cfg.resolve()
      } catch (err) {
        for (const ev of cfg.onClose(
          null,
          null,
          '',
          err instanceof Error ? err.message : String(err),
        ))
          push(ev)
        return
      }
      cwd = resolved.cwd ?? null
      const plan = resolveWindowsSpawn({ command: resolved.command, args: resolved.args })
      child = spawn(plan.command, plan.args, {
        cwd: resolved.cwd ?? undefined,
        // Scrub clawboo's own server secrets before the untrusted agent subprocess
        // inherits them; the runtime's granted keys (resolved.env) are merged on top.
        env: buildChildEnv(resolved.env),
        // NEVER shell:true — an untrusted prompt is passed as argv. The Windows
        // .cmd/.bat case is handled by resolveWindowsSpawn (cmd.exe + escaping).
        shell: false,
        windowsHide: isWindows,
        // POSIX: become a process-group leader so abort() can SIGTERM the whole
        // tree (the CLI may spawn grandchildren). We never unref — the run is
        // tracked + killed explicitly. (No effect on Windows; tree-kill there is
        // taskkill /T.)
        detached: !isWindows,
        ...(plan.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      // Track it so a server shutdown can reap it instead of orphaning it.
      // (Deregistered in the 'close' handler below.)
      liveChildren.add(child)
      if (shuttingDown) {
        // Spawned after shutdown began — it missed the snapshot, so signal it now
        // rather than let it run on past process exit.
        try {
          killProcessTree(child)
        } catch {
          // Best effort — it may already be gone.
        }
      }
      const spawned = child
      let buf = ''
      child.stdout?.on('data', (d: Buffer) => {
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
      child.stderr?.on('data', (d: Buffer) => {
        stderrAll += d.toString()
      })
      child.on('error', (err: Error) => {
        for (const ev of cfg.onClose(null, null, stdoutAll, `${stderrAll}\n${err.message}`))
          push(ev)
      })
      child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
        // No longer running — drop it from the shutdown-reap registry.
        liveChildren.delete(spawned)
        if (buf.trim()) for (const ev of cfg.parseLine(buf)) push(ev)
        for (const ev of cfg.onClose(code, signal, stdoutAll, stderrAll)) push(ev)
      })
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
      // Kill the whole process tree (SIGTERM → SIGKILL escalation), not just the
      // direct child — codex/hermes grandchildren would otherwise survive.
      killProcessTree(child)
    },

    async setModel(): Promise<void> {
      // These CLIs fix the model at spawn time — no mid-run switch.
    },

    async writeContext(key: string, value: string): Promise<void> {
      if (!cwd) return
      const target = path.join(cwd, key)
      await mkdir(path.dirname(target), { recursive: true })
      await writeFile(target, value, 'utf8')
    },
  }
}
