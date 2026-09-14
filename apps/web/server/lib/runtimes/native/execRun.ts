// Running one approved command, and killing it when the run stops.
//
// SEPARATED FROM THE TOOL so the spawning can be tested without an approval and
// the approval can be tested without spawning. Nothing here decides whether a
// command may run; by the time this is called a human has already said yes.
//
// FOUR THINGS THIS GETS RIGHT THAT THE OBVIOUS VERSION DOES NOT.
//
//  1. `spawn`, never `execFile`. Node's `execFile` has a 1 MB `maxBuffer` and
//     KILLS the child when it is exceeded, rejecting rather than truncating. A
//     command that succeeded and was merely chatty would be reported as a
//     failure, which is the most confusing possible outcome for an operator who
//     just approved it.
//  2. The child joins the shutdown registry. `liveChildren` is what
//     `killLiveSubprocesses` reaps, and a child outside it survives a Ctrl-C and
//     a self restart.
//  3. The kill escalation is cleared on `close`, not `exit`. `killTree.ts`
//     documents why: clearing on `exit` cancels the SIGKILL escalation while a
//     SIGTERM-trapping grandchild is still alive.
//  4. The environment is an ALLOWLIST. `connectorChildEnv()` is the one written
//     for handing a subprocess to code we did not write. The ambient environment
//     of this server holds provider API keys, so an approved `printenv` would
//     otherwise return them to the model.

import { spawn, type ChildProcess } from 'node:child_process'

import { connectorChildEnv } from '@clawboo/mcp'

import { killProcessTree } from '../killTree'
import { registerRuntimeChild, unregisterRuntimeChild } from '../subprocess'

/** How long an approved command may run before it is killed. */
export const DEFAULT_COMMAND_TIMEOUT_MS = 300_000

/**
 * How much output is kept.
 *
 * Matches the file tools' read cap. Output goes straight into the model's
 * context, so this is a context-budget decision as much as a memory one.
 */
export const OUTPUT_CAP_BYTES = 64 * 1024

export interface ExecRunResult {
  /** Combined stdout and stderr, in arrival order, capped. */
  output: string
  exitCode: number | null
  signal: NodeJS.Signals | null
  /** True when the cap was hit and the tail was dropped. */
  truncated: boolean
  /** Set when the command was stopped rather than finishing on its own. */
  stoppedBy?: 'timeout' | 'abort'
}

export interface ExecRunOptions {
  argv: string[]
  cwd: string
  signal: AbortSignal
  timeoutMs?: number
  /** Injected in tests. Defaults to the allowlisted connector environment. */
  env?: Record<string, string>
  /**
   * Injected in tests. Defaults to `OUTPUT_CAP_BYTES`.
   *
   * Overridable because the partial-chunk path is otherwise unreachable: a pipe
   * hands over 64KB chunks and the cap is 64KB, so the straddling branch lands
   * exactly equal and never fires. A smaller cap in a test is the only way to
   * cover the half-kept-chunk case.
   */
  capBytes?: number
}

/**
 * Run an already-approved command to completion, a timeout, or an abort.
 *
 * NEVER REJECTS on a non-zero exit: a command that fails is a result, not an
 * error, and the model needs the output either way. It rejects only when the
 * process could not be started at all.
 */
export async function runApprovedCommand(opts: ExecRunOptions): Promise<ExecRunResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS
  const [program, ...args] = opts.argv

  // CHECKED BEFORE THE SPAWN, not after. Spawning and then killing lets a fast
  // command complete its side effect before the kill lands, so an aborted run
  // could still delete a file. The post-spawn check below stays as well, for an
  // abort that arrives during the spawn itself.
  if (opts.signal.aborted) {
    return { output: '', exitCode: null, signal: null, truncated: false, stoppedBy: 'abort' }
  }

  return await new Promise<ExecRunResult>((resolve, reject) => {
    let child: ChildProcess
    try {
      child = spawn(program ?? '', args, {
        cwd: opts.cwd,
        env: opts.env ?? connectorChildEnv(),
        // NEVER true. `shell: true` would hand the argv back to a shell for
        // re-parsing, which is the exact property this tier exists to refuse.
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        // Detached so the kill can take the whole process group: a child that
        // spawns its own children would otherwise leave them behind.
        detached: true,
      })
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)))
      return
    }

    registerRuntimeChild(child)

    const cap = opts.capBytes ?? OUTPUT_CAP_BYTES
    const chunks: Buffer[] = []
    let bytes = 0
    let truncated = false
    let stoppedBy: 'timeout' | 'abort' | undefined
    let settled = false

    const collect = (buf: Buffer): void => {
      if (bytes >= cap) {
        truncated = true
        return
      }
      const room = cap - bytes
      if (buf.length > room) {
        chunks.push(buf.subarray(0, room))
        bytes = cap
        truncated = true
        // The child is NOT killed for being chatty. It may be most of the way
        // through real work, and the operator approved that work.
        return
      }
      chunks.push(buf)
      bytes += buf.length
    }

    child.stdout?.on('data', collect)
    child.stderr?.on('data', collect)

    const stop = (why: 'timeout' | 'abort'): void => {
      if (settled) return
      stoppedBy = why
      killProcessTree(child)
    }

    const timer = setTimeout(() => stop('timeout'), timeoutMs)
    timer.unref()

    const onAbort = (): void => stop('abort')
    opts.signal.addEventListener('abort', onAbort, { once: true })
    // The run may already have been stopped between approval and spawn.
    if (opts.signal.aborted) stop('abort')

    const cleanup = (): void => {
      clearTimeout(timer)
      opts.signal.removeEventListener('abort', onAbort)
      unregisterRuntimeChild(child)
    }

    // `close` rather than `exit`: exit fires when the process ends, close when
    // its stdio has drained. Settling on exit loses the tail of the output.
    child.on('close', (code, sig) => {
      if (settled) return
      settled = true
      cleanup()
      resolve({
        output: Buffer.concat(chunks).toString('utf8'),
        exitCode: code,
        signal: sig,
        truncated,
        ...(stoppedBy ? { stoppedBy } : {}),
      })
    })

    child.on('error', (err) => {
      if (settled) return
      settled = true
      cleanup()
      reject(err)
    })
  })
}
