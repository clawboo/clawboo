// The "Open on another device" dialog: a one-time sign-in link, and a QR code of
// it for a phone, so nobody needs a terminal to open Clawboo in a second browser.
// The link carries a launch code that the server trades for the access cookie
// once, within two minutes. The access token itself never leaves the server.
// Loaded on the first click (see OpenOnAnotherDevice.tsx), so the QR code
// library stays off the boot path.

import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { Check, Copy, RefreshCw } from 'lucide-react'
import { QRCodeSVG } from 'qrcode.react'

import { apiFetch } from '@clawboo/control-client'

import { readInjectedBase } from '@/app/injectedBase'
import { Button } from '@/features/shared/Button'
import { Modal } from '@/features/shared/Modal'
import { Spinner } from '@/features/shared/Spinner'

import { deviceLink, isLoopbackHostname } from './deviceLink'

const REACH_ANOTHER_MACHINE_DOCS = 'https://docs.claw.boo/guides/self-host-securely'

type LinkState =
  | { kind: 'loading' }
  /** `code` is null on a server with no access token: the plain address is enough. */
  | { kind: 'ready'; code: string | null }
  | { kind: 'expired' }
  | { kind: 'error' }

interface LaunchCodeBody {
  gated?: boolean
  code?: string
  expiresInMs?: number
}

export function OpenOnAnotherDeviceDialog({
  open,
  onClose,
  origin,
}: {
  open: boolean
  onClose: () => void
  /** The origin the link points at. Defaults to the one this page was loaded from. */
  origin?: string
}) {
  const headingId = useId()
  return (
    <Modal
      open={open}
      onClose={onClose}
      labelledBy={headingId}
      panelClassName="w-[400px] max-w-[calc(100vw-32px)] rounded-2xl p-5"
    >
      <DialogBody
        headingId={headingId}
        origin={origin ?? window.location.origin}
        onClose={onClose}
      />
    </Modal>
  )
}

function DialogBody({
  headingId,
  origin,
  onClose,
}: {
  headingId: string
  origin: string
  onClose: () => void
}) {
  const [link, setLink] = useState<LinkState>({ kind: 'loading' })
  const [copied, setCopied] = useState(false)
  const expiryTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const alive = useRef(true)
  // Each mint's number. A reply to anything but the latest is dropped: in Strict
  // Mode the effect mints twice on one dialog, and the older reply can land last.
  const latestRequest = useRef(0)

  const clearExpiry = (): void => {
    if (expiryTimer.current !== null) clearTimeout(expiryTimer.current)
    expiryTimer.current = null
  }

  const mint = useCallback(async () => {
    const request = ++latestRequest.current
    const current = (): boolean => alive.current && request === latestRequest.current
    clearExpiry()
    setCopied(false)
    setLink({ kind: 'loading' })
    try {
      const res = await apiFetch('/api/access/launch-code', { method: 'POST' })
      const body = res.ok ? ((await res.json()) as LaunchCodeBody) : null
      if (!current()) return
      if (body?.gated === false) {
        setLink({ kind: 'ready', code: null })
        return
      }
      if (body?.gated !== true || typeof body.code !== 'string') {
        setLink({ kind: 'error' })
        return
      }
      setLink({ kind: 'ready', code: body.code })
      expiryTimer.current = setTimeout(
        () => {
          if (current()) setLink({ kind: 'expired' })
        },
        Math.max(0, body.expiresInMs ?? 0),
      )
    } catch {
      if (current()) setLink({ kind: 'error' })
    }
  }, [])

  useEffect(() => {
    alive.current = true
    void mint()
    return () => {
      alive.current = false
      clearExpiry()
    }
  }, [mint])

  const thisComputerOnly = isLoopbackHostname(safeHostname(origin))
  const url = link.kind === 'ready' ? deviceLink(origin, readInjectedBase(), link.code) : null

  const copy = async (): Promise<void> => {
    if (url === null) return
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
    } catch {
      // The link stays on screen to copy by hand.
    }
  }

  return (
    <div className="flex flex-col">
      <h2 id={headingId} className="text-base font-semibold text-foreground">
        Open on another device
      </h2>

      {link.kind === 'loading' && (
        <div className="mt-4 flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner size={14} />
          Making a sign-in link…
        </div>
      )}

      {link.kind === 'error' && (
        <p role="alert" className="mt-3 text-sm text-foreground/80">
          Could not make a link. Try again in a moment.
        </p>
      )}

      {link.kind === 'expired' && (
        <p className="mt-3 text-sm text-foreground/80">
          This link has expired. Make a new one when the other device is ready.
        </p>
      )}

      {link.kind === 'ready' && url !== null && (
        <>
          <p className="mt-1 text-sm text-muted-foreground">
            {link.code === null
              ? 'This server has no access token, so no sign-in is needed: anyone who can reach this address can open the dashboard.'
              : thisComputerOnly
                ? 'Open this link in another browser to sign it in.'
                : "Scan the code with your phone's camera, or open the link on the other device."}
          </p>

          {thisComputerOnly ? (
            <p className="mt-3 rounded-lg border border-border bg-background px-3 py-2 text-[13px] text-foreground/80">
              This address works only on this computer, because Clawboo is listening on this
              computer alone. A phone or another computer cannot reach it. To change that, see{' '}
              <a
                href={REACH_ANOTHER_MACHINE_DOCS}
                target="_blank"
                rel="noreferrer"
                className="font-medium text-primary underline-offset-2 hover:underline"
              >
                Reach Clawboo from another machine
              </a>
              .
            </p>
          ) : (
            <div
              data-testid="device-qr"
              className="mx-auto mt-4 rounded-xl bg-white p-3 shadow-[var(--shadow-raised)]"
            >
              {/* Black on white in both themes: phone cameras read that best. */}
              <QRCodeSVG
                value={url}
                size={176}
                level="M"
                bgColor="#ffffff"
                fgColor="#000000"
                role="img"
                aria-label="QR code of the sign-in link"
              />
            </div>
          )}

          <output
            data-testid="device-link"
            className="mt-4 block select-all break-all rounded-lg border border-border bg-background px-3 py-2 font-mono text-[12px] text-foreground"
          >
            {url}
          </output>

          {link.code !== null && (
            <p className="mt-2 text-xs text-muted-foreground">
              Works once, within 2 minutes. Anyone with the link can sign in, so share it only with
              the device you mean.
            </p>
          )}

          {link.code !== null && !thisComputerOnly && (
            // An app added to an iPhone's home screen keeps its own cookies, and
            // the QR code opens the phone's browser, so the app needs the link
            // pasted in (see AccessLock.tsx).
            <p className="mt-2 text-xs text-muted-foreground">
              An app added to a phone&apos;s home screen signs in when you paste this link on its
              locked screen: copy it, send it to the phone, and paste it there.
            </p>
          )}
        </>
      )}

      <div className="mt-5 flex flex-wrap items-center justify-end gap-2">
        {link.kind === 'ready' && (
          <Button variant="secondary" size="sm" onClick={() => void copy()}>
            {copied ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />}
            {copied ? 'Copied' : 'Copy link'}
          </Button>
        )}
        {link.kind !== 'loading' && (link.kind !== 'ready' || link.code !== null) && (
          <Button variant="secondary" size="sm" onClick={() => void mint()}>
            <RefreshCw size={14} aria-hidden />
            New link
          </Button>
        )}
        <Button variant="solid" size="sm" onClick={onClose}>
          Done
        </Button>
      </div>
    </div>
  )
}

function safeHostname(origin: string): string {
  try {
    return new URL(origin).hostname
  } catch {
    return ''
  }
}
