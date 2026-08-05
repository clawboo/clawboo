// The app-wide React error boundary and its fallback card.
//
// Three variants, each shaped for where it sits:
//   app     — full-viewport card. Used ONCE, at the root (main.tsx). The whole UI
//             is gone, so the honest primary action is a page reload.
//   panel   — inline card for a single surface (a nav panel, the agent detail
//             view, a team space). Sibling surfaces are still alive, so the
//             primary action is "Try again"; reload is the escape hatch.
//   compact — icon-only treatment for a narrow column (the two sidebars), where
//             a card would not fit.
//
// SCOPE, stated plainly so this is not overclaimed: React error boundaries catch
// throws during RENDER, in lifecycle methods, and in descendant constructors.
// They do NOT catch event handlers, timers, EventSource/fetch callbacks, or
// promise rejections — which is most of this app's data layer. Those are covered
// (console-only) by `app/globalErrorHandlers.ts`, and by each panel's own in-band
// error state. The value here is "a crashed surface no longer blanks the app".
//
// ⚠ A boundary wrapping a <Suspense> around a React.lazy MUST be given `onRetry`.
// React.lazy memoizes a REJECTED import on the lazy object forever, so clearing
// this boundary's error state re-throws the SAME rejection. `onRetry` is where
// the owner mints a fresh lazy() — see `lib/lazyRetry.ts` + `LazyBoundary.tsx`.

import { Component, type CSSProperties, type ErrorInfo, type ReactNode } from 'react'
import { AlertTriangle, RotateCw } from 'lucide-react'

import { Button, IconButton } from './Button'

export type ErrorBoundaryVariant = 'app' | 'panel' | 'compact'

export interface ErrorBoundaryProps {
  children: ReactNode
  /** Layout + density treatment of the fallback. Defaults to `panel`. */
  variant?: ErrorBoundaryVariant
  /**
   * Human name of the surface that failed, used verbatim in `Couldn't load
   * {label}.` — e.g. "Atlas", "Tokens Used", "the team space". Nav views should
   * pass `NAV_VIEW_LABELS[view]`.
   */
  label?: string
  /**
   * While an error is showing, changing any value here (element-wise compare)
   * clears it and re-renders children. Pass the retry attempt and/or the view id
   * so navigating away from a broken surface heals it.
   */
  resetKeys?: readonly unknown[]
  /** Extra fields merged into the console.error payload (view id, agent id…). */
  logContext?: Record<string, unknown>
  /** "Try again" handler. REQUIRED when this boundary wraps a React.lazy. */
  onRetry?: () => void
  /** Escape hatch for a bespoke fallback (e.g. an overlay that must not tile). */
  fallback?: (ctx: { error: Error; retry: () => void }) => ReactNode
  /** Layout escape hatch — merged onto the fallback root (sidebar geometry). */
  fallbackClassName?: string
  fallbackStyle?: CSSProperties
}

interface ErrorBoundaryState {
  error: Error | null
}

/**
 * Anything can be thrown in JS — a string, a Response, a plain object. Normalise
 * once so the fallback renders a string. Rendering a raw object as a React child
 * would throw INSIDE the fallback, which this boundary cannot catch, escalating
 * a contained panel failure into a white screen.
 */
function toError(thrown: unknown): Error {
  if (thrown instanceof Error) return thrown
  if (typeof thrown === 'string') return new Error(thrown)
  try {
    return new Error(JSON.stringify(thrown))
  } catch {
    return new Error(String(thrown))
  }
}

