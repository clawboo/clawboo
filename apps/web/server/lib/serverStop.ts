/**
 * apps/web/server/lib/serverStop.ts
 *
 * How the server is asked to stop: a signal (Ctrl+C, SIGTERM), or the app that
 * started it, over the IPC channel Node gives a child started with `fork()` or
 * with `'ipc'` in its `stdio`. Every way runs the same graceful stop: it ends the
 * agent runs, checkpoints SQLite and exits with code 0.
 *
 * - `{ type: 'shutdown' }` on the channel stops the server as SIGTERM does. On
 *   Windows a signal from another process ends the server at once, so this
 *   message is the only graceful stop an app has there.
 * - When the channel closes, the server stops the same way, but only when the app
 *   asked for that with `CLAWBOO_STOP_ON_DISCONNECT=1`. A crashed app then leaves
 *   no server behind.
 *
 * Why stopping on a closed channel is opt-in: the `clawboo` launcher starts the
 * server with `fork()`, which ALWAYS attaches a channel, then lets go of it and
 * exits so the server runs on in the background. That closes the channel the
 * moment the launcher returns. Stopping on it unasked would end every server the
 * launcher starts.
 *
 * The variable is read once and then taken out of this process's environment, so
 * nothing the server starts inherits it: an agent that runs `clawboo` would
 * otherwise hand it to a server that launcher starts, which would then stop as
 * soon as the launcher returned.
 *
 * A stop asked for while the server starts is KEPT, a signal as much as the
 * message (`watchStopSignals`, `watchEmbedderChannel`), and runs once the stop is
 * installed. The stop is installed before anything the server starts once it
 * listens (`installStopThenListen`), so a kept stop runs first and none of those
 * starts. No other part of the server listens for SIGINT or SIGTERM itself: a
 * one-shot listener that heard a signal during boot was spent, and its part was
 * never stopped by the real stop. The stop calls each part's own stop instead.
 */

/** Set to `1` by an app that wants the server to stop when its channel closes. */
export const STOP_ON_DISCONNECT_ENV = 'CLAWBOO_STOP_ON_DISCONNECT'

/** What asked the server to stop: the shutdown message, or the channel closing. */
export type ChannelStopReason = 'message' | 'disconnect'

/** The part of `process` the channel watch reads. Tests pass a stand-in. */
export interface IpcProcess {
  send?: unknown
  connected?: boolean
  /** Node's handle on the channel, which a listener makes keep the process alive. */
  channel?: { unref?: () => void } | null
  on(event: 'message', listener: (message: unknown) => void): unknown
  on(event: 'disconnect', listener: () => void): unknown
}

export interface EmbedderChannel {
  /** The server has an IPC channel at all. */
  readonly hasChannel: boolean
  /** It stops when the channel closes (the app set `CLAWBOO_STOP_ON_DISCONNECT=1`). */
  readonly stopOnDisconnect: boolean
  /**
   * Hand over the stop to run. A stop asked for before this (while the server
   * was still starting) runs now, once.
   */
  onStop(stop: (reason: ChannelStopReason) => void): void
}

/** `{ type: 'shutdown' }`, with or without other fields. */
export function isShutdownMessage(message: unknown): boolean {
  return (
    typeof message === 'object' &&
    message !== null &&
    (message as { type?: unknown }).type === 'shutdown'
  )
}

/**
 * Start listening on the channel, if there is one. Called before the server does
 * anything that waits, so no message or close is missed while it starts: the
 * server's bundle is CommonJS and loads synchronously, and Node delivers channel
 * messages only once the event loop turns.
 *
 * A stop asked for while the server starts is held until `onStop`. A server that
 * fails to start never gets there, so the listeners must not keep it alive: the
 * channel is let go of (it still delivers), and a running server is kept alive by
 * its own listening socket, so a failed start exits with code 1 as before.
 */
export function watchEmbedderChannel(proc: IpcProcess, env: NodeJS.ProcessEnv): EmbedderChannel {
  const optedIn = env[STOP_ON_DISCONNECT_ENV] === '1'
  delete env[STOP_ON_DISCONNECT_ENV]
  const hasChannel = typeof proc.send === 'function'

  let stop: ((reason: ChannelStopReason) => void) | null = null
  let pending: ChannelStopReason | null = null
  const request = (reason: ChannelStopReason): void => {
    if (stop) stop(reason)
    else pending ??= reason
  }

  if (hasChannel) {
    proc.on('message', (message) => {
      if (isShutdownMessage(message)) request('message')
    })
    if (optedIn) {
      proc.on('disconnect', () => request('disconnect'))
      // Closed before this ran: the event has already been and gone.
      if (proc.connected === false) request('disconnect')
    }
    proc.channel?.unref?.()
  }

  return {
    hasChannel,
    stopOnDisconnect: hasChannel && optedIn,
    onStop(fn) {
      stop = fn
      if (pending) {
        const reason = pending
        pending = null
        fn(reason)
      }
    },
  }
}

/** The part of `process` the signal handlers need. */
export interface SignalProcess {
  once(signal: 'SIGINT' | 'SIGTERM', listener: () => void): unknown
}

