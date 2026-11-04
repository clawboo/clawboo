// "Open on another device", at the foot of the sidebar: opens a dialog with a
// one-time sign-in link and a QR code of it. The dialog, and the QR code library
// with it, loads on the first click, so neither is on the dashboard's boot path.

import { useState } from 'react'
import { Smartphone } from 'lucide-react'

import { LazyBoundary } from '@/features/shared/LazyBoundary'
import { createRetryableLazy } from '@/lib/lazyRetry'

const dialogSource = createRetryableLazy(() =>
  import('./OpenOnAnotherDeviceDialog').then((m) => ({ default: m.OpenOnAnotherDeviceDialog })),
)

export function OpenOnAnotherDeviceButton() {
  const [open, setOpen] = useState(false)
  const [opened, setOpened] = useState(false)
  return (
    <>
      <button
        type="button"
        data-testid="open-on-another-device"
        onClick={() => {
          setOpened(true)
          setOpen(true)
        }}
        className="flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px] font-medium text-foreground/60 transition-colors duration-150 hover:bg-foreground/[0.035] hover:text-foreground/90"
      >
        <Smartphone
          size={17}
          strokeWidth={2}
          aria-hidden
          style={{ color: 'rgb(var(--foreground-rgb) / 0.45)' }}
        />
        <span className="truncate">Open on another device</span>
      </button>
      {/* Mounted from the first click on, so the dialog keeps its exit animation. */}
      {opened && (
        <LazyBoundary
          source={dialogSource}
          label="Open on another device"
          suspenseFallback={null}
          render={(Dialog) => <Dialog open={open} onClose={() => setOpen(false)} />}
          logContext={{ surface: 'open-on-another-device' }}
        />
      )}
    </>
  )
}
