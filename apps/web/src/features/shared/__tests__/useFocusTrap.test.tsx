// useFocusTrap — the interaction-level a11y jest-axe cannot see: focus moves
// INTO the dialog on mount, Tab cycles within it, and focus returns to the
// trigger on unmount. The nesting cases are the reason the trap stack exists:
// every trap binds Tab to `window`, so two mounted traps would otherwise both
// run for the same key and fight over where focus lands.

import { useRef, useState } from 'react'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'

import { useFocusTrap } from '../useFocusTrap'

afterEach(() => cleanup())

function Dialog({
  name,
  children,
  useInitialFocus = false,
}: {
  name: string
  children?: React.ReactNode
  useInitialFocus?: boolean
}) {
  const ref = useRef<HTMLDivElement | null>(null)
  const secondRef = useRef<HTMLButtonElement | null>(null)
  useFocusTrap(ref, 0, useInitialFocus ? secondRef : undefined)
  return (
    <div ref={ref} tabIndex={-1} data-testid={`dialog-${name}`}>
      <button type="button">{name} first</button>
      <button type="button" ref={secondRef}>
        {name} second
      </button>
      <button type="button">{name} last</button>
      {children}
    </div>
  )
}

/** A trigger + a dialog it opens, so focus-return has somewhere to return to. */
function TriggerAndDialog() {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open
      </button>
      {open && (
        <Dialog name="outer">
          <button type="button" onClick={() => setOpen(false)}>
            Close
          </button>
        </Dialog>
      )}
    </>
  )
}

/**
 * A trigger that is DESTROYED and re-created while its dialog is open — the board card
 * whose task changes column under an open drawer. Flipping `moved` swaps the wrapper
 * element type, so React cannot reuse the button: the replacement is a genuinely
 * different DOM node carrying the same `data-focus-restore-id`.
 */
function RecreatedTrigger({ tagged = true }: { tagged?: boolean }) {
  const [open, setOpen] = useState(false)
  const [moved, setMoved] = useState(false)
  const card = (
    // `undefined` omits the attribute entirely, so `tagged={false}` is a genuinely
    // untagged trigger rather than one carrying an empty id.
    <button
      type="button"
      data-focus-restore-id={tagged ? 't1' : undefined}
      onClick={() => setOpen(true)}
    >
      Card
    </button>
  )
  return (
    <>
      {moved ? <section>{card}</section> : <div>{card}</div>}
      {open && (
        <Dialog name="outer">
          <button type="button" onClick={() => setMoved(true)}>
            Move
          </button>
          <button type="button" onClick={() => setOpen(false)}>
            Close
          </button>
        </Dialog>
      )}
    </>
  )
}

/**
 * Two stacked dialogs in the topology the app actually uses: the inner one is a
 * DOM SIBLING of the outer, not a descendant — `CreateTeamModal` renders
 * `TeamTemplateDetail` as a sibling `<Modal>` at a higher layer.
 *
 * The distinction is load-bearing for this test. If the inner dialog were nested
 * INSIDE the outer's element, the outer trap's `root.contains(active)` would be
 * true and its `querySelectorAll` would already include the inner's buttons, so
 * it would happen to agree with the inner trap and the test would pass with or
 * without the stack. As siblings, an unarbitrated outer trap sees focus as
 * "outside" itself and yanks it back — which is the real bug.
 */
function StackedDialogs() {
  const [innerOpen, setInnerOpen] = useState(false)
  return (
    <>
      <Dialog name="outer">
        <button type="button" onClick={() => setInnerOpen(true)}>
          Open inner
        </button>
      </Dialog>
      {innerOpen && (
        <Dialog name="inner">
          <button type="button" onClick={() => setInnerOpen(false)}>
            Close inner
          </button>
        </Dialog>
      )}
    </>
  )
}

