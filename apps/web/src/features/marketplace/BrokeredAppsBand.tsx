// Apps clawboo reaches through a broker, and the one field that unlocks them.
//
// ITS OWN BAND, NOT MIXED INTO THE CONNECTORS. The previous attempt declared
// these as catalog connectors so they would sort in with the rest, and then
// spent eleven branch sites explaining to everything downstream that this
// particular kind of connector could not be connected, had no session, and had
// to be priced from a different source. A row that is reached through something
// else is a different kind of row, and saying so once here is cheaper than
// saying it everywhere else.
//
// THE KEY LIVES WHERE IT IS NEEDED. Sending someone to a settings page to paste
// a key, then back here to use it, is two screens for one intent. The band asks
// for it in place, once, and then never mentions it again.

import { useCallback, useEffect, useState } from 'react'
import { Check } from 'lucide-react'

import { BROKERED_APPS, type BrokeredApp } from '@clawboo/connector-catalog'
import { apiFetch } from '@clawboo/control-client'

import { ConnectorMark } from '@/features/connectors/ConnectorMark'
import { Button } from '@/features/shared/Button'
import { useVisiblePolling } from '@/lib/useVisiblePolling'
import { useToastStore } from '@/stores/toast'

/** Where the key lives, so nobody has to go hunting for the page. */
const KEY_PAGE = 'https://platform.composio.dev/settings/api-keys'

interface BrokerStatus {
  hasKey: boolean
  connected: ReadonlySet<string>
  /** A stored key that Composio is refusing. Asks for a replacement. */
  keyRejected: boolean
  /** False only before the first answer. Never used to gate a control. */
  loaded: boolean
}

const BLANK: BrokerStatus = {
  hasKey: false,
  connected: new Set(),
  keyRejected: false,
  loaded: false,
}

/**
 * The band's view of the broker, or null when it could not be read.
 *
 * NULL RATHER THAN AN EMPTY ANSWER. Collapsing a failed read into "no key, no
 * apps" put the paste field back on screen under a key that was stored and
 * working, which reads as the app having lost it. Not knowing and knowing there
 * is nothing are different states and only one of them should ask for a key.
 */
async function readStatus(): Promise<BrokerStatus | null> {
  try {
    const res = await apiFetch('/api/connectors/composio')
    if (!res.ok) return null
    const body = (await res.json()) as {
      hasKey?: boolean
      connected?: string[]
      keyRejected?: boolean
    }
    return {
      hasKey: Boolean(body.hasKey),
      connected: new Set(body.connected ?? []),
      keyRejected: Boolean(body.keyRejected),
      loaded: true,
    }
  } catch {
    return null
  }
}