function keysChanged(a: readonly unknown[] = [], b: readonly unknown[] = []): boolean {
  if (a === b) return false
  if (a.length !== b.length) return true
  return a.some((v, i) => !Object.is(v, b[i]))
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null }

  // Stays PURE — no logging, no store writes. React re-runs this when it throws
  // away a concurrent render, so a side effect here would fire more than once
  // per actual failure.
  static getDerivedStateFromError(thrown: unknown): ErrorBoundaryState {
    return { error: toError(thrown) }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Clawboo is local-first with no error reporting, so the console IS the
    // report. The React componentStack is the part the browser's own console
    // cannot give you. Prefix matches the house convention (cf. the
    // `[clawboo:triple-render]` warning in stores/chat.ts).
    console.error('[clawboo:error-boundary]', error.message, {
      label: this.props.label ?? null,
      variant: this.props.variant ?? 'panel',
      error,
      componentStack: info.componentStack ?? '(no component stack)',
      ...this.props.logContext,
    })
  }

  componentDidUpdate(prev: ErrorBoundaryProps): void {
    // Both guards are load-bearing. `resetKeys` is almost always a fresh array
    // literal, so an identity compare would be true on EVERY update; and without
    // the `state.error` check this would setState in a loop.
    if (this.state.error && keysChanged(prev.resetKeys, this.props.resetKeys)) {
      this.setState({ error: null })
    }
  }

  private reset = (): void => {
    this.setState({ error: null })
  }

  private handleRetry = (): void => {
    // One synchronous handler, so React batches the owner's attempt bump and our
    // error clear into a SINGLE render. If they split, children would re-render
    // once against the still-rejected lazy and land straight back on the card.
    this.props.onRetry?.()
    this.reset()
  }

  render(): ReactNode {
    const { error } = this.state
    // No wrapper element in the healthy path. Every view root is `h-full`, so an
    // extra div would become a `flex: 0 1 auto` item, collapse `height: 100%` to
    // `auto`, and silently zero-height the panel inside it.
    if (!error) return this.props.children
    if (this.props.fallback) return this.props.fallback({ error, retry: this.handleRetry })
    return (
      <ErrorFallbackCard
        error={error}
        label={this.props.label}
        variant={this.props.variant ?? 'panel'}
        onRetry={this.handleRetry}
        className={this.props.fallbackClassName}
        style={this.props.fallbackStyle}
      />
    )
  }
}

// ─── Fallback card ───────────────────────────────────────────────────────────

interface ErrorFallbackCardProps {
  error: Error
  label?: string
  variant: ErrorBoundaryVariant
  onRetry: () => void
  className?: string
  style?: CSSProperties
}

