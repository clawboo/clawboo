// Retryable React.lazy.
//
// React.lazy memoizes its factory result ON the lazy object — including a
// REJECTION. Once a chunk import fails, that lazy component re-throws the same
// error on every subsequent render, forever. So an error boundary that merely
// clears its own state cannot recover a failed panel: the only way to re-run
// import() is a brand-new lazy().
//
// `get(attempt)` returns a STABLE lazy per attempt index (so ordinary re-renders
// never remount or re-suspend a healthy panel), and `nextAttempt()` moves to a
// fresh one.
//
// The attempt index is module-scoped on purpose. ContentArea remounts its whole
// subtree when `key={viewKey}` changes, so a React-state counter would reset to
// 0 on nav-away — sending a user who just successfully retried the Board
// straight back to the rejected `attempt 0` lazy when they came back.
//
// ⚠ What a retry can and cannot recover. A fresh lazy() re-runs import(), which
// genuinely recovers a render-time throw — the common case, and the one worth
// having. It does NOT reliably recover a chunk 404 or a parse error: per the
// HTML spec a module-map entry whose fetch failed is cached, so the browser
// rejects the re-import immediately with no network request. That is why every
// fallback also offers a page reload — the one guaranteed escape hatch. Do not
// "fix" the 404 case; it is a browser invariant, not a bug in this wrapper.

import { lazy, type ComponentType, type LazyExoticComponent } from 'react'

/**
 * The props-agnostic component bound — verbatim the one `React.lazy` and
 * `LazyExoticComponent` are declared with.
 *
 * Two things force it. First, the generic must range over the COMPONENT, not its
 * props: parameterising by props puts the type variable in a purely contravariant
 * position, where TypeScript infers `never` and every prop-taking loader fails to
 * assign. Second, `LazyExoticComponent<T>` itself demands `T extends
 * ComponentType<any>`, and no `any`-free top type satisfies that —
 * `ComponentType<never>` fails on `ComponentClass.defaultProps` (a covariant
 * `Partial<P>`), and `FunctionComponent<never>` fails because `any` is assignable
 * to everything except `never`.
 *
 * So the `any` is confined to this one alias, which keeps it out of every call
 * site: consumers write `RetryableLazy<typeof MyPanel>` and stay fully typed.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- see above; mirrors React.lazy's own constraint
export type AnyComponent = ComponentType<any>

export interface RetryableLazy<T extends AnyComponent> {
  /** Stable lazy component for `attempt`. Same attempt ⇒ same identity. */
  get(attempt: number): LazyExoticComponent<T>
  /** The attempt index a freshly-mounting consumer should start on. */
  currentAttempt(): number
  /** Advance to a fresh lazy() and return the new attempt index. */
  nextAttempt(): number
}

export function createRetryableLazy<T extends AnyComponent>(
  load: () => Promise<{ default: T }>,
): RetryableLazy<T> {
  // One entry per user-initiated retry, for the lifetime of the tab. Old entries
  // are deliberately NOT evicted: the same source can be mounted twice at once
  // (a nav panel in ContentArea and the same view inside the Settings modal), so
  // dropping an attempt another live instance is still rendering would hand it a
  // new component type — an unnecessary remount plus a re-suspend flash.
  const cache = new Map<number, LazyExoticComponent<T>>()
  let attempt = 0

  return {
    get(n) {
      let Cached = cache.get(n)
      if (!Cached) {
        Cached = lazy(load)
        cache.set(n, Cached)
      }
      return Cached
    },
    currentAttempt: () => attempt,
    nextAttempt: () => (attempt += 1),
  }
}
