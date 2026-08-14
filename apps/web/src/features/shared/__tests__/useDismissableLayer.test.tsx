// The dismissable-layer stack — the single owner of "dismiss the thing on top",
// for both Escape and a press outside a layer.
//
// These lock the properties the rest of the app now depends on: only the
// TOPMOST open layer reacts, an open layer shields every global listener behind
// it, a handler nearer the event target can veto with preventDefault(), a press
// dismisses one layer without swallowing the click, and with nothing open the
// stack is completely inert.

import { StrictMode, useRef, useState } from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { hasOpenLayer, useDismissableLayer } from '../useDismissableLayer'

// Global listeners a test adds, torn down even if it fails.
const spies: (() => void)[] = []

function onDocumentKeyDown(fn: (e: KeyboardEvent) => void): void {
  document.addEventListener('keydown', fn)
  spies.push(() => document.removeEventListener('keydown', fn))
}
function onWindowKeyDown(fn: (e: KeyboardEvent) => void): void {
  window.addEventListener('keydown', fn)
  spies.push(() => window.removeEventListener('keydown', fn))
}
function onDocumentMouseDown(fn: (e: MouseEvent) => void): void {
  document.addEventListener('mousedown', fn)
  spies.push(() => document.removeEventListener('mousedown', fn))
}

afterEach(() => {
  spies.splice(0).forEach((off) => off())
  cleanup()
  // Every layer must have been popped by unmount — a leak would silently eat
  // the next test's dismissals.
  expect(hasOpenLayer()).toBe(false)
})

/** A dialog with a dropdown inside it — the shape the whole fix is about. Both
 *  own both channels, and `outside` is a click target belonging to neither. */
function DialogWithMenu({ menuInitiallyOpen = true }: { menuInitiallyOpen?: boolean }) {
  const [dialogOpen, setDialogOpen] = useState(true)
  const [menuOpen, setMenuOpen] = useState(menuInitiallyOpen)
  const dialogRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  useDismissableLayer({
    active: dialogOpen,
    level: 'dialog',
    onEscape: () => setDialogOpen(false),
    contains: (t) => !!dialogRef.current?.contains(t),
    onPressOutside: () => setDialogOpen(false),
  })
  useDismissableLayer({
    active: menuOpen,
    level: 'popover',
    onEscape: () => setMenuOpen(false),
    contains: (t) => !!menuRef.current?.contains(t),
    onPressOutside: () => setMenuOpen(false),
  })

  return (
    <>
      <button data-testid="scrim">scrim</button>
      {dialogOpen && (
        <div ref={dialogRef} data-testid="dialog">
          <button data-testid="in-dialog">in dialog</button>
        </div>
      )}
      {menuOpen && (
        <div ref={menuRef} data-testid="menu">
          <button data-testid="in-menu">in menu</button>
        </div>
      )}
    </>
  )
}

