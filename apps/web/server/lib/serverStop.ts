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

export interface ServerStopDeps {
  proc: SignalProcess
  channel: EmbedderChannel
  /** Ends the agent runs and closes the database. A rejection still exits. */
  gracefulExit: () => Promise<void>
  exit: (code: number) => void
  /** Told why the server is stopping, once. */
  onStopping?: (why: string) => void
}

/**
 * One stop, however it is asked for. Asked twice (an app's own wrapper may turn
 * the same message into a SIGTERM too), it runs once. The signal handlers are
 * `once`, so a second Ctrl+C still ends the process at once, as it always has.
 */
export function installServerStop(deps: ServerStopDeps): void {
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
  deps.proc.once('SIGINT', () => stop('SIGINT'))
  deps.proc.once('SIGTERM', () => stop('SIGTERM'))
  deps.channel.onStop((reason) =>
    stop(reason === 'message' ? 'shutdown message' : 'the IPC channel closed'),
  )
}
