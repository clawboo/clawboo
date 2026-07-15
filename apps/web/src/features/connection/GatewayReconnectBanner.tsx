// A premium, NON-BLOCKING status banner for a degraded OpenClaw Gateway.
//
// When a user has agents that run WITHOUT the Gateway (native / codex / hermes),
// a Gateway failure no longer full-screen-blocks them: the dashboard loads and
// this banner floats at the top, offering a one-tap reconnect while everything
// else keeps working. Purely presentational — all connect logic lives in
// `GatewayBootstrap`; this renders the reason, the reconnect affordance, and the
// loading / success / error states.

import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { Check, Loader2, PlugZap, RotateCcw, X } from 'lucide-react'

export type ReconnectPhase = 'idle' | 'reconnecting' | 'success' | 'error'
export type GatewayDegradeReason = 'offline' | 'unreachable'

const REASON_TITLE: Record<GatewayDegradeReason, string> = {
  offline: 'OpenClaw Gateway is offline',
  unreachable: 'OpenClaw Gateway is unreachable',
}

interface Props {
  reason: GatewayDegradeReason
  phase: ReconnectPhase
  /** Human error detail, shown as the subtitle in the `error` phase. */
  error: string | null
  /**
   * True when the failure was the Gateway REJECTING our token (`auth`). Retrying
   * re-sends the same token and can never succeed — the Gateway only reloads its
   * token at boot — so the primary action becomes "Restart Gateway" instead of a
   * futile Retry. Kept as ONE primary action (not a third button) so the compact
   * banner never crowds.
   */
  canRestartGateway?: boolean
  onReconnect: () => void
  onRestartGateway?: () => void
  onOpenSettings: () => void
  onDismiss: () => void
}