export type StopSignal = 'SIGINT' | 'SIGTERM'

export interface StopSignals {
  /** Hand over the stop to run. A signal that came before (while the server
   *  was starting) runs it now, once. */
  onStop(stop: (signal: StopSignal) => void): void
}

/**
 * Listen for SIGINT and SIGTERM from the start, and keep one that comes before
 * the stop exists, as `watchEmbedderChannel` keeps the message. Without it a
 * signal during boot either went to whatever part of the server happened to
 * listen already (and was spent there, so the server ran on) or, with nothing
 * listening, ended the process at once with no graceful stop.
 *
 * The listeners are `once`, so a second Ctrl+C (or SIGTERM) still ends the
 * process at once, as it always has. Node does not keep a process alive for a
 * signal listener, so a server that fails to start still exits.
 */
export function watchStopSignals(proc: SignalProcess): StopSignals {
  let stop: ((signal: StopSignal) => void) | null = null
  let pending: StopSignal | null = null
  const request = (signal: StopSignal): void => {
    if (stop) stop(signal)
    else pending ??= signal
  }
  proc.once('SIGINT', () => request('SIGINT'))
  proc.once('SIGTERM', () => request('SIGTERM'))
  return {
    onStop(fn) {
      stop = fn
      if (pending) {
        const signal = pending
        pending = null
        fn(signal)
      }
    },
  }
}

export interface ServerStopDeps {
  proc: SignalProcess
  /** The signals, watched from the start of boot. Default: watched from now. */
  signals?: StopSignals
  channel: EmbedderChannel
  /** Ends the agent runs and closes the database. A rejection still exits. */
  gracefulExit: () => Promise<void>
  exit: (code: number) => void
  /** Told why the server is stopping, once. */
  onStopping?: (why: string) => void
}

export interface ServerStop {
  /** Whether a stop has begun: one asked for now, or one kept from boot that
   *  ran when the stop was installed. */
  stopping(): boolean
}

/**
 * One stop, however it is asked for. Asked twice (an app's own wrapper may turn
 * the same message into a SIGTERM too), it runs once. The signal handlers are
 * `once`, so a second Ctrl+C still ends the process at once, as it always has.
 * A stop kept from boot (a signal or the message) runs here, before this
 * returns.
 *
 * A stop over the channel calls the stop directly. It used to raise SIGTERM in
 * this process for the parts that stopped on their own SIGTERM listeners, which
 * spent the stop's own listener: a real SIGTERM right after the message (a
 * wrapper turning the message into a signal, or an app's fallback) then found
 * none and ended the process halfway through its stop. The server's parts no
 * longer listen for signals (`gracefulExit` stops each of them), so nothing
 * needs it, and that SIGTERM is now caught as the stop it repeats.
 */
export function installServerStop(deps: ServerStopDeps): ServerStop {
  let stopping = false
  const stop = (why: string): void => {
    if (stopping) return
    stopping = true
    deps.onStopping?.(why)
    void deps
      .gracefulExit()
      .catch(() => undefined)
      .then(() => deps.exit(0))
  }
  ;(deps.signals ?? watchStopSignals(deps.proc)).onStop((signal) => stop(signal))
  deps.channel.onStop((reason) => {
    if (stopping) return
    stop(reason === 'message' ? 'shutdown message' : 'the IPC channel closed')
  })
  return { stopping: () => stopping }
}

export interface ListenDeps {
  /** The server already listens: the work folder move listened early, so
   *  `/api/health` could say `migrating`. */
  listening: boolean
  /** Start listening, calling `onListening` once it does. */
  listen: (onListening: () => void) => void
  /** What the server starts once it listens (the port file, the routines
   *  ticker, connector restore, the boot probe). */
  onListening: () => void
}

/**
 * Install the stop, THEN start what runs once the server listens. A stop kept
 * while the server started runs inside `installServerStop`, so it has begun
 * before anything here, and none of the after-listen starts run on a server
 * that is going away: the routines ticker would otherwise resume and tick due
 * routines, and could start a run, in the moment before the kept stop fired. A
 * server that is stopping does not start listening either. A stop asked for
 * after this, while the listen completes, is caught by the same check.
 */
export function installStopThenListen(stopDeps: ServerStopDeps, listen: ListenDeps): ServerStop {
  const stop = installServerStop(stopDeps)
  const onListening = startOnceListening(stop.stopping, listen.onListening)
  if (listen.listening) onListening()
  else if (!stop.stopping()) listen.listen(onListening)
  return stop
}

/**
 * What the server starts once it listens (the routines ticker, connector restore,
 * the boot probe), wrapped so it starts only while no stop has begun. A stop
 * asked for while the server was starting runs as soon as `installServerStop`
 * does, and it may still be waiting for the agent runs to end when the listen
 * completes: started then, the routines ticker would claim due routines on a
 * server that is going away, after the stop had already stopped it.
 */
export function startOnceListening(stopping: () => boolean, start: () => void): () => void {
  return () => {
    if (stopping()) return
    start()
  }
}
