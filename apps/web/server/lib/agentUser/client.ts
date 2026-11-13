// The server's side of the agent host connection.
//
// Everything that arrives from the host is data from the agents' side: each
// line is bounded (`MAX_FRAME_CHARS`), parsed as JSON and checked for the
// fields it is used for. A line that is not a frame is ignored; a line too long
// to be one ends the connection, as does a host that stops answering.

import { spawn, type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import net from 'node:net'
import { PassThrough, Writable, type Readable } from 'node:stream'

import {
  AGENT_HOST_PROTOCOL_VERSION,
  createLineSplitter,
  encodeFrame,
  parseFrame,
  type HelloFrame,
  type HostOp,
  type HostReplies,
  type HostRequest,
  type ServerToHostFrame,
  type StdioMode,
} from './protocol'

/** A connection to the host: frames in, frames out. */
export interface HostTransport {
  /** Frames from the host. */
  input: Readable
  /** Frames to the host. */
  output: NodeJS.WritableStream
  /** End the connection (and, for a host the server started, the host). */
  close(): void
  /** The host's own complaints, for an error message (sudo's "a password is required"). */
  diagnostics?(): string
}

/** A host error: what failed, with the code the host reported. */
export class AgentHostError extends Error {
  readonly code: string
  constructor(message: string, code = 'EHOST') {
    super(message)
    this.name = 'AgentHostError'
    this.code = code
  }
}

/** What a started process is asked to look like (see `spawner.ts`). */
export interface RemoteSpawnOptions {
  command: string
  args: readonly string[]
  cwd?: string
  env: Record<string, string>
  stdio: readonly [StdioMode, StdioMode, StdioMode]
  group: boolean
  signal?: AbortSignal
}

let procSeq = 0

/**
 * A process the host started, shaped like a `ChildProcess`: `pid`, the three
 * streams, `exitCode`, `signalCode`, `kill`, and the `spawn`, `error`, `exit`
 * and `close` events in the order Node emits them.
 *
 * `kill()` asks the host to signal it, because the server cannot signal a
 * process of another user. `pid` is set once the host has started it.
 */
export class RemoteAgentProcess extends EventEmitter {
  readonly id: string
  pid: number | undefined = undefined
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  killed = false
  readonly spawnfile: string
  readonly spawnargs: string[]
  readonly stdin: Writable | null
  readonly stdout: PassThrough | null
  readonly stderr: PassThrough | null
  /** Set by the client when the process is done, so late frames are dropped. */
  closed = false
  /** @internal The host was asked to hold this process's output. */
  held = false
  private readonly client: AgentHostClient
  private readonly group: boolean

  constructor(client: AgentHostClient, opts: RemoteSpawnOptions) {
    super()
    this.client = client
    this.group = opts.group
    this.id = `p${++procSeq}`
    this.spawnfile = opts.command
    this.spawnargs = [opts.command, ...opts.args]
    this.stdout = opts.stdio[1] === 'pipe' ? new PassThrough() : null
    this.stderr = opts.stdio[2] === 'pipe' ? new PassThrough() : null
    const id = this.id
    this.stdin =
      opts.stdio[0] === 'pipe'
        ? new Writable({
            write(chunk: Buffer | string, enc, cb) {
              const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, enc)
              client.sendRaw({ t: 'in', proc: id, data: buf.toString('base64') })
              cb()
            },
            final(cb) {
              client.sendRaw({ t: 'in-end', proc: id })
              cb()
            },
          })
        : null
  }

  /** Signal the process (not its tree; `killProcessTree` asks for that). */
  kill(signal: NodeJS.Signals | number = 'SIGTERM'): boolean {
    const name = typeof signal === 'number' ? (signal === 9 ? 'SIGKILL' : 'SIGTERM') : signal
    if (this.closed || this.exitCode !== null || this.signalCode !== null) return false
    this.killed = true
    this.client.request({ op: 'signal', proc: this.id, signal: name }).catch(() => {
      /* the host is gone, and the process with it */
    })
    return true
  }

  /** Stop the process and everything it started (SIGTERM, then SIGKILL after `graceMs`). */
  killTree(graceMs = 3_000): void {
    // A group outlives its leader: a member with output of its own (a browser's
    // helper) can still run after this process closed, and the host keeps such
    // a group until it is empty. So ask even then, as `killProcessTree` signals
    // a local group whether or not its leader is gone. A process that never
    // started has no group.
    if (this.closed && (!this.group || this.pid === undefined)) return
    if (!this.closed) this.killed = true
    this.client.request({ op: 'killTree', proc: this.id, graceMs }).catch(() => {
      /* the host is gone, and the process with it */
    })
  }

  /** Mirrors ChildProcess: stdio, in fd order. */
  get stdio(): [Writable | null, Readable | null, Readable | null] {
    return [this.stdin, this.stdout, this.stderr]
  }

  ref(): void {}
  unref(): void {}

  /** @internal */
  _exit(code: number | null, signal: string | null): void {
    if (this.exitCode !== null || this.signalCode !== null) return
    this.exitCode = code
    this.signalCode = (signal as NodeJS.Signals | null) ?? null
    this.emit('exit', this.exitCode, this.signalCode)
  }

  /** @internal A process that never started: Node emits 'close' with the
   *  negative errno and no 'exit'. */
  _failedStart(): void {
    if (this.closed) return
    this.exitCode = -2
    this.closed = true
    this.stdout?.end()
    this.stderr?.end()
    setImmediate(() => this.emit('close', -2, null))
  }

  /** @internal */
  _close(code: number | null, signal: string | null): void {
    if (this.closed) return
    this._exit(code, signal)
    this.closed = true
    this.stdout?.end()
    this.stderr?.end()
    const finish = (): void => {
      this.emit('close', this.exitCode, this.signalCode)
    }
    // 'close' follows the end of both output streams, as Node's does.
    setImmediate(finish)
  }
}

