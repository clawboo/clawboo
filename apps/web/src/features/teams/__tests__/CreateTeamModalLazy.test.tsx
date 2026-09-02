// CreateTeamModalLazy: the boundary that keeps the marketplace surfaces off
// the SPA entry chunk (issue #83). Two behaviours carry that guarantee and are easy to
// regress, so they're pinned here:
//
//   1. Closed renders NOTHING. React starts fetching a lazy chunk the first time the
//      element renders — even if the component would immediately return null — so the
//      `isOpen` gate has to be OUTSIDE `lazy`, not inside CreateTeamModal.
//   2. Open shows the loading frame, then swaps in the real modal.
//   3. A failure inside that boundary degrades to a dismissible overlay rather than
//      unwinding to the root and blanking the app — the reason this goes through
//      `LazyBoundary` instead of a bare <Suspense>.
//
// The real modal is stubbed: it has its own suites, and the point here is the wrapper.

import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

// `evaluated` counts how many times the mocked module was actually pulled in. Vitest
// runs a factory mock lazily — on first import of that specifier — so the counter is a
// direct proxy for "did the lazy chunk get fetched?", which is the property that keeps
// the marketplace surfaces off the entry chunk. `vi.hoisted` because vi.mock is hoisted.
const evaluated = vi.hoisted(() => ({ count: 0 }))

// Flipped by the failure test to make the stub throw during render, which is what
// a boundary sees when a lazy surface blows up.
const boom = vi.hoisted(() => ({ on: false }))

vi.mock('@/features/teams/CreateTeamModal', () => {
  evaluated.count += 1
  return {
    CreateTeamModal: ({ isOpen }: { isOpen: boolean }) => {
      if (boom.on) throw new Error('chunk boom')
      return isOpen ? <div data-testid="real-create-team-modal">real modal</div> : null
    },
  }
})

const { CreateTeamModalLazy } = await import('../CreateTeamModalLazy')

afterEach(() => cleanup())

describe('CreateTeamModalLazy', () => {
  it('renders nothing while closed, and never even loads the modal module', async () => {
    const before = evaluated.count
    const { container } = render(
      <CreateTeamModalLazy isOpen={false} onClose={vi.fn()} onCreated={vi.fn()} />,
    )
    expect(container).toBeEmptyDOMElement()
    expect(screen.queryByTestId('create-team-modal-loading')).not.toBeInTheDocument()

    // Give any stray dynamic import a chance to resolve before asserting it did not
    // happen — otherwise this passes for the wrong reason (nothing has settled yet).
    await Promise.resolve()
    await Promise.resolve()
    expect(evaluated.count).toBe(before)
  })

  it('shows the loading frame, then the real modal, once opened', async () => {
    render(<CreateTeamModalLazy isOpen onClose={vi.fn()} onCreated={vi.fn()} />)

    // The Suspense fallback announces itself to assistive tech while the chunk loads.
    const loading = screen.getByTestId('create-team-modal-loading')
    expect(loading).toHaveAttribute('role', 'status')
    expect(loading).toHaveAttribute('aria-busy', 'true')
    // No focusable element inside — the onboarding wizard's focus trap counts
    // focusables within its root, and one here would shift its Tab wrap-around for
    // the frame the chunk is loading.
    expect(loading.querySelectorAll('a, button, input, select, textarea, [tabindex]')).toHaveLength(
      0,
    )

    expect(await screen.findByTestId('real-create-team-modal')).toBeInTheDocument()
    expect(screen.queryByTestId('create-team-modal-loading')).not.toBeInTheDocument()
  })

  it('degrades to a dismissible overlay when the lazy surface throws', async () => {
    // The boundary logs the caught error via console.error; silence it so the run
    // output stays readable, and so the repo's no-noise expectation is not violated.
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {})
    boom.on = true
    const onClose = vi.fn()
    try {
      render(<CreateTeamModalLazy isOpen onClose={onClose} onCreated={vi.fn()} />)

      const card = await screen.findByTestId('create-team-modal-error')
      // Still an overlay, not a card tiled into the parent's layout slot.
      expect(card).toHaveAttribute('role', 'alertdialog')
      // And the user can actually get out — the failure mode this replaces was a
      // dead overlay (or, before LazyBoundary, a blank app).
      await userEvent.click(screen.getByRole('button', { name: 'Close' }))
      expect(onClose).toHaveBeenCalledTimes(1)
      expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument()
    } finally {
      boom.on = false
      quiet.mockRestore()
    }
  })
})