describe('useDismissableLayer — Escape', () => {
  it('is inert while nothing is open', async () => {
    const seen = vi.fn()
    onDocumentKeyDown(seen)
    render(<DialogWithMenu menuInitiallyOpen={false} />)
    // Close the only layer, then press Escape again with an empty stack.
    await userEvent.keyboard('{Escape}')
    expect(screen.queryByTestId('dialog')).toBeNull()
    expect(hasOpenLayer()).toBe(false)

    seen.mockClear()
    await userEvent.keyboard('{Escape}')
    expect(seen).toHaveBeenCalledTimes(1)
    expect(seen.mock.calls[0]![0].defaultPrevented).toBe(false)
  })

  it('gives Escape to the topmost layer only, one layer per press', async () => {
    render(<DialogWithMenu />)
    // The dropdown inside the dialog goes first…
    await userEvent.keyboard('{Escape}')
    expect(screen.queryByTestId('menu')).toBeNull()
    expect(screen.getByTestId('dialog')).toBeInTheDocument()
    // …and only then the dialog.
    await userEvent.keyboard('{Escape}')
    expect(screen.queryByTestId('dialog')).toBeNull()
  })

  it('shields global listeners but still lets a React handler nearer the target run', async () => {
    const documentSpy = vi.fn()
    const windowSpy = vi.fn()
    const reactSpy = vi.fn()
    onDocumentKeyDown(documentSpy)
    onWindowKeyDown(windowSpy)

    function Host() {
      const [open, setOpen] = useState(true)
      useDismissableLayer({ active: open, level: 'dialog', onEscape: () => setOpen(false) })
      return open ? <input aria-label="field" autoFocus onKeyDown={(e) => reactSpy(e.key)} /> : null
    }
    render(<Host />)
    expect(screen.getByLabelText('field')).toHaveFocus()

    await userEvent.keyboard('{Escape}')
    expect(screen.queryByLabelText('field')).toBeNull() // the layer dismissed
    expect(reactSpy).toHaveBeenCalledWith('Escape') // React ran FIRST, not blocked
    expect(documentSpy).not.toHaveBeenCalled() // stopImmediatePropagation
    expect(windowSpy).not.toHaveBeenCalled() // stopPropagation
  })

  it('lets a nearer handler veto with preventDefault()', async () => {
    const onEscape = vi.fn()
    function Host() {
      useDismissableLayer({ active: true, level: 'dialog', onEscape })
      return (
        <input
          aria-label="field"
          autoFocus
          onKeyDown={(e) => {
            if (e.key === 'Escape') e.preventDefault()
          }}
        />
      )
    }
    const { unmount } = render(<Host />)
    await userEvent.keyboard('{Escape}')
    expect(onEscape).not.toHaveBeenCalled()
    unmount()
  })

  it('ranks a popover above a dialog regardless of which opened first', async () => {
    const onPopover = vi.fn()
    const onDialog = vi.fn()
    function Host({ dialog }: { dialog: boolean }) {
      useDismissableLayer({ active: true, level: 'popover', onEscape: onPopover })
      useDismissableLayer({ active: dialog, level: 'dialog', onEscape: onDialog })
      return null
    }
    // The popover is pushed first; the dialog joins the stack afterwards.
    const { rerender, unmount } = render(<Host dialog={false} />)
    rerender(<Host dialog />)

    await userEvent.keyboard('{Escape}')
    expect(onPopover).toHaveBeenCalledTimes(1)
    expect(onDialog).not.toHaveBeenCalled()
    unmount()
  })

  it('survives StrictMode double-invoked effects (no zombie layer)', async () => {
    const onEscape = vi.fn()
    function Host() {
      useDismissableLayer({ active: true, level: 'dialog', onEscape })
      return null
    }
    const { unmount } = render(
      <StrictMode>
        <Host />
      </StrictMode>,
    )
    await userEvent.keyboard('{Escape}')
    expect(onEscape).toHaveBeenCalledTimes(1)

    // After unmount the stack is empty and Escape reaches the app again.
    unmount()
    expect(hasOpenLayer()).toBe(false)
    const seen = vi.fn()
    onDocumentKeyDown(seen)
    await userEvent.keyboard('{Escape}')
    expect(seen).toHaveBeenCalledTimes(1)
  })

  it('handles layers unmounting out of order', async () => {
    const onFirst = vi.fn()
    const onSecond = vi.fn()
    function Host({ first }: { first: boolean }) {
      useDismissableLayer({ active: first, level: 'dialog', onEscape: onFirst })
      useDismissableLayer({ active: true, level: 'dialog', onEscape: onSecond })
      return null
    }
    // `first` opened first but closes first too — removal must be by identity,
    // not a pop(), or the survivor would be dropped instead.
    const { rerender, unmount } = render(<Host first />)
    rerender(<Host first={false} />)

    await userEvent.keyboard('{Escape}')
    expect(onSecond).toHaveBeenCalledTimes(1)
    expect(onFirst).not.toHaveBeenCalled()
    unmount()
  })

  it('ignores Escape during an IME composition', () => {
    const onEscape = vi.fn()
    function Host() {
      useDismissableLayer({ active: true, level: 'dialog', onEscape })
      return null
    }
    const { unmount } = render(<Host />)

    for (const init of [{ isComposing: true }, { keyCode: 229 }]) {
      const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, ...init })
      document.body.dispatchEvent(event)
      expect(onEscape).not.toHaveBeenCalled()
      // Not swallowed either — the composition's own handler must still see it.
      expect(event.defaultPrevented).toBe(false)
    }
    unmount()
  })

  it('ignores every other key', async () => {
    const onEscape = vi.fn()
    function Host() {
      useDismissableLayer({ active: true, level: 'dialog', onEscape })
      return <input aria-label="field" autoFocus />
    }
    const { unmount } = render(<Host />)
    await userEvent.keyboard('hello{Enter}{ArrowDown}')
    expect(onEscape).not.toHaveBeenCalled()
    expect(screen.getByLabelText('field')).toHaveValue('hello')
    unmount()
  })
})