// The panel root sets `flex: 1 1 0%` AND `height: 100%` on purpose — it has to
// size correctly in all three parents it lands in: a column-flex `motion.div`
// (flex wins), a block `h-full` div (height wins), and a react-resizable-panels
// `Panel` (height wins). Same reasoning as the <Suspense> fallbacks it replaces.
const ROOT_STYLE: Record<ErrorBoundaryVariant, CSSProperties> = {
  app: {
    display: 'flex',
    minHeight: '100vh',
    width: '100%',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
    background: 'var(--background)',
  },
  panel: {
    display: 'flex',
    flex: '1 1 0%',
    height: '100%',
    minHeight: 0,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  // No `flex: 1` here — the sidebars are items in a ROW flex container, where
  // growing would eat the whole window. Width comes from `fallbackClassName`.
  compact: {
    display: 'flex',
    height: '100%',
    flexShrink: 0,
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    padding: 8,
  },
}

function ErrorFallbackCard({
  error,
  label,
  variant,
  onRetry,
  className,
  style,
}: ErrorFallbackCardProps) {
  const surface = label ?? 'this view'
  const title = variant === 'app' ? 'Couldn’t load Clawboo.' : `Couldn’t load ${surface}.`

  if (variant === 'compact') {
    return (
      <div
        role="alert"
        data-testid="compact-error-boundary"
        title={title}
        className={className}
        style={{ ...ROOT_STYLE.compact, ...style }}
      >
        <AlertTriangle size={18} strokeWidth={1.75} color="var(--amber)" aria-hidden />
        <span className="sr-only">{title}</span>
        <IconButton
          size="sm"
          variant="ghost"
          label={`Reload the page — ${title}`}
          data-testid="error-boundary-reload"
          onClick={() => window.location.reload()}
        >
          <RotateCw size={14} strokeWidth={2} />
        </IconButton>
      </div>
    )
  }

  const isApp = variant === 'app'
  const helper = isApp
    ? 'An unexpected error stopped the interface from rendering. Reloading usually clears it.'
    : 'This surface hit an unexpected error. The rest of the app is still running.'

  const retry = (
    <Button
      key="retry"
      variant={isApp ? 'secondary' : 'primary'}
      size="sm"
      onClick={onRetry}
      data-testid="error-boundary-retry"
    >
      <RotateCw size={14} strokeWidth={2.2} aria-hidden /> Try again
    </Button>
  )
  const reload = (
    <Button
      key="reload"
      variant={isApp ? 'primary' : 'secondary'}
      size="sm"
      onClick={() => window.location.reload()}
      data-testid="error-boundary-reload"
    >
      Reload page
    </Button>
  )

  return (
    <div
      role="alert"
      data-testid={isApp ? 'app-error-boundary' : 'panel-error-boundary'}
      className={className}
      style={{ ...ROOT_STYLE[variant], ...style }}
    >
      <div
        className="surface-raised-tier"
        style={{
          width: '100%',
          maxWidth: 420,
          borderRadius: 16,
          padding: '24px 22px 20px',
          textAlign: 'center',
        }}
      >
        <div
          aria-hidden
          style={{
            display: 'flex',
            width: 48,
            height: 48,
            margin: '0 auto',
            alignItems: 'center',
            justifyContent: 'center',
            borderRadius: 999,
            background: 'rgb(var(--amber-rgb) / 0.1)',
            border: '1px solid rgb(var(--amber-rgb) / 0.2)',
          }}
        >
          <AlertTriangle size={24} strokeWidth={1.75} color="var(--amber)" />
        </div>
        {/* <h1> matches PanelHeader, the heading every panel would have rendered
            here. No id / aria-labelledby: two boundaries can be mounted at once
            and a hardcoded id would duplicate. `role="alert"` announces the whole
            card anyway. */}
        <h1
          className="font-display font-bold text-foreground"
          style={{ marginTop: 14, fontSize: 17, letterSpacing: '-0.01em', lineHeight: 1.2 }}
        >
          {title}
        </h1>
        <p
          style={{
            marginTop: 6,
            fontSize: 12.5,
            lineHeight: 1.6,
            // `--muted-foreground`, not a low-opacity `--foreground-rgb`: the
            // token is held at ≥4.5:1 against every surface in both themes and
            // is guarded by app/__tests__/tokenContrast.test.ts. An error card
            // that a user cannot read is the one place this matters most.
            color: 'var(--muted-foreground)',
          }}
        >
          {helper}
        </p>
        <pre
          data-testid="error-boundary-message"
          style={{
            marginTop: 14,
            maxHeight: 120,
            overflow: 'auto',
            borderRadius: 8,
            padding: '8px 10px',
            textAlign: 'left',
            background: 'rgb(var(--foreground-rgb) / 0.04)',
            border: '1px solid rgb(var(--foreground-rgb) / 0.08)',
            fontFamily: 'var(--font-mono)',
            fontSize: 11,
            lineHeight: 1.5,
            color: 'var(--muted-foreground)',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          }}
        >
          {error.message || error.name}
        </pre>
        <div
          style={{
            display: 'flex',
            marginTop: 16,
            alignItems: 'center',
            justifyContent: 'center',
            gap: 8,
          }}
        >
          {/* At the root, re-rendering the same deterministic error just flashes
              the card again — so a reload leads. In a panel the error is usually
              transient (a chunk fetch, one bad row), so "Try again" leads. */}
          {isApp ? [reload, retry] : [retry, reload]}
        </div>
      </div>
    </div>
  )
}