export function GatewayReconnectBanner({
  reason,
  phase,
  error,
  canRestartGateway = false,
  onReconnect,
  onRestartGateway,
  onOpenSettings,
  onDismiss,
}: Props) {
  const reduce = useReducedMotion()
  const isBusy = phase === 'reconnecting'
  const isSuccess = phase === 'success'
  const isError = phase === 'error'
  // Driven purely by the host's classification (kept set while ITS restart is in
  // flight, so the busy label reads "Restarting" — the action the user pressed).
  const showRestart = canRestartGateway && Boolean(onRestartGateway)

  // Amber (warning) at rest, mint on success — both theme-aware tokens.
  const accent = isSuccess ? 'var(--mint)' : 'var(--amber)'

  const title = isSuccess
    ? 'Gateway reconnected'
    : isError
      ? 'Could not reconnect'
      : REASON_TITLE[reason]

  const subtitle = isSuccess
    ? 'Your OpenClaw agents are back online.'
    : isError
      ? (error ?? 'Try again, or set it up in Settings.')
      : 'Your OpenClaw agents are paused. Everything else keeps working.'

  return (
    <motion.div
      role="status"
      aria-live="polite"
      data-testid="gateway-reconnect-banner"
      initial={reduce ? { opacity: 0 } : { opacity: 0, y: -18 }}
      animate={reduce ? { opacity: 1 } : { opacity: 1, y: 0 }}
      exit={reduce ? { opacity: 0 } : { opacity: 0, y: -18, transition: { duration: 0.18 } }}
      transition={{ type: 'spring', stiffness: 420, damping: 34 }}
      className="surface-floating-tier"
      style={{
        position: 'fixed',
        top: 14,
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 60,
        borderRadius: 16,
        padding: '9px 10px 9px 12px',
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        maxWidth: 'min(460px, calc(100vw - 24px))',
        boxShadow: 'var(--shadow-floating)',
      }}
    >
      {/* Leading status disc — amber icon at rest (with a soft pulse ring to draw
          the eye without nagging), a spinner while reconnecting, a mint check on
          success. */}
      <span
        style={{
          position: 'relative',
          flexShrink: 0,
          width: 34,
          height: 34,
          borderRadius: 10,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: `color-mix(in srgb, ${accent} 15%, transparent)`,
          color: accent,
        }}
      >
        {!isBusy && !isSuccess && !reduce && (
          <motion.span
            aria-hidden
            style={{
              position: 'absolute',
              inset: 0,
              borderRadius: 10,
              border: `1.5px solid ${accent}`,
            }}
            animate={{ opacity: [0.5, 0, 0.5], scale: [1, 1.18, 1] }}
            transition={{ duration: 2.4, repeat: Infinity, ease: 'easeInOut' }}
          />
        )}
        {isBusy ? (
          <Loader2 className="h-[18px] w-[18px] animate-spin" strokeWidth={2.25} />
        ) : isSuccess ? (
          <Check className="h-[18px] w-[18px]" strokeWidth={2.5} />
        ) : (
          <PlugZap className="h-[18px] w-[18px]" strokeWidth={2} />
        )}
      </span>

      {/* Copy */}
      <div style={{ minWidth: 0, marginRight: 2 }}>
        <div
          style={{
            fontSize: 13,
            fontWeight: 600,
            color: 'var(--foreground)',
            letterSpacing: '-0.01em',
            lineHeight: 1.25,
            whiteSpace: 'nowrap',
          }}
        >
          {title}
        </div>
        <div
          style={{
            fontSize: 11.5,
            color: 'rgb(var(--foreground-rgb) / 0.55)',
            marginTop: 1,
            lineHeight: 1.35,
          }}
        >
          {subtitle}
        </div>
      </div>

      {/* Actions — hidden on success (the banner auto-dismisses). */}
      <AnimatePresence initial={false} mode="popLayout">
        {!isSuccess && (
          <motion.div
            key="actions"
            initial={reduce ? undefined : { opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={reduce ? undefined : { opacity: 0 }}
            style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}
          >
            {isError && (
              <button
                type="button"
                onClick={onOpenSettings}
                className="rounded-lg px-2.5 py-1.5 text-[12px] font-medium text-foreground/60 transition-colors hover:bg-foreground/[0.06] hover:text-foreground/85"
              >
                Settings
              </button>
            )}
            {/* ONE primary action, whose meaning follows the failure: a token
                rejection can only be cleared by restarting the Gateway (it
                reloads its token at boot), so Retry is replaced rather than
                sitting there as a button that cannot work. */}
            <button
              type="button"
              onClick={showRestart ? onRestartGateway : onReconnect}
              disabled={isBusy}
              data-testid={showRestart ? 'gateway-restart-action' : 'gateway-reconnect-action'}
              className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[12px] font-semibold shadow-sm transition hover:brightness-[1.06] active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-60"
              // Fixed near-black text: amber is a warm mid/bright tone in BOTH
              // themes, so a dark label clears WCAG AA on it (~4.8:1 light,
              // ~10:1 dark) — unlike `var(--background)`, which is near-white in
              // light mode and failed at ~3:1.
              style={{ background: 'var(--amber)', color: '#1c1917' }}
            >
              {isBusy ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={2.5} />
                  {showRestart ? 'Restarting' : 'Reconnecting'}
                </>
              ) : showRestart ? (
                <>
                  <PlugZap className="h-3.5 w-3.5" strokeWidth={2.5} />
                  Restart Gateway
                </>
              ) : isError ? (
                <>
                  <RotateCcw className="h-3.5 w-3.5" strokeWidth={2.5} />
                  Retry
                </>
              ) : (
                'Reconnect'
              )}
            </button>
            <button
              type="button"
              onClick={onDismiss}
              aria-label="Dismiss"
              className="rounded-lg p-1.5 text-foreground/35 transition-colors hover:bg-foreground/[0.06] hover:text-foreground/70"
            >
              <X className="h-3.5 w-3.5" strokeWidth={2} />
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  )
}