interface Pending {
  resolve: (v: Record<string, unknown>) => void
  reject: (e: Error) => void
  timer: NodeJS.Timeout | null
}

/** The connection to one agent host. */
export class AgentHostClient {
  private readonly transport: HostTransport
  private readonly pending = new Map<number, Pending>()
  private readonly procs = new Map<string, RemoteAgentProcess>()
  private nextId = 1
  private closedReason: string | null = null
  private readonly closeHandlers = new Set<(reason: string) => void>()
  hello: HelloFrame | null = null
  private helloWaiters: { resolve: (h: HelloFrame) => void; reject: (e: Error) => void }[] = []

  constructor(transport: HostTransport) {
    this.transport = transport
    transport.input.setEncoding('utf8')
    const split = createLineSplitter(
      (line) => this.onLine(line),
      () => this.shutdown('the agent host sent a line too long to be a frame'),
    )
    transport.input.on('data', (chunk: string) => split(chunk))
    transport.input.on('end', () => this.shutdown('the agent host closed the connection'))
    transport.input.on('close', () => this.shutdown('the agent host closed the connection'))
    transport.input.on('error', (err: Error) =>
      this.shutdown(`the agent host connection failed: ${err.message}`),
    )
    ;(transport.output as unknown as EventEmitter).on?.('error', () => {
      this.shutdown('the agent host stopped reading')
    })
  }

  /** Whether the connection is gone, and why. */
  get closed(): string | null {
    return this.closedReason
  }

