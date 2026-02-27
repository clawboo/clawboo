'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { Eye, EyeOff, Loader2 } from 'lucide-react'
import Image from 'next/image'
import {
  GatewayClient,
  formatGatewayError,
  isLocalGatewayUrl,
  resolveProxyGatewayUrl,
} from '@clawboo/gateway-client'
import { useConnectionStore } from '@/stores/connection'

// ─── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_URL = 'ws://localhost:18789'

// ─── Types ────────────────────────────────────────────────────────────────────

export type GatewayConnectScreenProps = {
  /** Called with the live client once the connection is established. */
  onConnected: (client: GatewayClient) => void
  /** Pre-fill values loaded from persisted settings (optional). */
  initialUrl?: string
  initialHasToken?: boolean
}

// ─── Component ────────────────────────────────────────────────────────────────

export function GatewayConnectScreen({
  onConnected,
  initialUrl,
  initialHasToken = false,
}: GatewayConnectScreenProps) {
  const setStatus = useConnectionStore((s) => s.setStatus)
  const setGatewayUrl = useConnectionStore((s) => s.setGatewayUrl)

  // Form state
  const [url, setUrl] = useState(initialUrl?.trim() || DEFAULT_URL)
  const [token, setToken] = useState('')
  const [showToken, setShowToken] = useState(false)
  const [connecting, setConnecting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Stable GatewayClient instance — created once, reused across retries
  const clientRef = useRef<GatewayClient | null>(null)
  const getClient = (): GatewayClient => {
    if (!clientRef.current) clientRef.current = new GatewayClient()
    return clientRef.current
  }

  // Pre-fill from persisted settings on mount
  useEffect(() => {
    fetch('/api/settings')
      .then((r) => r.json())
      .then((data: { gatewayUrl?: string; gatewayToken?: string; hasToken?: boolean }) => {
        if (data.gatewayUrl?.trim()) setUrl(data.gatewayUrl.trim())
        if (data.gatewayToken?.trim()) setToken(data.gatewayToken.trim())
        else if (data.hasToken) setToken('••••••••')
      })
      .catch(() => {
        /* silently ignore — user can type manually */
      })
  }, [])

  const handleConnect = useCallback(async () => {
    const trimmedUrl = url.trim()
    if (!trimmedUrl || connecting) return

    // If the token field is still the placeholder dots, treat as "keep existing"
    const trimmedToken = token === '••••••••' ? '' : token.trim()

    setConnecting(true)
    setError(null)
    setStatus('connecting')

    // Dispose previous client if it errored (can't reuse a closed WS)
    if (clientRef.current) {
      try {
        clientRef.current.disconnect()
      } catch {
        /* ignore */
      }
      clientRef.current = null
    }

    const client = getClient()

    try {
      // Persist to disk BEFORE connecting so the proxy can read the settings
      // when it receives the first WebSocket message.
      // If the token field still shows the placeholder (user never touched it),
      // only save the URL — leave the existing saved token intact so the proxy
      // can inject it. If the user explicitly cleared or typed a new token, save that.
      const tokenChanged = token !== '••••••••'
      await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          gatewayUrl: trimmedUrl,
          ...(tokenChanged ? { gatewayToken: trimmedToken } : {}),
        }),
      })

      // Connect via the same-origin proxy (/api/gateway/ws) rather than
      // directly to the Gateway URL — upholds Architecture Invariant #2.
      // The browser includes the token so device auth can sign it correctly.
      // The proxy passes the frame through when auth.token is present.
      await client.connect(resolveProxyGatewayUrl(), {
        clientName: 'openclaw-control-ui',
        clientVersion: '0.0.0',
        token: trimmedToken || undefined,
        authScopeKey: trimmedUrl,
      })

      setStatus('connected')
      setGatewayUrl(trimmedUrl)
      onConnected(client)
    } catch (err) {
      const message = formatGatewayError(err)
      setError(message)
      setStatus('error')
      setConnecting(false)
      // Nullify so next attempt creates a fresh client
      clientRef.current = null
    }
  }, [url, token, connecting, setStatus, setGatewayUrl, onConnected])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey && !connecting) {
        e.preventDefault()
        void handleConnect()
      }
    },
    [connecting, handleConnect],
  )

  const isLocal = isLocalGatewayUrl(url)
  const connectDisabled = connecting || !url.trim()

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.15 }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-background/95 backdrop-blur-sm"
      data-testid="gateway-connect-screen"
    >
      <motion.div
        initial={{ opacity: 0, y: 20, scale: 0.96 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 8, scale: 0.97 }}
        transition={{ type: 'spring', stiffness: 320, damping: 30 }}
        className="w-full max-w-[360px] rounded-2xl border border-white/8 bg-surface p-8 shadow-[0_24px_80px_rgba(0,0,0,0.6)]"
      >
        {/* ── Logo / header ── */}
        <div className="mb-8 flex flex-col items-center gap-3 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-accent/12 ring-1 ring-accent/20">
            <Image src="/logo.svg" alt="Clawboo" width={32} height={30} />
          </div>
          <div>
            <h1
              className="text-[22px] font-bold tracking-tight text-text"
              style={{ fontFamily: 'var(--font-display)' }}
            >
              Clawboo
            </h1>
            <p className="mt-0.5 text-[12px] text-secondary">Connect to an OpenClaw Gateway</p>
          </div>
        </div>

        {/* ── Form ── */}
        <div className="flex flex-col gap-4" onKeyDown={handleKeyDown} role="group">
          {/* Gateway URL */}
          <div className="flex flex-col gap-1.5">
            <label
              htmlFor="gateway-url"
              className="font-mono text-[10px] font-semibold uppercase tracking-widest text-secondary"
            >
              Gateway URL
            </label>
            <input
              id="gateway-url"
              type="text"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="ws://localhost:18789"
              spellCheck={false}
              autoComplete="off"
              disabled={connecting}
              data-testid="gateway-url-input"
              className="h-10 rounded-lg border border-white/10 bg-background px-3 font-mono text-[13px] text-text outline-none transition placeholder:text-secondary/30 focus:border-white/20 focus:ring-1 focus:ring-ring/30 disabled:opacity-50"
            />
            {isLocal && (
              <p className="font-mono text-[10px] text-mint/60">Local gateway detected</p>
            )}
          </div>

          {/* Gateway token */}
          <div className="flex flex-col gap-1.5">
            <label
              htmlFor="gateway-token"
              className="font-mono text-[10px] font-semibold uppercase tracking-widest text-secondary"
            >
              Token{' '}
              <span className="normal-case font-normal text-secondary/50">
                {initialHasToken ? '(saved)' : '(optional)'}
              </span>
            </label>
            <div className="relative">
              <input
                id="gateway-token"
                type={showToken ? 'text' : 'password'}
                value={token}
                onChange={(e) => setToken(e.target.value)}
                onFocus={() => {
                  // Clear placeholder dots so user can type real value
                  if (token === '••••••••') setToken('')
                }}
                placeholder="gateway-token"
                spellCheck={false}
                autoComplete="current-password"
                disabled={connecting}
                data-testid="gateway-token-input"
                className="h-10 w-full rounded-lg border border-white/10 bg-background px-3 pr-10 font-mono text-[13px] text-text outline-none transition placeholder:text-secondary/30 focus:border-white/20 focus:ring-1 focus:ring-ring/30 disabled:opacity-50"
              />
              <button
                type="button"
                tabIndex={-1}
                onClick={() => setShowToken((v) => !v)}
                aria-label={showToken ? 'Hide token' : 'Show token'}
                className="absolute inset-y-0 right-2 flex items-center text-secondary/40 transition hover:text-secondary"
              >
                {showToken ? (
                  <EyeOff className="h-4 w-4" strokeWidth={1.75} />
                ) : (
                  <Eye className="h-4 w-4" strokeWidth={1.75} />
                )}
              </button>
            </div>
            <p className="font-mono text-[10px] text-secondary/40">
              Leave empty for unauthenticated local gateways.
            </p>
          </div>

          {/* Error message */}
          <AnimatePresence initial={false}>
            {error && (
              <motion.div
                key="error"
                initial={{ opacity: 0, height: 0, marginTop: 0 }}
                animate={{ opacity: 1, height: 'auto', marginTop: 0 }}
                exit={{ opacity: 0, height: 0, marginTop: 0 }}
                transition={{ duration: 0.15 }}
                className="overflow-hidden"
              >
                <div
                  role="alert"
                  data-testid="gateway-connect-error"
                  className="rounded-lg border border-destructive/20 bg-destructive/8 px-3 py-2 text-[12px] leading-snug text-destructive"
                >
                  {error}
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Connect button */}
          <button
            type="button"
            onClick={() => void handleConnect()}
            disabled={connectDisabled}
            data-testid="gateway-connect-button"
            className="mt-1 flex h-11 w-full items-center justify-center gap-2 rounded-lg bg-accent font-mono text-[13px] font-semibold tracking-wide text-white shadow-sm transition hover:brightness-110 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {connecting ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" strokeWidth={2.5} />
                Connecting…
              </>
            ) : (
              'Connect'
            )}
          </button>
        </div>

        {/* ── Footer hint ── */}
        <p className="mt-6 text-center font-mono text-[10px] text-secondary/30">
          Default:{' '}
          <button
            type="button"
            className="text-secondary/50 underline underline-offset-2 hover:text-secondary transition"
            onClick={() => setUrl(DEFAULT_URL)}
            tabIndex={-1}
          >
            ws://localhost:18789
          </button>
        </p>
      </motion.div>
    </motion.div>
  )
}
