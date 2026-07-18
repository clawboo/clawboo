// The shared UI-driven "Sign in with ChatGPT" element. One click spawns the
// OFFICIAL CLI's login on the LOCAL server (POST /api/auth/cli-login/:tool, SSE)
// and relays its user-facing output here. Two wire shapes arrive:
//
//   - Browser-PKCE (codex, openclaw): the CLI opens the user's browser itself
//     and waits on its localhost callback — the UI shows a quiet waiting row
//     with an "Open sign-in page" fallback. No code, nothing to type.
//   - Device flow (hermes — its codex login has no browser variant): the
//     one-time code renders in a refined card. NOTE this flow is gated by a
//     ChatGPT account setting ("device code authorization"), so the card and
//     the failure state both carry the Settings → Security remediation.
//
// The authorization is always the human's, in their browser on openai.com;
// clawboo never touches tokens. Graceful degrade: NOT_INSTALLED /
// UNSUPPORTED_PLATFORM (Windows OpenClaw — no PTY without a native dep) / any
// spawn failure falls back to the manual copy-the-command affordance.
//
// Craft notes (design-system): no filled accent button — signing in is never
// the page's single primary action, so the trigger is a secondary button with
// the OpenAI mark. The manual command stays OUT of the resting states (it
// surfaces only on failure, where it is the honest path).

