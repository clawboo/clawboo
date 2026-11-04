// The dashboard's first read, before anything else mounts. A server locked with
// its access token refuses every /api/ request from a browser without the cookie,
// so without this check such a browser rendered a dashboard full of failed reads.
// Instead it gets one screen that says how to get in, and nothing behind it loads.

import { useEffect, useId, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { Lock } from 'lucide-react'

import { apiFetch, setResponseObserver } from '@clawboo/control-client'

import { readInjectedBase } from '@/app/injectedBase'
import { Button } from '@/features/shared/Button'

import {
  hasPastedMark,
  readPastedSignIn,
  submitSignIn,
  withoutPastedMark,
  type PastedSignIn,
} from './pastedSignIn'

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

/** How long the first read may take before the dashboard loads anyway. */
const CHECK_TIMEOUT_MS = 5_000

export function AccessLock({
  children,
  checkTimeoutMs = CHECK_TIMEOUT_MS,
}: {
  children: ReactNode
  checkTimeoutMs?: number
}) {
  const [state, setState] = useState<AccessState>('checking')
  // A pasted link was just posted (see pastedSignIn.ts). Read once, before any
  // effect takes the mark off the address; Strict Mode runs effects twice.
  const [fromPastedLink] = useState(() => hasPastedMark(window.location.search))
  // True when the first read found the lock, as opposed to a later read.
  const [lockedAtStart, setLockedAtStart] = useState(false)

  // The mark has done its job by the time this page loads: take it off the
  // address before anything behind the lock reads it.
  useEffect(() => {
    const clean = withoutPastedMark(window.location.href)
    if (clean !== null) window.history.replaceState(window.history.state, '', clean)
  }, [])

  useEffect(() => {
    let cancelled = false
    // A read that never answers must not leave the page blank: give up, load the
    // dashboard, and let its own error handling say what is wrong.
    const abort = new AbortController()
    const deadline = setTimeout(() => abort.abort(), checkTimeoutMs)
    void (async () => {
      let next: AccessState = 'open'
      try {
        const res = await apiFetch('/api/settings', { cache: 'no-store', signal: abort.signal })
        if (res.status === 401) {
          const body: unknown = await res.json().catch(() => null)
          if (isAccessGateRefusal(res.status, body)) next = 'locked'
        }
      } catch {
        // Not the gate. The dashboard reports its own connection problems.
      } finally {
        clearTimeout(deadline)
      }
      if (cancelled) return
      setState(next)
      setLockedAtStart(next === 'locked')
    })()
    return () => {
      cancelled = true
      clearTimeout(deadline)
    }
  }, [checkTimeoutMs])

  // Once open, any later read that gets the gate's refusal locks the page too: a
  // server restarted with a new token, or a cleared cookie, would otherwise
  // leave this tab failing every read until a reload.
  useEffect(() => {
    if (state !== 'open') return
    setResponseObserver((res) => {
      if (res.status !== 401) return
      void res
        .clone()
        .json()
        .then((body: unknown) => {
          if (isAccessGateRefusal(401, body)) setState('locked')
        })
        .catch(() => {})
    })
    return () => setResponseObserver(null)
  }, [state])

  if (state === 'checking') return null
  // Back on the locked screen right after posting a pasted link: the server
  // refused the code. A lock that comes later is not about that link.
  if (state === 'locked')
    return <LockedScreen pastedLinkRefused={fromPastedLink && lockedAtStart} />
  return <>{children}</>
}

export function LockedScreen({ pastedLinkRefused = false }: { pastedLinkRefused?: boolean }) {
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
        <PasteSignIn refused={pastedLinkRefused} />
        <p className="mt-4 text-sm text-muted-foreground">
          A sign-in link works once, within two minutes. If you just opened one and landed here, it
          had already been used or had expired.
        </p>
      </div>
    </main>
  )
}

const REFUSED =
  'That link did not sign you in. It had already been used, or its two minutes were up. ' +
  'Make a new link and paste it straight away.'

/** What to say about a pasted link that cannot be used. Names at most its address, never a code or token. */
function problemWith(read: Exclude<PastedSignIn, { ok: true }>): string {
  switch (read.reason) {
    case 'empty':
      return 'Paste a sign-in link first.'
    case 'not-a-link':
      return 'That is not a sign-in link. Paste the whole link, or the code after access_code=.'
    case 'token':
      return 'That link holds the access token, not a one-time code. Paste a one-time sign-in link instead.'
    case 'elsewhere':
      return (
        `That link is for ${read.linkOrigin}, and this dashboard is at ${window.location.origin}. ` +
        'Make the link in a browser that has this address open.'
      )
    case 'other-dashboard':
      return 'That link is for another dashboard at this address. Make the link in this one.'
  }
}

/**
 * A field to paste a one-time sign-in link into. An app added to an iPhone's
 * home screen needs it: its cookies are its own, and a tapped link opens in
 * Safari, which signs in Safari instead.
 */
function PasteSignIn({ refused }: { refused: boolean }) {
  const fieldId = useId()
  const hintId = useId()
  const problemId = useId()
  const [text, setText] = useState('')
  const [problem, setProblem] = useState<string | null>(refused ? REFUSED : null)
  const [signingIn, setSigningIn] = useState(false)

  // A page the browser brings back from its back-forward cache keeps its last
  // state, which would be a Sign in button still spinning.
  useEffect(() => {
    const onPageShow = (event: PageTransitionEvent): void => {
      if (event.persisted) setSigningIn(false)
    }
    window.addEventListener('pageshow', onPageShow)
    return () => window.removeEventListener('pageshow', onPageShow)
  }, [])

  const onSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    const base = readInjectedBase()
    const read = readPastedSignIn(text, { origin: window.location.origin, base })
    if (!read.ok) {
      setProblem(problemWith(read))
      return
    }
    setProblem(null)
    setText('')
    setSigningIn(true)
    submitSignIn(read.code, base)
  }

  return (
    <form noValidate onSubmit={onSubmit} className="mt-5 border-t border-border pt-4">
      <label htmlFor={fieldId} className="block text-sm font-semibold text-foreground">
        Paste a sign-in link
      </label>
      <p id={hintId} className="mt-1 text-sm text-muted-foreground">
        Or just its code. An app added to a phone&apos;s home screen signs in here, because a link
        you tap can open in the phone&apos;s browser instead.
      </p>
      <div className="mt-3 flex flex-col gap-2 sm:flex-row">
        <input
          id={fieldId}
          type="text"
          inputMode="url"
          enterKeyHint="go"
          autoComplete="off"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          value={text}
          onChange={(event) => {
            setText(event.target.value)
            setProblem(null)
          }}
          placeholder="https://…/?access_code=…"
          aria-invalid={problem !== null}
          aria-describedby={problem === null ? hintId : `${problemId} ${hintId}`}
          // 16 px on a phone: iOS zooms the page into any smaller field.
          className="h-11 w-full min-w-0 rounded-lg border border-border bg-background px-3 font-mono text-base text-foreground outline-none transition placeholder:text-foreground/30 focus:border-primary focus:ring-4 focus:ring-primary/15 sm:h-9 sm:flex-1 sm:text-[13px]"
        />
        <Button type="submit" variant="primary" loading={signingIn} className="max-sm:h-11">
          Sign in
        </Button>
      </div>
      {problem !== null && (
        <p id={problemId} role="alert" className="mt-2 text-sm text-destructive">
          {problem}
        </p>
      )}
    </form>
  )
}