describe('useDismissableLayer — press outside', () => {
  it('is inert while nothing is open', async () => {
    const seen = vi.fn()
    onDocumentMouseDown(seen)
    render(<DialogWithMenu menuInitiallyOpen={false} />)
    await userEvent.click(screen.getByTestId('scrim')) // closes the dialog
    expect(screen.queryByTestId('dialog')).toBeNull()

    seen.mockClear()
    await userEvent.click(screen.getByTestId('scrim'))
    expect(seen).toHaveBeenCalledTimes(1)
  })

  it('dismisses only the topmost layer, one layer per press', async () => {
    render(<DialogWithMenu />)
    // Pressing the scrim is outside BOTH — but only the dropdown goes.
    await userEvent.click(screen.getByTestId('scrim'))
    expect(screen.queryByTestId('menu')).toBeNull()
    expect(screen.getByTestId('dialog')).toBeInTheDocument()
    // The next press reaches the dialog.
    await userEvent.click(screen.getByTestId('scrim'))
    expect(screen.queryByTestId('dialog')).toBeNull()
  })

  it('treats a press inside the dialog as outside the dropdown above it', async () => {
    render(<DialogWithMenu />)
    await userEvent.click(screen.getByTestId('in-dialog'))
    expect(screen.queryByTestId('menu')).toBeNull()
    expect(screen.getByTestId('dialog')).toBeInTheDocument()
  })

  it('does nothing when the press lands inside the topmost layer', async () => {
    render(<DialogWithMenu />)
    await userEvent.click(screen.getByTestId('in-menu'))
    expect(screen.getByTestId('menu')).toBeInTheDocument()
    expect(screen.getByTestId('dialog')).toBeInTheDocument()
  })

  it('dismisses without swallowing the click', async () => {
    // A press outside a dropdown but on a real control must still activate it —
    // that is why the press pass deliberately does not stop the event.
    const clicked = vi.fn()
    function Host() {
      const [open, setOpen] = useState(true)
      const menuRef = useRef<HTMLDivElement>(null)
      useDismissableLayer({
        active: open,
        level: 'popover',
        contains: (t) => !!menuRef.current?.contains(t),
        onPressOutside: () => setOpen(false),
      })
      return (
        <>
          <button onClick={clicked}>Save</button>
          {open && <div ref={menuRef} data-testid="menu" />}
        </>
      )
    }
    const { unmount } = render(<Host />)
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(screen.queryByTestId('menu')).toBeNull()
    expect(clicked).toHaveBeenCalledTimes(1)
    unmount()
  })

  it('skips layers that do not take part in press dismissal', async () => {
    // A mandatory full-screen wizard owns Escape but has no scrim to click; the
    // dropdown inside it must still be the one a press dismisses.
    const onWizardEscape = vi.fn()
    function Host() {
      const [menuOpen, setMenuOpen] = useState(true)
      const menuRef = useRef<HTMLDivElement>(null)
      useDismissableLayer({ active: true, level: 'dialog', onEscape: onWizardEscape })
      useDismissableLayer({
        active: menuOpen,
        level: 'popover',
        contains: (t) => !!menuRef.current?.contains(t),
        onPressOutside: () => setMenuOpen(false),
      })
      return (
        <>
          <button data-testid="elsewhere">elsewhere</button>
          {menuOpen && <div ref={menuRef} data-testid="menu" />}
        </>
      )
    }
    const { unmount } = render(<Host />)
    await userEvent.click(screen.getByTestId('elsewhere'))
    expect(screen.queryByTestId('menu')).toBeNull()
    expect(onWizardEscape).not.toHaveBeenCalled()
    unmount()
  })

  it('a press-only layer stays invisible to hasOpenLayer()', () => {
    // The Settings modal takes part in press dismissal but leaves Escape to the
    // app shell — so it must not make the shell stand down.
    function Host() {
      useDismissableLayer({
        active: true,
        level: 'dialog',
        contains: () => false,
        onPressOutside: vi.fn(),
      })
      return null
    }
    const { unmount } = render(<Host />)
    expect(hasOpenLayer()).toBe(false)
    unmount()
  })
})
