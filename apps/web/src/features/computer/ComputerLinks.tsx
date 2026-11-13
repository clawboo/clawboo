// Links to this agent's computer: make, copy once, revoke.
//
// A view link lets someone watch this agent's screen; a control link also lets
// them take it over (to type their own password into a site the agent uses, say).
// Each reaches this one agent only, expires, and can be revoked at any time;
// revoking closes every view open through it at once. The link is shown once,
// when it is made: Clawboo keeps only a fingerprint of it.

import { useCallback, useEffect, useState } from 'react'
import { apiFetch } from '@clawboo/control-client'

import { readInjectedBase } from '@/app/injectedBase'
import { useVisiblePolling } from '@/lib/useVisiblePolling'

interface LinkRow {
  id: string
  kind: 'view' | 'control'
  createdAt: number
  expiresAt: number
}

const POLL_MS = 10_000

/** The page a link opens: the token in the fragment, which a browser never sends. */
export function linkUrl(token: string): string {
  return `${window.location.origin}${readInjectedBase()}/computer-link#${token}`
}

export function ComputerLinks({ agentId }: { agentId: string }) {
  const [links, setLinks] = useState<LinkRow[]>([])
  // Why control links cannot be made here (agents on the server's own user), or null.
  const [controlRefusal, setControlRefusal] = useState<string | null>(null)
  const [fresh, setFresh] = useState<{ kind: 'view' | 'control'; url: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const load = useCallback(() => {
    void apiFetch(`/api/agents/${encodeURIComponent(agentId)}/computer`)
      .then(async (r) => {
        if (!r.ok) return
        const body = (await r.json()) as {
          links?: LinkRow[]
          controlLinks?: { allowed?: boolean; reason?: string | null }
        }
        setLinks(Array.isArray(body.links) ? body.links : [])
        setControlRefusal(
          body.controlLinks?.allowed === false
            ? (body.controlLinks.reason ?? 'Control links are not available here.')
            : null,
        )
      })
      .catch(() => {})
  }, [agentId])

  useEffect(() => {
    setFresh(null)
    setLinks([])
    load()
  }, [load])
  useVisiblePolling(load, POLL_MS)

  const make = async (kind: 'view' | 'control') => {
    setError(null)
    setCopied(false)
    const r = await apiFetch(`/api/agents/${encodeURIComponent(agentId)}/computer/links`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind }),
    }).catch(() => null)
    const body = (await r?.json().catch(() => null)) as { token?: string; error?: string } | null
    if (!r?.ok || !body?.token) {
      setError(body?.error ?? 'Could not make a link.')
      return
    }
    setFresh({ kind, url: linkUrl(body.token) })
    load()
  }

  const revoke = async (linkId?: string) => {
    setError(null)
    const path = linkId
      ? `/api/agents/${encodeURIComponent(agentId)}/computer/links/${encodeURIComponent(linkId)}`
      : `/api/agents/${encodeURIComponent(agentId)}/computer/links`
    const r = await apiFetch(path, { method: 'DELETE' }).catch(() => null)
    if (!r?.ok) setError('Could not revoke the link.')
    setFresh(null)
    load()
  }

  const copy = async () => {
    if (!fresh) return
    try {
      await navigator.clipboard.writeText(fresh.url)
      setCopied(true)
    } catch {
      setCopied(false)
    }
  }

  const btn =
    'rounded-md border border-border bg-input px-2 py-0.5 text-[12px] text-foreground hover:bg-foreground/[0.06]'

  return (
    <section
      className="flex shrink-0 flex-col gap-2 border-t border-border px-3 py-2"
      aria-label="Links"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
          Links
        </span>
        <button type="button" className={btn} onClick={() => void make('view')}>
          View link
        </button>
        <button
          type="button"
          className={`${btn} disabled:cursor-not-allowed disabled:opacity-50`}
          disabled={controlRefusal !== null}
          title={controlRefusal ?? undefined}
          onClick={() => void make('control')}
        >
          Control link
        </button>
        {links.length > 0 && (
          <button
            type="button"
            className="ml-auto text-[12px] text-muted-foreground underline-offset-2 hover:underline"
            onClick={() => void revoke()}
          >
            Revoke all
          </button>
        )}
      </div>
      {fresh && (
        <div className="flex flex-col gap-1 rounded-md border border-border bg-card/50 p-2">
          <span className="text-[12px] text-muted-foreground">
            {fresh.kind === 'control'
              ? 'Anyone with this link can watch this agent’s screen and take it over until it expires. Taking over reaches what the agents’ OS user can on this computer, every agent’s files and browser sign-ins included, so give it only to someone you trust with them.'
              : 'Anyone with this link can watch this agent’s screen until it expires.'}{' '}
            It is shown only now.
          </span>
          <div className="flex items-center gap-2">
            <input
              readOnly
              value={fresh.url}
              aria-label="New link"
              className="min-w-0 flex-1 rounded-md border border-border bg-input px-1.5 py-0.5 font-mono text-[11px]"
              onFocus={(e) => e.currentTarget.select()}
            />
            <button type="button" className={btn} onClick={() => void copy()}>
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
        </div>
      )}
      {error && (
        <p role="alert" className="text-[12px] text-destructive">
          {error}
        </p>
      )}
      {links.length > 0 && (
        <ul className="flex flex-col gap-1">
          {links.map((l) => (
            <li key={l.id} className="flex items-center gap-2 text-[12px] text-muted-foreground">
              <span className="font-mono text-[11px] text-foreground">
                {l.kind === 'control' ? 'Control' : 'View'}
              </span>
              <span>expires {new Date(l.expiresAt).toLocaleTimeString()}</span>
              <button
                type="button"
                className="ml-auto underline-offset-2 hover:underline"
                onClick={() => void revoke(l.id)}
              >
                Revoke
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