export function BrokeredAppsBand({
  query,
  onlyConnected,
}: {
  query: string
  onlyConnected: boolean
}) {
  const [status, setStatus] = useState<BrokerStatus>(BLANK)
  const [busy, setBusy] = useState<string | null>(null)
  const [key, setKey] = useState('')
  const [saving, setSaving] = useState(false)
  /** The server's own words about the last paste. Shown under the field. */
  const [keyError, setKeyError] = useState<string | null>(null)

  const refresh = useCallback(() => {
    // A read that failed leaves the last answer standing. The alternative is to
    // forget a working key every time the server restarts.
    void readStatus().then((next) => {
      if (next) setStatus(next)
    })
  }, [])
  useEffect(refresh, [refresh])

  // THE ANSWER ARRIVES IN ANOTHER TAB. Approving an app happens on Composio's
  // page, and coming back here is an OS-level app or tab switch that this
  // component would otherwise never hear about, so a freshly connected app kept
  // showing a Connect button until the panel was remounted. Focus is the signal
  // that matters; the interval is only a backstop for a consent completed while
  // this tab was already in front.
  useVisiblePolling(refresh, 60_000, { enabled: status.hasKey, refreshOnFocus: true })

  // A refused key is not a key. Asking again is the only thing that helps, and
  // leaving the Connect buttons live would just replay the failure per app.
  const needsKey = !status.hasKey || status.keyRejected

  const q = query.trim().toLowerCase()
  const rows = BROKERED_APPS.filter((a) => {
    if (onlyConnected && !status.connected.has(a.slug)) return false
    if (!q) return true
    return a.name.toLowerCase().includes(q) || a.description.toLowerCase().includes(q)
  })
  if (rows.length === 0) return null

  const saveKey = async (): Promise<void> => {
    // NOT TRIMMED HERE. The server reads the key out of whatever was pasted,
    // including the `COMPOSIO_API_KEY=...` line the dashboard shows, and it is
    // the only place that should decide what a key looks like.
    if (key.trim() === '' || saving) return
    setSaving(true)
    setKeyError(null)
    try {
      const res = await apiFetch('/api/connectors/composio/key', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey: key }),
      })
      const body = (await res.json().catch(() => ({}))) as { error?: string; verified?: boolean }
      if (!res.ok) {
        // IN PLACE, NOT IN A TOAST. The field is still on screen with the bad
        // paste in it, and that is where the correction happens.
        setKeyError(body.error ?? 'That key was not accepted.')
        return
      }
      // Cleared immediately. It is in the vault now and this field has no
      // further use for it.
      setKey('')
      refresh()
      useToastStore.getState().addToast({
        message: body.verified
          ? 'Composio connected.'
          : 'Key saved. Composio could not be reached to check it.',
        type: body.verified ? 'success' : 'info',
      })
    } catch {
      setKeyError('Could not reach clawboo to save the key.')
    } finally {
      setSaving(false)
    }
  }

  const connect = async (app: BrokeredApp): Promise<void> => {
    // OPENED INSIDE THE CLICK. A window.open after an await is outside the user
    // gesture and the browser discards it, which once produced a button that
    // did nothing above a toast claiming a tab had opened.
    const tab = window.open('about:blank', '_blank')
    setBusy(app.slug)
    try {
      const res = await apiFetch(
        `/api/connectors/composio/apps/${encodeURIComponent(app.slug)}/authorize`,
        { method: 'POST' },
      )
      const body = (await res.json().catch(() => ({}))) as {
        url?: string
        alreadyConnected?: boolean
        error?: string
      }
      if (!res.ok) {
        tab?.close()
        useToastStore
          .getState()
          .addToast({ message: body.error ?? `${app.name} could not be connected.`, type: 'error' })
        return
      }
      if (body.alreadyConnected || !body.url) {
        tab?.close()
        refresh()
        useToastStore.getState().addToast({ message: `${app.name} connected.`, type: 'success' })
        return
      }
      if (tab) {
        tab.opener = null
        tab.location.href = body.url
      } else {
        // NO TAB, SO DO NOT CLAIM ONE. The link is handed over on an action
        // whose click is a fresh gesture the browser will honour.
        const url = body.url
        useToastStore.getState().addToast({
          message: `${app.name} is ready to approve.`,
          type: 'info',
          ttlMs: 8000,
          action: { label: 'Approve', onAction: () => window.open(url, '_blank', 'noopener') },
        })
        return
      }
      useToastStore
        .getState()
        .addToast({ message: `Approve ${app.name} in the tab that opened.`, type: 'info' })
    } catch {
      // THE TAB WAS OPENED BEFORE THE REQUEST, so a request that never returns
      // leaves a blank tab sitting in front of the operator with nothing in it.
      // A restarting server is enough to reach here.
      tab?.close()
      useToastStore
        .getState()
        .addToast({ message: `Could not reach clawboo to connect ${app.name}.`, type: 'error' })
    } finally {
      setBusy(null)
    }
  }

  return (
    <section className="mt-1">
      <div className="flex items-baseline gap-2 px-3 pb-0.5 pt-1">
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.07em] text-muted-foreground">
          Reached through Composio
        </h3>
        <span className="text-[11px] tabular-nums text-muted-foreground/70">{rows.length}</span>
      </div>

      {needsKey && status.loaded && (
        <div className="mx-3 mb-2 rounded-xl border border-border bg-surface-subtle p-3">
          <p className="m-0 mb-2 text-[12px] text-muted-foreground">
            {status.keyRejected
              ? 'Composio is refusing the saved key. Paste a current one to turn these back on.'
              : 'These sign in through Composio. Paste a key to turn them on.'}{' '}
            <a
              href={KEY_PAGE}
              target="_blank"
              rel="noreferrer noopener"
              className="text-foreground underline underline-offset-2 hover:text-primary"
            >
              Get a key
            </a>
          </p>
          <div className="flex gap-2">
            <input
              type="password"
              value={key}
              onChange={(e) => {
                setKey(e.target.value)
                setKeyError(null)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void saveKey()
              }}
              placeholder="ak_…"
              aria-label="Composio key"
              aria-invalid={keyError !== null}
              aria-describedby={keyError ? 'composio-key-error' : undefined}
              className="w-full rounded-lg border border-border bg-surface px-2.5 py-1.5 text-[13px] text-foreground outline-none placeholder:text-muted-foreground aria-[invalid=true]:border-destructive"
            />
            <Button size="sm" disabled={!key.trim() || saving} onClick={() => void saveKey()}>
              {saving ? 'Checking…' : 'Save'}
            </Button>
          </div>
          {keyError && (
            <p
              id="composio-key-error"
              role="alert"
              className="m-0 mt-2 text-[12px] text-destructive"
            >
              {keyError}
            </p>
          )}
        </div>
      )}

      <div className="flex flex-col">
        {rows.map((app) => {
          const connected = status.connected.has(app.slug)
          return (
            <div
              key={app.slug}
              data-testid={`brokered-row-${app.slug}`}
              className="group relative flex items-center gap-3 rounded-xl px-3 py-2.5 transition-colors duration-150 hover:bg-foreground/[0.03]"
            >
              <ConnectorMark slug={app.slug} displayName={app.name} size={30} />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13.5px] font-medium leading-tight text-foreground">
                  {app.name}
                </div>
                <div className="truncate text-[12px] leading-snug text-muted-foreground">
                  {app.description}
                </div>
              </div>
              {connected ? (
                <span className="flex items-center gap-1.5 pr-1 text-[12px] text-muted-foreground">
                  <Check size={13} strokeWidth={2.6} className="text-mint" aria-hidden />
                  Connected
                </span>
              ) : (
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={busy === app.slug || needsKey}
                  aria-label={`Connect ${app.name}`}
                  onClick={() => void connect(app)}
                >
                  {busy === app.slug ? 'Working…' : 'Connect'}
                </Button>
              )}
            </div>
          )
        })}
      </div>
    </section>
  )
}
