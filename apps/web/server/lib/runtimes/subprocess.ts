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
import { killProcessTree } from './killTree'
import { resolveWindowsSpawn } from './winSpawn'

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
