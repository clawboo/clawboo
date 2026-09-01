// The OAuth callback listener.
//
// A BARE node:http SERVER ON 127.0.0.1, deliberately NOT an Express route. The
// redirect back from an authorization server is a cross-site top-level
// navigation, so the browser sends `Sec-Fetch-Site: cross-site`, and the
// same-origin guard refuses exactly that (packages/gateway-proxy origin-guard).
// That guard is always on and cannot be disabled, so a callback route under
// /api would 403 on every install, on every platform, with no configuration
// that could fix it.
//
// 127.0.0.1 rather than `localhost`: the name can resolve to ::1 first, and an
// authorization server that registered the IPv4 literal would then redirect to
// somewhere nothing is listening. RFC 8252 says to use the literal for exactly
// this reason.
//
// EPHEMERAL PORT, which is only viable because clawboo registers itself per
// install via DCR and hands the server the exact redirect it is listening on. A
// provider without dynamic registration needs a fixed, pre-registered callback,
// and the registration step refuses those up front rather than failing here.

import { createServer, type Server, type ServerResponse } from 'node:http'
import { AddressInfo } from 'node:net'

export interface CallbackResult {
  code: string
  state: string
}

export interface Listener {
  /** The exact redirect_uri to register and to send in the authorize request. */
  redirectUri: string
  /** The port actually bound, so a later attempt can ask for it again. */
  port: number
  /** Resolves with the callback params, or rejects on timeout or an error param. */
  waitForCallback(): Promise<CallbackResult>
  /**
   * Report the outcome of the token exchange, which is what the operator's tab
   * finally renders. Until this is called the tab is still loading, because
   * "Connected" is not true until a token has actually been obtained.
   */
  settle(outcome: { ok: boolean; detail: string }): void
  close(): void
}

export interface ListenerOptions {
  timeoutMs?: number
  /**
   * The `state` this listener will accept, and ONLY this one.
   *
   * The port is reachable by anything else running on the machine, including a
   * page the operator happens to have open, and a request to it used to abort
   * whatever sign-in was in flight. Matching state first makes an unauthenticated
   * request a 404 that changes nothing, and it is the same value that stops an
   * attacker-supplied authorization code being redeemed into the operator's
   * connector.
   */
  expectedState?: string
  /**
   * A port to try first. Dynamic registration PINS the redirect, so reusing the
   * previous port is what lets a second sign-in reuse the previous registration
   * instead of leaving a new dead client on the provider's side every time.
   * Falls back to an ephemeral port when it is taken.
   */
  preferredPort?: number
}

/**
 * A page the user sees in the tab the provider redirected.
 *
 * THE CLOSING LINE DEPENDS ON THE OUTCOME, and it did not used to. Both the
 * success page and the failure page ended with "You can close this tab", so a
 * sign-in that had FAILED still sent the operator back to clawboo believing it
 * had worked. They pressed the button again, met the same wall, and read the
 * whole thing as a loop rather than as one failure they could retry.
 */
function resultPage(title: string, detail: string, ok: boolean): string {
  const footer = ok
    ? 'You can close this tab.'
    : 'Nothing was connected. Close this tab and try again in clawboo.'
  return `<!doctype html><meta charset="utf-8"><title>${title}</title>
<body style="font-family:system-ui;padding:3rem;max-width:32rem;margin:auto;color:#111">
<h1 style="font-size:1.1rem">${title}</h1><p style="color:#555">${detail}</p>
<p style="color:#888;font-size:.85rem">${footer}</p></body>`
}

/** How long the user has to finish signing in before the listener gives up. */
const DEFAULT_TIMEOUT_MS = 5 * 60_000

/** How long the tab waits for the token exchange before it stops holding. */
const SETTLE_TIMEOUT_MS = 30_000

export async function startOAuthListener(opts: ListenerOptions = {}): Promise<Listener> {
  let resolveCb: ((r: CallbackResult) => void) | null = null
  let rejectCb: ((e: Error) => void) | null = null

  // The callback response is held open until the caller reports the outcome, so
  // the operator's tab shows what actually happened rather than an optimistic
  // "Connected" written before the code had been exchanged for anything.
  let held: ServerResponse | null = null
  let settled: { ok: boolean; detail: string } | null = null

  function write(res: ServerResponse, outcome: { ok: boolean; detail: string }): void {
    res.writeHead(outcome.ok ? 200 : 400, { 'content-type': 'text/html; charset=utf-8' })
    res.end(
      resultPage(
        outcome.ok ? 'Connected' : 'Sign-in was not completed',
        escapeHtml(outcome.detail),
        outcome.ok,
      ),
    )
  }

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (url.pathname !== '/callback') {
      res.writeHead(404).end()
      return
    }
    const error = url.searchParams.get('error')
    const code = url.searchParams.get('code')
    const state = url.searchParams.get('state')

    // STATE FIRST, before anything else can be acted on. Any other local process
    // can reach this port; without this check a single unauthenticated request
    // aborted whatever sign-in was in flight.
    if (opts.expectedState !== undefined && state !== opts.expectedState) {
      res.writeHead(404).end()
      return
    }

    if (error) {
      write(res, {
        ok: false,
        // The provider's own description. It is the only thing that explains
        // WHY, and paraphrasing it would lose that.
        detail: url.searchParams.get('error_description') ?? error,
      })
      rejectCb?.(new Error(`authorization failed: ${error}`))
      return
    }
    if (!code || !state) {
      write(res, { ok: false, detail: 'The provider did not send an authorization code.' })
      rejectCb?.(new Error('callback missing code or state'))
      return
    }

    // The exchange has not happened yet, so nothing is claimed yet.
    if (settled) {
      write(res, settled)
    } else {
      held = res
      const stopHolding = setTimeout(() => {
        if (held === res) {
          held = null
          write(res, {
            ok: false,
            detail: 'clawboo is still finishing. Check the connectors panel.',
          })
        }
      }, SETTLE_TIMEOUT_MS)
      stopHolding.unref()
    }
    resolveCb?.({ code, state })
  })

  const bind = (port: number): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      const onError = (err: Error): void => reject(err)
      server.once('error', onError)
      // Port 0 asks the OS for a free one, which is what makes this safe to run
      // alongside anything else the user has bound.
      server.listen(port, '127.0.0.1', () => {
        server.removeListener('error', onError)
        resolve()
      })
    })

  if (opts.preferredPort) {
    // Preferred, not required. Something else may hold it, including a previous
    // attempt that has not finished releasing it, and a sign-in that fails
    // because a port was busy would be a worse outcome than one more dynamic
    // registration.
    try {
      await bind(opts.preferredPort)
    } catch {
      await bind(0)
    }
  } else {
    await bind(0)
  }

  const address = server.address() as AddressInfo
  const redirectUri = `http://127.0.0.1:${address.port}/callback`

  return {
    redirectUri,
    port: address.port,
    waitForCallback() {
      return new Promise<CallbackResult>((resolve, reject) => {
        resolveCb = resolve
        rejectCb = reject
        const timer = setTimeout(
          () => reject(new Error('timed out waiting for the sign-in to finish')),
          opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        )
        timer.unref()
      })
    },
    settle(outcome) {
      settled = outcome
      if (held) {
        const res = held
        held = null
        write(res, outcome)
      }
    },
    close() {
      server.close()
      // Any keep-alive socket would otherwise hold the port open.
      server.closeAllConnections?.()
    },
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