import { useCallback, useEffect, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import {
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  ExternalLink,
  Loader2,
  ShieldAlert,
} from 'lucide-react'

import { startCliLogin, type CliLoginTool } from '@clawboo/control-client'

import { ProviderGlyph } from '@/features/onboarding/ProviderIcon'
import { Button } from '@/features/shared/Button'
import { CommandStream, useCommandLog } from '@/features/shared/CommandStream'
import { FormattedAlert } from '@/features/shared/FormattedAlert'

const muted = (o: number) => `rgb(var(--foreground-rgb) / ${o})`

/** ChatGPT's account-level security page — where device sign-in is enabled. */
const CHATGPT_SECURITY_URL = 'https://chatgpt.com/#settings/Security'

/** The device flow's account gate, as OpenAI phrases it on the sign-in page. */
const DEVICE_GATE_RE =
  /device (code )?(authorization|sign-?in).{0,40}(disabled|not enabled)|enable device code/i

type Phase = 'idle' | 'starting' | 'waiting' | 'done' | 'failed' | 'fallback'

export interface ChatGptSignInProps {
  tool: CliLoginTool
  /** The manual terminal command — shown on failure as the honest fallback. */
  loginCommand: string
  /** Fired once the login is verified on disk (the server re-probes the store). */
  onLoggedIn: () => void
  disabled?: boolean
  /** Trigger label override (default "Sign in with ChatGPT"). */
  label?: string
}

const ENTER = {
  initial: { opacity: 0, y: 4 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: 0.2, ease: [0.32, 0.72, 0, 1] as const },
}

/**
 * The premium "connected to ChatGPT" confirmation — a raised card with the
 * OpenAI mark in a mint-washed tile + a corner check badge, a bold title, and a
 * calm detail line. Replaces the raw mint-text "✓ Signed in" lines everywhere a
 * ChatGPT sign-in settles (the sign-in done state + the wizard's ready state),
 * so a subscription connection reads as a considered confirmation, not console
 * output.
 */
export function ChatGptConnected({
  title = 'Connected to ChatGPT',
  detail,
  testId,
}: {
  title?: string
  detail?: string
  testId?: string
}) {
  return (
    <motion.div
      {...ENTER}
      className="surface-raised-tier flex items-center gap-3 rounded-xl px-3.5 py-3"
      data-testid={testId}
    >
      <div className="relative shrink-0">
        <div
          className="flex h-9 w-9 items-center justify-center rounded-lg"
          style={{ background: 'rgb(var(--mint-rgb) / 0.12)', color: 'var(--foreground)' }}
        >
          <ProviderGlyph id="openai" size={18} />
        </div>
        <span
          className="absolute -bottom-1 -right-1 flex h-4 w-4 items-center justify-center rounded-full"
          style={{
            background: 'var(--mint)',
            color: 'var(--background)',
            boxShadow: '0 0 0 2px var(--surface-raised)',
          }}
        >
          <Check size={10} strokeWidth={3} />
        </span>
      </div>
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="text-[13px] font-semibold text-foreground">{title}</span>
        {detail && (
          <span className="text-[11.5px] leading-snug" style={{ color: muted(0.5) }}>
            {detail}
          </span>
        )}
      </div>
    </motion.div>
  )
}

export function ChatGptSignIn({
  tool,
  loginCommand,
  onLoggedIn,
  disabled,
  label,
}: ChatGptSignInProps) {
  const [phase, setPhase] = useState<Phase>('idle')
  const [device, setDevice] = useState<{ url: string; code: string } | null>(null)
  const [authUrl, setAuthUrl] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [showLog, setShowLog] = useState(false)
  const [copied, setCopied] = useState<'code' | 'command' | null>(null)
  const log = useCommandLog()
  const controllerRef = useRef<AbortController | null>(null)
  const onLoggedInRef = useRef(onLoggedIn)
  onLoggedInRef.current = onLoggedIn
  // The device gate can only be diagnosed from the CLI's output lines.
  const sawDeviceGateRef = useRef(false)

  // Abort on unmount — a login left running with no UI would poll for 15 min.
  useEffect(() => () => controllerRef.current?.abort(), [])

  const start = useCallback(() => {
    controllerRef.current?.abort()
    setPhase('starting')
    setDevice(null)
    setAuthUrl(null)
    setError(null)
    setCopied(null)
    sawDeviceGateRef.current = false
    log.clear()
    controllerRef.current = startCliLogin(tool, {
      onEvent: (e) => {
        if (e.type === 'device-code' && typeof e['code'] === 'string') {
          setDevice({ url: String(e['url'] ?? ''), code: e['code'] })
          setPhase('waiting')
        } else if (e.type === 'auth-url' && typeof e['url'] === 'string') {
          setAuthUrl(e['url'])
          setPhase('waiting')
        }
      },
      onProgress: () => setPhase((p) => (p === 'starting' ? 'waiting' : p)),
      onOutput: (e) => {
        if (typeof e['line'] === 'string') {
          if (DEVICE_GATE_RE.test(e['line'])) sawDeviceGateRef.current = true
          log.append(e['line'])
        }
      },
      onComplete: (e) => {
        if (e['loggedIn'] === true) {
          setPhase('done')
          onLoggedInRef.current()
        } else {
          setPhase('failed')
          setError(typeof e['message'] === 'string' ? e['message'] : 'Sign-in did not complete.')
        }
      },
      onError: (e) => {
        const code = typeof e['code'] === 'string' ? e['code'] : ''
        if (code === 'CANCELLED') {
          setPhase('idle')
          return
        }
        // Typed degrades: no CLI / no PTY on this OS / spawn failure → the
        // manual command is the honest path.
        if (
          code === 'NOT_INSTALLED' ||
          code === 'UNSUPPORTED_PLATFORM' ||
          code.startsWith('SPAWN')
        ) {
          setPhase('fallback')
        } else {
          setPhase('failed')
        }
        setError(typeof e['message'] === 'string' ? e['message'] : 'Sign-in failed.')
      },
    })
  }, [tool, log])

  const cancel = useCallback(() => {
    controllerRef.current?.abort()
    setPhase('idle')
  }, [])

  const copy = useCallback((kind: 'code' | 'command', text: string) => {
    void navigator.clipboard?.writeText(text)
    setCopied(kind)
    setTimeout(() => setCopied(null), 1500)
  }, [])

  const openUrl = device?.url ?? authUrl
  // Hermes is the one device-flow tool; the gate remediation is device-only.
  const isDeviceFlow = device != null

  if (phase === 'done') {
    return (
      <ChatGptConnected
        testId={`chatgpt-signin-${tool}-done`}
        detail="Your ChatGPT subscription now powers this runtime."
      />
    )
  }

  const detailsToggle = (
    <button
      type="button"
      onClick={() => setShowLog((v) => !v)}
      className="inline-flex cursor-pointer items-center gap-1 text-[11px] transition-colors hover:text-foreground/70"
      style={{ color: muted(0.45), background: 'transparent', border: 'none' }}
      aria-expanded={showLog}
      data-testid={`chatgpt-signin-${tool}-log-toggle`}
    >
      {showLog ? <ChevronDown size={11} /> : <ChevronRight size={11} />} Details
    </button>
  )

  const commandRow = (
    <div
      className="flex items-center justify-between gap-2 rounded-lg px-3 py-2"
      style={{ background: 'var(--code-block-bg, rgb(var(--foreground-rgb) / 0.05))' }}
    >
      <code className="font-mono text-[12px]" style={{ color: 'var(--foreground)' }}>
        {loginCommand}
      </code>
      <button
        type="button"
        aria-label="Copy command"
        onClick={() => copy('command', loginCommand)}
        className="rounded-md px-2 py-1 font-mono text-[10px] uppercase tracking-wider text-foreground/50 transition-colors hover:bg-foreground/[0.06] hover:text-foreground/80"
        style={{ background: 'transparent', border: 'none', cursor: 'pointer' }}
        data-testid={`chatgpt-signin-${tool}-copy-command`}
      >
        {copied === 'command' ? 'Copied' : 'Copy'}
      </button>
    </div>
  )

  return (
    <div className="flex flex-col gap-2.5" data-testid={`chatgpt-signin-${tool}`}>
      {phase === 'idle' && (
        <div>
          <Button
            variant="secondary"
            size="sm"
            disabled={disabled}
            onClick={start}
            data-testid={`chatgpt-signin-${tool}-start`}
          >
            <span className="inline-flex items-center" style={{ color: 'var(--foreground)' }}>
              <ProviderGlyph id="openai" size={14} />
            </span>
            {label ?? 'Sign in with ChatGPT'}
          </Button>
        </div>
      )}

      {phase === 'starting' && (
        <p className="flex items-center gap-2 text-[12.5px]" style={{ color: muted(0.55) }}>
          <Loader2 size={13} className="animate-spin" /> Starting the sign-in…
        </p>
      )}

      {(phase === 'starting' || phase === 'waiting') && (
        <>
          {/* Device flow (hermes): the one-time code, front and center. */}
          {device && (
            <motion.div
              {...ENTER}
              className="flex flex-col items-center gap-2 rounded-xl px-5 py-4 surface-raised-tier"
              data-testid={`chatgpt-signin-${tool}-code`}
            >
              <span
                className="font-mono text-[10px] uppercase tracking-[0.2em]"
                style={{ color: muted(0.45) }}
              >
                One-time code
              </span>
              <button
                type="button"
                onClick={() => copy('code', device.code)}
                // The code IS the accessible name — an action-only label would
                // hide the one value the user must transcribe from AT.
                aria-label={`Copy code ${device.code}`}
                className="cursor-pointer rounded-lg px-3 py-1 font-mono text-[26px] font-semibold tracking-[0.24em] text-foreground tabular-nums transition-colors hover:bg-foreground/[0.05]"
                style={{ background: 'transparent', border: 'none' }}
              >
                {device.code}
                {copied === 'code' ? (
                  <Check size={14} className="ml-2 inline text-mint" />
                ) : (
                  <Copy size={14} className="ml-2 inline opacity-35" />
                )}
              </button>
              <span className="text-center text-[11px]" style={{ color: muted(0.45) }}>
                Enter it on the ChatGPT sign-in page · expires in 15 minutes
              </span>
              <span className="flex items-center gap-1.5 text-[11px]" style={{ color: muted(0.5) }}>
                <span
                  className="inline-block h-1.5 w-1.5 rounded-full"
                  style={{
                    background: 'var(--mint)',
                    animation: 'clawboo-status-pulse 1.6s ease-in-out infinite',
                  }}
                />
                Waiting for approval
              </span>
            </motion.div>
          )}

          {/* Browser flow (codex, openclaw): the CLI already opened the browser. */}
          {!device && authUrl && (
            <motion.p
              {...ENTER}
              className="flex items-center gap-2 text-[12.5px]"
              style={{ color: muted(0.55) }}
              data-testid={`chatgpt-signin-${tool}-browser-wait`}
            >
              <span
                className="inline-block h-1.5 w-1.5 shrink-0 rounded-full"
                style={{
                  background: 'var(--mint)',
                  animation: 'clawboo-status-pulse 1.6s ease-in-out infinite',
                }}
              />
              Finish signing in from the browser window that just opened.
            </motion.p>
          )}

          {phase === 'waiting' && !device && !authUrl && (
            <p className="flex items-center gap-2 text-[12.5px]" style={{ color: muted(0.55) }}>
              <Loader2 size={13} className="animate-spin" />
              Waiting for the sign-in page… (your browser may open on its own)
            </p>
          )}

          <div className="flex items-center gap-2">
            {openUrl && (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => window.open(openUrl, '_blank', 'noopener,noreferrer')}
                data-testid={`chatgpt-signin-${tool}-open`}
              >
                Open sign-in page <ExternalLink size={12} />
              </Button>
            )}
            <Button
              variant="ghost"
              size="sm"
              onClick={cancel}
              data-testid={`chatgpt-signin-${tool}-cancel`}
            >
              Cancel
            </Button>
            {detailsToggle}
          </div>

          {/* The device flow is gated by a ChatGPT account setting — say so
              BEFORE the user burns the 15-minute window wondering. */}
          {isDeviceFlow && (
            <p className="text-[11px] leading-relaxed" style={{ color: muted(0.5) }}>
              <ShieldAlert size={11} className="mr-1 inline align-[-1px] opacity-60" />
              If the sign-in page says device authorization is disabled, turn it on under{' '}
              <a
                href={CHATGPT_SECURITY_URL}
                target="_blank"
                rel="noreferrer noopener"
                className="font-medium underline underline-offset-2 hover:text-foreground/80"
              >
                ChatGPT Settings → Security
              </a>
              , then retry.
            </p>
          )}

          {showLog && (
            <CommandStream
              log={log}
              placeholder="Waiting for the sign-in tool…"
              maxHeight={120}
              testId={`chatgpt-signin-${tool}-log`}
            />
          )}
        </>
      )}

      {(phase === 'failed' || phase === 'fallback') && (
        <>
          {error && (
            <FormattedAlert tone={phase === 'fallback' ? 'info' : 'error'}>{error}</FormattedAlert>
          )}
          {phase === 'failed' && (isDeviceFlow || sawDeviceGateRef.current) && (
            <p className="text-[11px] leading-relaxed" style={{ color: muted(0.5) }}>
              This sign-in uses ChatGPT&rsquo;s device flow, which is off by default on some
              accounts. Enable device code authorization under{' '}
              <a
                href={CHATGPT_SECURITY_URL}
                target="_blank"
                rel="noreferrer noopener"
                className="underline underline-offset-2 hover:text-foreground/70"
              >
                ChatGPT Settings → Security
              </a>
              , then retry.
            </p>
          )}
          {/* The manual path always works — surface it alongside Retry. */}
          {commandRow}
          {phase === 'failed' && (
            <div>
              <Button variant="secondary" size="sm" onClick={start}>
                Retry
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  )
}
