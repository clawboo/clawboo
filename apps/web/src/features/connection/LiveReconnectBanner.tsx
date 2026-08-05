// A slim, NON-BLOCKING banner for a live Gateway socket that dropped mid-session
// and is retrying on its own backoff (the client's `'reconnecting'` status,
// mirrored into the store by `useGatewayEvents`).
//
// Distinct from two neighbours it is easy to confuse with:
//   * `GatewayReconnectBanner` — the DEGRADED-gateway banner, shown when a
//     Gateway failure pushed a native-capable user into native mode. That one is
//     action-driven ("press Reconnect"); this one is informational, because the
//     client is already retrying. They share the same fixed coordinates, so they
//     are made mutually exclusive by their gates: the degraded banner renders
//     only on status 'connected', this one only on 'reconnecting'.
//   * `GatewayBootstrap`'s full-screen "Reconnecting…" spinner — the MOUNT-TIME
//     auto-connect overlay for a returning user. That one blocks; this one never
//     covers the workspace.
//
// The one action is an ESCAPE, not a retry: the client retries forever (800ms x
// 1.7, capped 15s), so a Gateway that never comes back would otherwise pin the
// app on 'reconnecting' with no way to re-enter a token or re-pair. "Connect
// manually" stops the loop and drops the user on the connect screen.

import { motion, useReducedMotion } from 'framer-motion'
import { Loader2 } from 'lucide-react'

interface Props {
  /** Stop the client's retry loop and fall back to the manual connect screen. */
  onConnectManually: () => void
}

export function LiveReconnectBanner({ onConnectManually }: Props) {
  const reduce = useReducedMotion()

  return (
    <motion.div
      role="status"
      aria-live="polite"
      data-testid="gateway-live-reconnect-banner"
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
      {/* Leading disc — a spinner, because a retry is genuinely in flight. */}
      <span
        style={{
          flexShrink: 0,
          width: 34,
          height: 34,
          borderRadius: 10,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'color-mix(in srgb, var(--amber) 15%, transparent)',
          color: 'var(--amber)',
        }}
      >
        <Loader2 className="h-[18px] w-[18px] animate-spin" strokeWidth={2.25} />
      </span>

      {/* Copy */}
      <div style={{ minWidth: 0, marginRight: 2 }}>
        {/* No `whiteSpace: nowrap` here. The copy column is a `minWidth: 0` flex
            item, so it shrinks below its content width — and a no-wrap title then
            CLIPS instead of wrapping. Measured at a 460px viewport: the title
            wants 169px and gets 118px, losing the last word. Wrapping grows the
            banner vertically, which the layout already handles. */}
        <div
          style={{
            fontSize: 13,
            fontWeight: 600,
            color: 'var(--foreground)',
            letterSpacing: '-0.01em',
            lineHeight: 1.25,
          }}
        >
          Reconnecting to Gateway…
        </div>
        <div
          style={{
            // `--muted-foreground`, not a foreground alpha: the 0.55 this used to
            // carry composites to 3.94:1 on a light surface, under the 4.5:1 AA
            // floor for body text. The token is contrast-checked in both themes
            // by `app/__tests__/tokenContrast.test.ts`.
            fontSize: 11.5,
            color: 'var(--muted-foreground)',
            marginTop: 1,
            lineHeight: 1.35,
          }}
        >
          The live connection dropped. Retrying automatically.
        </div>
      </div>

      {/* Escape hatch — secondary, so it never reads as "you must act". */}
      <button
        type="button"
        onClick={onConnectManually}
        data-testid="gateway-live-reconnect-manual"
        className="shrink-0 rounded-lg px-2.5 py-1.5 text-[12px] font-medium text-foreground/60 transition-colors hover:bg-foreground/[0.06] hover:text-foreground/85"
      >
        Connect manually
      </button>
    </motion.div>
  )
}
