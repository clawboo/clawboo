// The dashboard's first read, before anything else mounts. A server locked with
// its access token refuses every /api/ request from a browser without the cookie,
// so without this check such a browser rendered a dashboard full of failed reads.
// Instead it gets one screen that says how to get in, and nothing behind it loads.

import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { Lock } from 'lucide-react'

import { apiFetch } from '@clawboo/control-client'

/**
 * Is this the access gate's refusal? The gate marks its 401 with
 * `gate: 'clawboo-access'`; an older server sends only its `error` text, which
 * names Clawboo and the access token.
 */
export function isAccessGateRefusal(status: number, body: unknown): boolean {
  if (status !== 401 || typeof body !== 'object' || body === null) return false
  const record = body as Record<string, unknown>
  if (record['gate'] === 'clawboo-access') return true
  const error = typeof record['error'] === 'string' ? record['error'].toLowerCase() : ''
  return error.includes('clawboo') && error.includes('access token')
}

type AccessState = 'checking' | 'open' | 'locked'

export function AccessLock({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AccessState>('checking')

  useEffect(() => {
    let cancelled = false
    void (async () => {
      let next: AccessState = 'open'
      try {
        const res = await apiFetch('/api/settings', { cache: 'no-store' })
        if (res.status === 401) {
          const body: unknown = await res.json().catch(() => null)
          if (isAccessGateRefusal(res.status, body)) next = 'locked'
        }
      } catch {
        // Not the gate. The dashboard reports its own connection problems.
      }
      if (!cancelled) setState(next)
    })()
    return () => {
      cancelled = true
    }
  }, [])

  if (state === 'checking') return null
  if (state === 'locked') return <LockedScreen />
  return <>{children}</>
}

export function LockedScreen() {
  return (
    <main
      data-testid="access-locked"
      className="flex min-h-screen items-center justify-center bg-background px-4 py-10 text-foreground"
    >
      <div className="w-full max-w-[440px] rounded-2xl border border-border bg-surface p-6 shadow-[var(--shadow-floating)]">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-foreground/[0.06]">
          <Lock size={18} strokeWidth={2} aria-hidden className="text-foreground/70" />
        </div>
        <h1 className="mt-4 text-lg font-semibold">This dashboard is locked to your computer</h1>
        <p className="mt-2 text-sm text-foreground/80">
          Open it from a terminal on the computer running Clawboo:
        </p>
        <pre className="mt-2 rounded-lg border border-border bg-background px-3 py-2 font-mono text-[13px]">
          <code>clawboo open</code>
        </pre>
        <p className="mt-3 text-sm text-muted-foreground">
          That opens this dashboard in your browser, signed in. With no browser on that computer,{' '}
          <code className="font-mono text-[12.5px] text-foreground/80">clawboo open --print</code>{' '}
          prints a sign-in link to open elsewhere. If Clawboo is open on another device, its{' '}
          <span className="font-medium text-foreground/80">Open on another device</span> button
          makes one too.
        </p>
        <p className="mt-3 text-sm text-muted-foreground">
          A sign-in link works once, within two minutes. If you just opened one and landed here, it
          had already been used or had expired.
        </p>
      </div>
    </main>
  )
}