describe('useFocusTrap', () => {
  it('moves focus to the first focusable on mount', async () => {
    render(<Dialog name="outer" />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'outer first' })).toHaveFocus())
  })

  it('honours initialFocusRef over the first focusable', async () => {
    render(<Dialog name="outer" useInitialFocus />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'outer second' })).toHaveFocus())
  })

  it('wraps Tab from the last focusable back to the first', async () => {
    const user = userEvent.setup()
    render(<Dialog name="outer" />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'outer first' })).toHaveFocus())

    screen.getByRole('button', { name: 'outer last' }).focus()
    await user.tab()
    expect(screen.getByRole('button', { name: 'outer first' })).toHaveFocus()
  })

  it('wraps Shift+Tab from the first focusable back to the last', async () => {
    const user = userEvent.setup()
    render(<Dialog name="outer" />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'outer first' })).toHaveFocus())

    await user.tab({ shift: true })
    expect(screen.getByRole('button', { name: 'outer last' })).toHaveFocus()
  })

  it('pulls focus back inside when Tab is pressed from outside the dialog', async () => {
    const user = userEvent.setup()
    render(<Dialog name="outer" />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'outer first' })).toHaveFocus())

    // Focus lands on <body> between step swaps — the reason the Tab listener is
    // bound to `window` rather than to the dialog element.
    ;(document.activeElement as HTMLElement).blur()
    expect(document.activeElement).toBe(document.body)
    await user.tab()
    expect(screen.getByRole('button', { name: 'outer first' })).toHaveFocus()
  })

  it('parks focus on the dialog root when nothing inside is tabbable', async () => {
    const user = userEvent.setup()
    function Empty() {
      const ref = useRef<HTMLDivElement | null>(null)
      useFocusTrap(ref, 0)
      return (
        <div ref={ref} tabIndex={-1} data-testid="dialog-empty">
          <p>Nothing focusable here.</p>
        </div>
      )
    }
    render(<Empty />)
    const root = screen.getByTestId('dialog-empty')
    await waitFor(() => expect(root).toHaveFocus())

    // Focus escaping to <body> then Tab must land back on the root, not be
    // silently swallowed — otherwise the user is stranded outside an
    // aria-modal dialog with no keyboard route back in.
    ;(document.activeElement as HTMLElement).blur()
    expect(document.activeElement).toBe(document.body)
    await user.tab()
    expect(root).toHaveFocus()
  })

  it('restores focus to the trigger on unmount', async () => {
    const user = userEvent.setup()
    render(<TriggerAndDialog />)
    const trigger = screen.getByRole('button', { name: 'Open' })

    await user.click(trigger)
    await waitFor(() => expect(screen.getByRole('button', { name: 'outer first' })).toHaveFocus())

    await user.click(screen.getByRole('button', { name: 'Close' }))
    expect(trigger).toHaveFocus()
  })

  it('re-finds a trigger that was re-created while the dialog was open', async () => {
    // `.focus()` on a detached node is a SILENT no-op, so restoring to the captured
    // reference would strand focus on <body> and send the next Tab to the top of the
    // document. The trigger's `data-focus-restore-id` is what makes the return survive
    // its own node being replaced (a board card moving column under an open drawer).
    const user = userEvent.setup()
    render(<RecreatedTrigger />)
    const original = screen.getByRole('button', { name: 'Card' })

    await user.click(original)
    await waitFor(() => expect(screen.getByRole('button', { name: 'outer first' })).toHaveFocus())

    await user.click(screen.getByRole('button', { name: 'Move' }))
    expect(original.isConnected).toBe(false) // the captured trigger is gone

    await user.click(screen.getByRole('button', { name: 'Close' }))
    const replacement = screen.getByRole('button', { name: 'Card' })
    expect(replacement).not.toBe(original)
    expect(replacement).toHaveFocus()
    expect(document.activeElement).not.toBe(document.body)
  })

  it('does not re-find a re-created trigger that is untagged', async () => {
    // The re-find is strictly opt-in: with no `data-focus-restore-id` the trap has no
    // way to tell the replacement apart from any other button, so it must NOT guess.
    // Same journey as the test above, minus the tag — the replacement stays unfocused.
    // This is the boundary of the opt-in, and the reason a consumer has to tag its
    // trigger to get the behavior at all.
    const user = userEvent.setup()
    render(<RecreatedTrigger tagged={false} />)
    const original = screen.getByRole('button', { name: 'Card' })
    expect(original.dataset['focusRestoreId']).toBeUndefined()

    await user.click(original)
    await waitFor(() => expect(screen.getByRole('button', { name: 'outer first' })).toHaveFocus())

    await user.click(screen.getByRole('button', { name: 'Move' }))
    expect(original.isConnected).toBe(false)

    await user.click(screen.getByRole('button', { name: 'Close' }))
    const replacement = screen.getByRole('button', { name: 'Card' })
    expect(replacement).not.toBe(original)
    expect(replacement).not.toHaveFocus()
    expect(document.activeElement).toBe(document.body)
  })

  describe('stacked traps', () => {
    it('gives Tab to the topmost trap only', async () => {
      const user = userEvent.setup()
      render(<StackedDialogs />)
      await waitFor(() => expect(screen.getByRole('button', { name: 'outer first' })).toHaveFocus())

      await user.click(screen.getByRole('button', { name: 'Open inner' }))
      await waitFor(() => expect(screen.getByRole('button', { name: 'inner first' })).toHaveFocus())

      // Tab anywhere inside the inner dialog stays inside it. Without the stack,
      // the outer trap also fires, sees focus outside ITS root, and drags focus
      // back to "outer first".
      screen.getByRole('button', { name: 'inner second' }).focus()
      await user.tab()
      expect(screen.getByRole('button', { name: 'inner last' })).toHaveFocus()

      // ...including the wrap at the end of the inner dialog.
      screen.getByRole('button', { name: 'Close inner' }).focus()
      await user.tab()
      expect(screen.getByRole('button', { name: 'inner first' })).toHaveFocus()
    })

    it('returns Tab ownership to the outer trap when the inner unmounts', async () => {
      const user = userEvent.setup()
      render(<StackedDialogs />)
      await user.click(screen.getByRole('button', { name: 'Open inner' }))
      await waitFor(() => expect(screen.getByRole('button', { name: 'inner first' })).toHaveFocus())

      await user.click(screen.getByRole('button', { name: 'Close inner' }))
      expect(screen.queryByTestId('dialog-inner')).toBeNull()

      // The outer's LAST focusable is the "Open inner" button.
      screen.getByRole('button', { name: 'Open inner' }).focus()
      await user.tab()
      expect(screen.getByRole('button', { name: 'outer first' })).toHaveFocus()
    })
  })
})