  /** Wait for the host's first frame. */
  waitForHello(timeoutMs = 10_000): Promise<HelloFrame> {
    if (this.hello) return Promise.resolve(this.hello)
    if (this.closedReason) return Promise.reject(new AgentHostError(this.closedReason, 'ECLOSED'))
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(
          new AgentHostError(
            `the agent host did not answer within ${Math.round(timeoutMs / 1000)} s`,
            'ETIMEDOUT',
          ),
        )
      }, timeoutMs)
      timer.unref?.()
      this.helloWaiters.push({
        resolve: (h) => {
          clearTimeout(timer)
          resolve(h)
        },
        reject: (e) => {
          clearTimeout(timer)
          reject(e)
        },
      })
    })
  }

  onClose(handler: (reason: string) => void): () => void {
    this.closeHandlers.add(handler)
    return () => this.closeHandlers.delete(handler)
  }

  /** @internal Send a frame that has no reply. */
  sendRaw(frame: ServerToHostFrame): void {
    if (this.closedReason) return
    try {
      this.transport.output.write(encodeFrame(frame))
    } catch {
      this.shutdown('the agent host stopped reading')
    }
  }

  /** Send a request and wait for its reply. */
  request<R extends HostRequest>(
    req: R,
    opts: { timeoutMs?: number } = {},
  ): Promise<HostReplies[R['op'] & HostOp]> {
    return new Promise((resolve, reject) => {
      this.requestSync(
        req,
        resolve as (v: Record<string, unknown>) => void,
        reject,
        opts.timeoutMs ?? 30_000,
      )
    })
  }

  /**
   * Send a request whose reply is handled synchronously, as the frame is read.
   *
   * A spawn needs this: the host sends the spawn's reply and then the process's
   * first output, often in one chunk, and a promise would see the reply only
   * after that output had already been delivered.
   */
  private requestSync(
    req: HostRequest,
    resolve: (v: Record<string, unknown>) => void,
    reject: (e: Error) => void,
    timeoutMs: number,
  ): void {
    if (this.closedReason) {
      const reason = this.closedReason
      queueMicrotask(() => reject(new AgentHostError(reason, 'ECLOSED')))
      return
    }
    const id = this.nextId++
    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            this.pending.delete(id)
            reject(
              new AgentHostError(
                `the agent host did not answer ${req.op} within ${Math.round(timeoutMs / 1000)} s`,
                'ETIMEDOUT',
              ),
            )
          }, timeoutMs)
        : null
    timer?.unref?.()
    this.pending.set(id, { resolve, reject, timer })
    this.sendRaw({ t: 'req', id, ...req } as ServerToHostFrame)
  }

  /** Ask the host to start a process. Returns at once, like `child_process.spawn`. */
  spawn(opts: RemoteSpawnOptions): RemoteAgentProcess {
    const proc = new RemoteAgentProcess(this, opts)
    this.procs.set(proc.id, proc)
    const failStart = (err: Error): void => {
      if (proc.closed) return
      this.procs.delete(proc.id)
      proc.emit('error', err)
      proc._failedStart()
    }
    if (opts.signal?.aborted) {
      queueMicrotask(() => failStart(abortError()))
      return proc
    }
    this.requestSync(
      {
        op: 'spawn',
        proc: proc.id,
        command: opts.command,
        args: [...opts.args],
        ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
        env: opts.env,
        stdio: [opts.stdio[0], opts.stdio[1], opts.stdio[2]],
        group: opts.group,
      },
      (res) => {
        const pid = res['pid']
        if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) {
          failStart(new AgentHostError('the agent host started a process but sent no pid'))
          return
        }
        proc.pid = pid
        proc.emit('spawn')
      },
      (err: Error) => {
        const code = (err as AgentHostError).code ?? 'EHOST'
        failStart(
          Object.assign(new Error(`spawn ${opts.command} ${code}: ${err.message}`), {
            code,
            syscall: `spawn ${opts.command}`,
            path: opts.command,
          }),
        )
      },
      // Starting a process is quick; a slow answer means the host is stuck.
      30_000,
    )
    if (opts.signal) {
      const onAbort = (): void => {
        if (proc.closed) return
        proc.killTree()
        proc.emit('error', abortError())
      }
      opts.signal.addEventListener('abort', onAbort, { once: true })
      proc.once('close', () => opts.signal?.removeEventListener('abort', onAbort))
    }
    return proc
  }

  /** Whether the host answers a ping within `timeoutMs`. */
  async ping(timeoutMs = 5_000): Promise<boolean> {
    try {
      await this.request({ op: 'ping' }, { timeoutMs })
      return true
    } catch {
      return false
    }
  }

  /**
   * Ping every `everyMs`; call `onDead` once if a ping goes unanswered for
   * `deadMs` or the connection drops. Returns a stop function.
   */
  watch(
    onDead: (reason: string) => void,
    opts: { everyMs?: number; deadMs?: number } = {},
  ): () => void {
    let fired = false
    const fire = (reason: string): void => {
      if (fired) return
      fired = true
      clearInterval(timer)
      off()
      onDead(reason)
    }
    const off = this.onClose((reason) => fire(reason))
    let inFlight = false
    const timer = setInterval(() => {
      if (inFlight || fired) return
      inFlight = true
      void this.ping(opts.deadMs ?? 5_000).then((ok) => {
        inFlight = false
        if (!ok) fire('the agent host stopped answering')
      })
    }, opts.everyMs ?? 2_000)
    timer.unref?.()
    return () => {
      fired = true
      clearInterval(timer)
      off()
    }
  }

  /** End the connection. */
  close(reason = 'closed by the server'): void {
    this.shutdown(reason)
    try {
      this.transport.close()
    } catch {
      /* already gone */
    }
  }

  private shutdown(reason: string): void {
    if (this.closedReason) return
    this.closedReason = reason
    const diag = this.transport.diagnostics?.().trim()
    const full = diag ? `${reason}: ${diag}` : reason
    for (const w of this.helloWaiters) w.reject(new AgentHostError(full, 'ECLOSED'))
    this.helloWaiters = []
    for (const [id, p] of this.pending) {
      if (p.timer) clearTimeout(p.timer)
      p.reject(new AgentHostError(full, 'ECLOSED'))
      this.pending.delete(id)
    }
    // Every process the host started is gone with it (the host stops them when
    // the connection ends, and the server's stop pass covers a host that died).
    for (const proc of this.procs.values()) proc._close(null, 'SIGKILL')
    this.procs.clear()
    for (const h of this.closeHandlers) {
      try {
        h(full)
      } catch {
        /* one handler must not stop the others */
      }
    }
  }

  private onLine(line: string): void {
    const f = parseFrame(line)
    if (!f) return
    switch (f['t']) {
      case 'hello': {
        if (this.hello) return
        const hello = parseHello(f)
        if (!hello) {
          this.shutdown('the agent host sent a malformed hello')
          return
        }
        if (hello.v !== AGENT_HOST_PROTOCOL_VERSION) {
          this.shutdown(
            `the agent host speaks protocol ${hello.v}, this server ${AGENT_HOST_PROTOCOL_VERSION}. Restart Clawboo so both come from one install`,
          )
          return
        }
        this.hello = hello
        for (const w of this.helloWaiters) w.resolve(hello)
        this.helloWaiters = []
        return
      }
      case 'res': {
        const id = f['id']
        if (typeof id !== 'number') return
        const p = this.pending.get(id)
        if (!p) return
        this.pending.delete(id)
        if (p.timer) clearTimeout(p.timer)
        if (f['ok'] === true) p.resolve(f)
        else {
          const code = typeof f['code'] === 'string' ? f['code'].slice(0, 40) : 'EHOST'
          const message = typeof f['message'] === 'string' ? f['message'].slice(0, 2000) : 'failed'
          p.reject(new AgentHostError(message, code))
        }
        return
      }
      case 'ev': {
        const proc = this.procs.get(String(f['proc'] ?? ''))
        if (!proc || proc.closed) return
        switch (f['ev']) {
          case 'out':
          case 'err': {
            const stream = f['ev'] === 'out' ? proc.stdout : proc.stderr
            if (!stream || typeof f['data'] !== 'string') return
            // A full buffer here holds the child on the host, as a full pipe
            // would: nothing is buffered without limit on either side.
            if (!stream.write(Buffer.from(f['data'], 'base64')) && !proc.held) {
              proc.held = true
              this.sendRaw({ t: 'pause', proc: proc.id })
              stream.once('drain', () => {
                proc.held = false
                this.sendRaw({ t: 'resume', proc: proc.id })
              })
            }
            return
          }
          case 'exit':
            proc._exit(numOrNull(f['code']), strOrNull(f['signal']))
            return
          case 'close':
            this.procs.delete(proc.id)
            proc._close(numOrNull(f['code']), strOrNull(f['signal']))
            return
          case 'error': {
            const code = typeof f['code'] === 'string' ? f['code'].slice(0, 40) : 'EHOST'
            const message =
              typeof f['message'] === 'string' ? f['message'].slice(0, 2000) : 'process error'
            proc.emit('error', Object.assign(new Error(message), { code }))
            return
          }
        }
      }
    }
  }
}

function numOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

function strOrNull(v: unknown): string | null {
  return typeof v === 'string' && /^SIG[A-Z0-9]{1,10}$/.test(v) ? v : null
}

function parseHello(f: Record<string, unknown>): HelloFrame | null {
  const num = (k: string): number | null =>
    typeof f[k] === 'number' && Number.isInteger(f[k]) ? (f[k] as number) : null
  const str = (k: string): string | null =>
    typeof f[k] === 'string' && (f[k] as string).length < 4096 ? (f[k] as string) : null
  const v = num('v')
  const uid = num('uid')
  const gid = num('gid')
  const pid = num('pid')
  const user = str('user')
  const home = str('home')
  const platform = str('platform')
  if (
    v === null ||
    uid === null ||
    gid === null ||
    pid === null ||
    user === null ||
    home === null ||
    platform === null
  ) {
    return null
  }
  return { t: 'hello', v, uid, gid, user, home, pid, platform }
}

function abortError(): Error {
  return Object.assign(new Error('The operation was aborted'), {
    name: 'AbortError',
    code: 'ABORT_ERR',
  })
}

// ── Starting or reaching the host ───────────────────────────────────────

/** How much of the switch's stderr is kept for an error message. */
const DIAG_CHARS = 4096

/**
 * Start the host as the agent user through sudo (or doas), talking over its
 * stdin and stdout.
 *
 * `-n` makes a missing rule a failure instead of a password prompt. sudo is
 * given a bare environment of its own (PATH and locale): a sudoers file that
 * keeps more of the environment than the default would otherwise hand the
 * server's to the agent host.
 */
