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

import { createServer, type Server } from 'node:http'
import { AddressInfo } from 'node:net'

export interface CallbackResult {
  code: string
  state: string
}

export interface Listener {
  /** The exact redirect_uri to register and to send in the authorize request. */
  redirectUri: string
  /** Resolves with the callback params, or rejects on timeout or an error param. */
  waitForCallback(): Promise<CallbackResult>
  close(): void
}

/** A page the user sees in the tab the provider redirected. Plain, self-closing. */
function resultPage(title: string, detail: string): string {
  return `<!doctype html><meta charset="utf-8"><title>${title}</title>
<body style="font-family:system-ui;padding:3rem;max-width:32rem;margin:auto;color:#111">
<h1 style="font-size:1.1rem">${title}</h1><p style="color:#555">${detail}</p>
<p style="color:#888;font-size:.85rem">You can close this tab.</p></body>`
}

/** How long the user has to finish signing in before the listener gives up. */
const DEFAULT_TIMEOUT_MS = 5 * 60_000

export async function startOAuthListener(opts: { timeoutMs?: number } = {}): Promise<Listener> {
  let resolveCb: ((r: CallbackResult) => void) | null = null
  let rejectCb: ((e: Error) => void) | null = null

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (url.pathname !== '/callback') {
      res.writeHead(404).end()
      return
    }
    const error = url.searchParams.get('error')
    const code = url.searchParams.get('code')
    const state = url.searchParams.get('state')

    if (error) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(
        resultPage(
          'Sign-in was not completed',
          // The provider's own description, escaped. It is the only thing that
          // explains WHY, and paraphrasing it would lose that.
          escapeHtml(url.searchParams.get('error_description') ?? error),
        ),
      )
      rejectCb?.(new Error(`authorization failed: ${error}`))
      return
    }
    if (!code || !state) {
      res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' })
      res.end(
        resultPage('Something went wrong', 'The provider did not send an authorization code.'),
      )
      rejectCb?.(new Error('callback missing code or state'))
      return
    }

    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(resultPage('Connected', 'clawboo has the credentials it needs.'))
    resolveCb?.({ code, state })
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    // Port 0 asks the OS for a free one, which is what makes this safe to run
    // alongside anything else the user has bound.
    server.listen(0, '127.0.0.1', resolve)
  })

  const address = server.address() as AddressInfo
  const redirectUri = `http://127.0.0.1:${address.port}/callback`

  return {
    redirectUri,
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
    close() {
      server.close()
      // Any keep-alive socket would otherwise hold the port, and the next
      // attempt asks for a fresh one anyway.
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
