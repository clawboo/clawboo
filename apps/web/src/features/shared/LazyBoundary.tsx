// ErrorBoundary + Suspense + retry-that-re-imports, in one seam.
//
// Every lazily-loaded surface in the app renders through this. It solves the
// problem a bare <Suspense> cannot: Suspense covers the WAIT, not the FAILURE —
// when a chunk import rejects, the promise throws past the Suspense boundary and
// (before this existed) unwound all the way to the root, blanking the app.
//
// The boundary sits OUTSIDE Suspense so the fallback card REPLACES the spinner,
// rather than rendering beneath a spinner that will never resolve.
//
// Renders NO DOM of its own in the success path — the lazy component lands
// directly in the parent container, exactly as the bare <Suspense> it replaces
// did. That matters: panel roots are `h-full` and rely on being a direct child of
// a sized parent.

import { Suspense, useState, type LazyExoticComponent, type ReactNode } from 'react'

import { ErrorBoundary, type ErrorBoundaryProps } from './ErrorBoundary'
import type { AnyComponent, RetryableLazy } from '@/lib/lazyRetry'

export interface LazyBoundaryProps<T extends AnyComponent> {
  /** The retryable lazy created with `createRetryableLazy`. */
  source: RetryableLazy<T>
  /** Surface name for the fallback copy — `Couldn't load {label}.` */
  label: string
  /** Suspense fallback. Must preserve the parent's sizing (see PaneFallback et al). */
  suspenseFallback: ReactNode
  /** Render the lazy component with whatever props it needs. */
  render: (Component: LazyExoticComponent<T>) => ReactNode
  /** Extra fields for the console.error payload. */
  logContext?: Record<string, unknown>
  /** Bespoke fallback, for surfaces where the default card would not fit. */
  fallback?: ErrorBoundaryProps['fallback']
  /** Layout escape hatch — merged onto the default fallback's root. */
  fallbackClassName?: string
  fallbackStyle?: ErrorBoundaryProps['fallbackStyle']
}

export function LazyBoundary<T extends AnyComponent>({
  source,
  label,
  suspenseFallback,
  render,
  logContext,
  fallback,
  fallbackClassName,
  fallbackStyle,
}: LazyBoundaryProps<T>) {
  // Seeded from module scope, not from 0, so a retry that already succeeded stays
  // in effect after this component unmounts and remounts (ContentArea remounts
  // the whole view subtree whenever `key={viewKey}` changes).
  const [attempt, setAttempt] = useState(() => source.currentAttempt())
  const Component = source.get(attempt)

  return (
    <ErrorBoundary
      variant="panel"
      label={label}
      resetKeys={[attempt]}
      logContext={logContext}
      onRetry={() => setAttempt(source.nextAttempt())}
      fallback={fallback}
      fallbackClassName={fallbackClassName}
      fallbackStyle={fallbackStyle}
    >
      <Suspense fallback={suspenseFallback}>{render(Component)}</Suspense>
    </ErrorBoundary>
  )
}
