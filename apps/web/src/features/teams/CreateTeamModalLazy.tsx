// The lazy boundary that keeps the ~4.4 MB marketplace catalog off the SPA's entry
// chunk.
//
// `CreateTeamModal` statically imports `marketplace/teamCatalog` → `marketplace/agents`,
// so any eager importer of the modal drags all 304 agent + 82 team literals into the
// entry chunk — parsed on every dashboard load. That is exactly what happened after
// the panel-level split in #94: `MarketplacePanel` became lazy, but `WelcomeState` and
// the onboarding `SelectTeamStep` still imported the modal eagerly, so the catalog
// never actually left the boot path (issue #83).
//
// Two things make this work, and BOTH are required:
//   1. `lazy()` + a dynamic `import()`, so Rollup emits a separate chunk. On its own a
//      `manualChunks` entry is not enough — a named chunk that a static import still
//      reaches becomes a `modulepreload` of the entry and is downloaded at boot anyway.
//   2. Rendering nothing at all while closed. React starts fetching a lazy chunk the
//      first time the element renders, even if the component would immediately return
//      null — so the `isOpen` gate has to live out here, above `lazy`.
//
// Use this wherever the modal is reached from the eager tree. `MarketplacePanel`
// deliberately keeps the direct import: it is already behind `navPanels`' React.lazy
// and imports the catalog itself, so a second boundary there would only add a spinner
// flash inside an already-loaded chunk.

import { Button } from '@/features/shared/Button'
import { LazyBoundary } from '@/features/shared/LazyBoundary'
import { Spinner } from '@/features/shared/Spinner'
import { createRetryableLazy } from '@/lib/lazyRetry'

import type { CreateTeamModalProps } from '@/features/teams/CreateTeamModal'

// Module scope, NOT inside the component — a per-render `lazy()` factory produces a
// new component type every render, which remounts the modal and refetches its data.
//
// The specifier is the `@/` alias, not './CreateTeamModal', and that matters: the
// suites that stub the deploy engine do `vi.mock('@/features/teams/CreateTeamModal')`,
// and vitest keys mocks by the specifier as written. A relative import here silently
// bypasses that mock and drags the real 4.4 MB catalog into jsdom, where evaluating it
// blows past the test timeout — a hang, not a clean failure.
//
// `createRetryableLazy` rather than a bare `React.lazy`, matching every other lazy
// surface in the app: React.lazy memoizes a REJECTION onto the lazy object, so once
// this 4.1 MB chunk fails to download it re-throws forever and no error boundary can
// recover it. The wrapper lets the boundary mint a fresh lazy() so "Try again" really
// re-runs import(). See lib/lazyRetry.ts for what that can and cannot recover.
const CREATE_TEAM_MODAL = createRetryableLazy(() =>
  import('@/features/teams/CreateTeamModal').then((m) => ({ default: m.CreateTeamModal })),
)

/**
 * Start fetching the modal chunk before the user opens it — on hover/focus of a
 * "create team" control, or a step ahead in the onboarding wizard. Fire-and-forget:
 * a failure here is swallowed and the real `lazy()` load retries on open.
 */
export function preloadCreateTeamModal(): void {
  void import('@/features/teams/CreateTeamModal').catch(() => {})
}

/**
 * The modal's chrome with a spinner in place of its content. Mirrors the real
 * backdrop + card (`CreateTeamModal`'s pick step) so the swap is a spinner→content
 * crossfade inside an already-correct frame rather than a layout jump.
 *
 * Intentionally has no focusable element: the onboarding wizard's focus trap counts
 * focusables within its root, and a button here would shift its Tab wrap-around for
 * the one frame the chunk is loading. It also skips framer-motion — the real backdrop
 * fades in over this one, and animating both reads as a double fade.
 */
function CreateTeamModalFallback() {
  return (
    <div
      role="status"
      aria-busy="true"
      data-testid="create-team-modal-loading"
      className="fixed inset-0 z-50 flex items-center justify-center backdrop-blur-sm"
      style={{ background: 'var(--overlay-scrim)' }}
    >
      {/* An explicit height: `max-h-[85vh]` alone collapses an empty card to nothing,
          which would pop to full height the moment the real content arrives. */}
      <div
        className="flex h-[70vh] max-h-[85vh] w-full max-w-4xl items-center justify-center rounded-2xl border border-border bg-surface"
        style={{ boxShadow: 'var(--shadow-overlay)' }}
      >
        <Spinner size={20} />
        <span className="sr-only">Loading teams…</span>
      </div>
    </div>
  )
}

/**
 * Failure fallback. Keeps the modal's own backdrop rather than the default panel card,
 * which would otherwise tile into whatever layout slot the modal happens to occupy —
 * the `fallback` escape hatch exists for exactly this ("an overlay that must not
 * tile"). Unlike the loading fallback this one IS focusable, deliberately: by the time
 * it renders there is nothing left to load, and stranding the user in a dead overlay
 * with no way out would be worse than the transient focus-trap wobble.
 */
function CreateTeamModalErrorFallback({
  retry,
  onClose,
}: {
  retry: () => void
  onClose: () => void
}) {
  return (
    <div
      role="alertdialog"
      aria-label="Couldn't load the team marketplace"
      data-testid="create-team-modal-error"
      className="fixed inset-0 z-50 flex items-center justify-center backdrop-blur-sm"
      style={{ background: 'var(--overlay-scrim)' }}
    >
      <div
        className="flex w-full max-w-md flex-col gap-4 rounded-2xl border border-border bg-surface p-6"
        style={{ boxShadow: 'var(--shadow-overlay)' }}
      >
        <div>
          <h2 className="text-[15px] font-semibold text-foreground">
            Couldn&apos;t load the team marketplace
          </h2>
          <p className="mt-1 text-[13px] text-foreground/60">
            The catalog is a separate download, so a dropped connection can leave it unavailable.
            Retrying re-runs the download.
          </p>
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
          <Button variant="primary" onClick={retry}>
            Try again
          </Button>
        </div>
      </div>
    </div>
  )
}

export function CreateTeamModalLazy(props: CreateTeamModalProps) {
  // See (2) above — this gate is what defers the chunk. `CreateTeamModal` already
  // returns null when closed and `reset()`s every field on close, so not mounting it
  // while closed loses no state.
  if (!props.isOpen) return null

  return (
    <LazyBoundary
      source={CREATE_TEAM_MODAL}
      label="the team marketplace"
      suspenseFallback={<CreateTeamModalFallback />}
      render={(Modal) => <Modal {...props} />}
      logContext={{ surface: 'create-team-modal' }}
      fallback={({ retry }) => (
        <CreateTeamModalErrorFallback retry={retry} onClose={props.onClose} />
      )}
    />
  )
}