export function startHostViaSwitch(opts: {
  user: string
  switch: 'sudo' | 'doas'
  node: string
  script: string
  /** A command the host is started under, such as `setpriv --no-new-privs`. */
  prefix?: string[]
  spawnImpl?: typeof spawn
}): { transport: HostTransport; child: ChildProcess } {
  const run = [...(opts.prefix ?? []), opts.node, opts.script]
  const args =
    opts.switch === 'sudo'
      ? ['-n', '-u', opts.user, '-H', '--', ...run]
      : ['-n', '-u', opts.user, '--', ...run]
  const child = (opts.spawnImpl ?? spawn)(opts.switch, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      PATH: process.env['PATH'] ?? '/usr/bin:/bin:/usr/sbin:/sbin',
      LANG: process.env['LANG'] ?? 'C.UTF-8',
    },
    shell: false,
  })
  let diag = ''
  child.stderr?.setEncoding('utf8')
  child.stderr?.on('data', (d: string) => {
    diag = (diag + d).slice(-DIAG_CHARS)
  })
  const input = child.stdout as Readable
  child.on('error', (err) => {
    diag = (diag + `\n${err.message}`).slice(-DIAG_CHARS)
    input.destroy()
  })
  return {
    child,
    transport: {
      input,
      output: child.stdin as NodeJS.WritableStream,
      close: () => {
        child.stdin?.end()
      },
      diagnostics: () => diag,
    },
  }
}

/** Reach a host a launcher started, on its Unix socket. */
export function connectHostSocket(socketPath: string): Promise<HostTransport> {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(socketPath)
    const onError = (err: Error): void => reject(err)
    sock.once('error', onError)
    sock.once('connect', () => {
      sock.off('error', onError)
      resolve({ input: sock, output: sock, close: () => sock.destroy() })
    })
  })
}
