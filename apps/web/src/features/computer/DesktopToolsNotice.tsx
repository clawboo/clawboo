// Why agents have no screen of their own here, and the fix Clawboo can make.
//
// On Linux x86_64 without Xvnc, a person can install the pinned desktop tools
// (TigerVNC's Xvnc, GPL-2.0, and Cua Driver, MIT) into Clawboo's runtimes folder
// from here. Where displays work but Cua Driver is not installed, it offers Cua
// Driver alone. On arm64 without Xvnc it says to install TigerVNC with the
// package manager (TigerVNC publishes no arm64 build). When a display could not
// start (a system library missing), it says which. On a Mac or Windows, or where
// displays are turned off, it says nothing: the browser view is all there is.

import { useState } from 'react'
import { apiFetch } from '@clawboo/control-client'

export type DisplaysStatus =
  | {
      available: true
      problem?: string | null
      driverInstallable?: boolean
    }
  | {
      available: false
      code?: 'platform' | 'off' | 'no-xvnc'
      reason?: string
      installable?: boolean
    }

export function DesktopToolsNotice({
  displays,
  onInstalled,
}: {
  displays: DisplaysStatus | null
  onInstalled: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (!displays) return null
  const offer: 'all' | 'driver' | null = displays.available
    ? displays.driverInstallable
      ? 'driver'
      : null
    : displays.installable
      ? 'all'
      : null
  const note = displays.available
    ? (displays.problem ?? null)
    : displays.code === 'no-xvnc' && !displays.installable
      ? (displays.reason ?? null)
      : null
  if (!offer && !note) return null

  const install = async () => {
    setBusy(true)
    setError(null)
    const r = await apiFetch('/api/computer/tools/install', { method: 'POST' }).catch(() => null)
    const body = (await r?.json().catch(() => null)) as { error?: string } | null
    setBusy(false)
    if (r?.ok) onInstalled()
    else setError(body?.error ?? 'Could not install the desktop tools.')
  }

  return (
    <div
      className="mx-3 mt-2 flex flex-col gap-1.5 rounded-md border border-border bg-card/50 p-2 text-[12px] text-muted-foreground"
      data-testid="desktop-tools-notice"
    >
      {note && <p>{note}</p>}
      {offer && (
        <>
          <p>
            {offer === 'all'
              ? 'Each agent can have a screen of its own here, which you can watch and take over. It needs TigerVNC’s Xvnc (GPL-2.0) and, for driving Linux apps where agents run as their own OS user, Cua Driver (MIT). Clawboo can install both into its own folder, checked against pinned releases.'
              : 'Cua Driver (MIT) lets an agent work the Linux apps on its own screen, once you connect it. Clawboo can install it into its own folder, checked against a pinned release.'}
          </p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => void install()}
              className="rounded-md border border-border bg-input px-2 py-0.5 text-[12px] text-foreground hover:bg-foreground/[0.06] disabled:opacity-50"
            >
              {busy
                ? 'Installing…'
                : offer === 'all'
                  ? 'Install the desktop tools'
                  : 'Install Cua Driver'}
            </button>
          </div>
        </>
      )}
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
    </div>
  )
}
