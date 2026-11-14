// The page a view or control link opens: one agent's screen and nothing else.
//
// The link's token is in the URL's fragment, which a browser never sends to a
// server, so it is in no request line, log or proxy. This page reads it, takes
// it out of the address bar (so it is not left in history or on a screen share),
// and sends it in a header with each request. Nothing of the dashboard mounts:
// the person holding a link has access to this agent's screen and no more.

import { useEffect, useState } from 'react'
import { apiFetch } from '@clawboo/control-client'

import { ComputerScreen } from './ComputerScreen'

const LINK_HEADER = 'x-clawboo-computer-link'

/** The token from the fragment, then the fragment cleared. Read once. */
function takeTokenFromFragment(): string | null {
  const raw = window.location.hash.replace(/^#/, '')
  if (!raw) return null
  try {
    window.history.replaceState(null, '', window.location.pathname + window.location.search)
  } catch {
    // An old browser keeps the fragment; the token still works.
  }
  return /^cbcl_[A-Za-z0-9_-]{20,}$/.test(raw) ? raw : null
}

export function ComputerLinkPage() {
  const [token] = useState(takeTokenFromFragment)
  const [info, setInfo] = useState<{
    kind: 'view' | 'control'
    agent: string
    expiresAt: number
  } | null>(null)
  const [error, setError] = useState<string | null>(token ? null : 'This link is incomplete.')

  useEffect(() => {
    if (!token) return
    // No cookie, and no access lock is mounted on this page to read a 401.
    void apiFetch('/api/computer-link/info', {
      headers: { [LINK_HEADER]: token },
      credentials: 'omit',
    })
      .then(async (r) => {
        const body = (await r.json().catch(() => null)) as {
          kind?: 'view' | 'control'
          expiresAt?: number
          agent?: { name?: string }
          error?: string
        } | null
        if (!r.ok || !body?.kind) {
          setError(body?.error ?? 'This link does not work any more.')
          return
        }
        setInfo({
          kind: body.kind,
          agent: body.agent?.name ?? 'Agent',
          expiresAt: body.expiresAt ?? 0,
        })
      })
      .catch(() => setError('Could not reach Clawboo.'))
  }, [token])

  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      <header className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-2">
        <span className="text-[13px] font-semibold">
          {info ? `${info.agent}'s screen` : "An agent's screen"}
        </span>
        {info && (
          <span className="font-mono text-[11px] text-muted-foreground">
            {info.kind === 'control' ? 'Control link' : 'View link'}, until{' '}
            {new Date(info.expiresAt).toLocaleTimeString()}
          </span>
        )}
      </header>
      <main className="min-h-0 flex-1">
        {error || !token ? (
          <div className="flex h-full items-center justify-center p-6">
            <p className="max-w-[46ch] text-center text-[13px] text-muted-foreground">{error}</p>
          </div>
        ) : info ? (
          <ComputerScreen target={{ kind: 'link', token }} readOnly={info.kind === 'view'} />
        ) : null}
      </main>
    </div>
  )
}
