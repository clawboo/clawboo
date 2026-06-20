// The shared runtime connection card — used by BOTH the onboarding ConnectAgents
// step and the Runtimes panel. One component, one state machine:
//
//   not-installed (Install, SSE) → installing
//     → needs-auth (paste key) | needs-login (codex login + Re-check)
//     → connecting → ready (Re-check + Disconnect[panel])   (+ error / unknown)
//
// Reuses the onboarding InstallStep SSE-terminal pattern (no abort on unmount;
// Retry aborts the prior controller) + the ConfigureStep key-input affordance +
// the shared StatusPill / FormattedAlert / Spinner primitives.

import { useRef, useState } from 'react'
import {
  ArrowRight,
  Check,
  Copy,
  Download,
  Eye,
  EyeOff,
  Info,
  Plug2,
  RotateCcw,
  Sparkles,
  Terminal,
} from 'lucide-react'

import { FormattedAlert } from '@/features/shared/FormattedAlert'
import { Spinner } from '@/features/shared/Spinner'
import { StatusPill, type StatusTone } from '@/features/shared/StatusPill'
import {
  connectRuntime,
  disconnectRuntime,
  installRuntime,
  type ConnectionState,
  type RuntimeStatus,
} from '@/lib/runtimesClient'

import { RuntimeIcon } from './RuntimeBrand'
import type { RuntimeCatalogEntry } from './runtimeCatalog'

const muted = (o: number) => `rgb(var(--foreground-rgb) / ${o})`

type DisplayState = ConnectionState | 'installing' | 'connecting'

const PILL: Record<DisplayState, { tone: StatusTone; label: string }> = {
  'not-installed': { tone: 'idle', label: 'Not installed' },
  installing: { tone: 'working', label: 'Installing…' },
  'needs-auth': { tone: 'warning', label: 'Needs key' },
  'needs-login': { tone: 'warning', label: 'Needs login' },
  connecting: { tone: 'working', label: 'Connecting…' },
  ready: { tone: 'success', label: 'Connected' },
  unknown: { tone: 'idle', label: 'Unknown' },
}

const CAP_KEYS = ['streaming', 'mcp', 'worktrees', 'resume'] as const

export interface RuntimeConnectionCardProps {
  entry: RuntimeCatalogEntry
  /** Live server status; undefined while the first fetch is in flight. */
  status?: RuntimeStatus
  /**
   * - `onboarding` / `panel` — the full connect state machine (install / paste
   *   key / disconnect).
   * - `wizard-primary` / `wizard-secondary` — a SELECTION surface for the
   *   "How do you want your agents to run?" step: the whole card is a button
   *   that fires `onPick`; the connect machinery + live status are suppressed
   *   (the actual connect happens on the next step). `wizard-primary` is the
   *   elevated, Recommended treatment; `wizard-secondary` is the muted row.
   */
  variant: 'onboarding' | 'panel' | 'wizard-primary' | 'wizard-secondary'
  /** Fired after any state-changing action so the host can refetch status. */
  onChanged?: () => void
  /** Fired when a wizard-pick card is chosen (wizard-* variants only). */
  onPick?: () => void
  /** Opens the diagnostics drawer for this runtime (panel variant only). */
  onDiagnostics?: () => void
}

export function RuntimeConnectionCard({
  entry,
  status,
  variant,
  onChanged,
  onPick,
  onDiagnostics,
}: RuntimeConnectionCardProps) {
  const [installing, setInstalling] = useState(false)
  const [installLog, setInstallLog] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [keyInput, setKeyInput] = useState('')
  const [showKey, setShowKey] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const controllerRef = useRef<AbortController | null>(null)
  const logEndRef = useRef<HTMLDivElement | null>(null)

  // Wizard-pick variants: a selection surface, not the connect machine. Picking
  // sets the chosen runtime and advances the wizard to the right next step.
  if (variant === 'wizard-primary' || variant === 'wizard-secondary') {
    return (
      <RuntimeChoiceCard entry={entry} primary={variant === 'wizard-primary'} onPick={onPick} />
    )
  }

  const display: DisplayState = installing
    ? 'installing'
    : busy
      ? 'connecting'
      : (status?.connectionState ?? 'unknown')
  const pill = PILL[display]
  const caps = status?.capabilities ?? entry.capabilityHint

  function appendLog(line?: string): void {
    if (!line) return
    setInstallLog((prev) => [...prev, line].slice(-200))
    // `scrollIntoView?.()` (optional call) — jsdom doesn't implement it, so the
    // bare call would throw in a RAF callback after the test unmounts.
    requestAnimationFrame(() => logEndRef.current?.scrollIntoView?.({ block: 'end' }))
  }

  function handleInstall(): void {
    setError(null)
    setInstallLog([])
    setInstalling(true)
    controllerRef.current?.abort() // Retry aborts the prior stream
    controllerRef.current = installRuntime(entry.id, {
      onProgress: (e) => appendLog(typeof e.message === 'string' ? e.message : undefined),
      onOutput: (e) => appendLog(typeof e.line === 'string' ? e.line : undefined),
      onError: (e) => {
        setError(typeof e.message === 'string' ? e.message : 'Install failed')
        setInstalling(false)
      },
      onComplete: (e) => {
        if (typeof e.warning === 'string') appendLog(e.warning)
        setInstalling(false)
        onChanged?.()
      },
    })
  }

  async function handleConnect(): Promise<void> {
    if (!keyInput.trim()) return
    setBusy(true)
    setError(null)
    const r = await connectRuntime(entry.id, keyInput.trim())
    setBusy(false)
    if (!r.ok) {
      setError(r.error ?? 'Failed to save the key')
      return
    }
    setKeyInput('')
    onChanged?.()
  }

  async function handleRecheck(): Promise<void> {
    setBusy(true)
    setError(null)
    onChanged?.()
    // The host refetch is async; clear busy on the next tick.
    setTimeout(() => setBusy(false), 400)
  }

  async function handleDisconnect(): Promise<void> {
    if (
      !window.confirm(
        `Disconnect ${entry.name}? This removes its saved API key from the encrypted vault — you'll need to re-enter it to reconnect.`,
      )
    ) {
      return
    }
    setBusy(true)
    setError(null)
    const r = await disconnectRuntime(entry.id)
    setBusy(false)
    if (!r.ok) {
      setError(r.error ?? 'Failed to disconnect')
      return
    }
    onChanged?.()
  }

  function handleCopyLogin(): void {
    const cmd = entry.loginCommand ?? status?.installCommand
    if (!cmd) return
    void navigator.clipboard?.writeText(cmd)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div
      data-testid={`runtime-card-${entry.id}`}
      className="surface-raised-tier flex flex-col gap-3 rounded-xl p-4 transition-transform"
    >
      {/* Header */}
      <div className="flex items-start gap-3">
        <RuntimeIcon id={entry.id} size={36} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-[14px] font-semibold" style={{ color: 'var(--foreground)' }}>
              {entry.name}
            </span>
            <StatusPill tone={pill.tone} label={pill.label} />
          </div>
          <p className="mt-0.5 text-[11px] leading-relaxed" style={{ color: muted(0.55) }}>
            {entry.blurb}
          </p>
        </div>
        {variant === 'panel' && onDiagnostics && (
          <button
            type="button"
            data-testid={`runtime-${entry.id}-diagnostics`}
            aria-label={`${entry.name} diagnostics`}
            onClick={onDiagnostics}
            className="shrink-0 rounded-md p-1 transition-colors hover:bg-foreground/[0.06]"
            style={{
              color: muted(0.45),
              border: 'none',
              background: 'transparent',
              cursor: 'pointer',
            }}
          >
            <Info size={15} />
          </button>
        )}
      </div>

      {/* Capability chips */}
      <div className="flex flex-wrap gap-1.5">
        {CAP_KEYS.map((k) => {
          const on = Boolean(caps[k])
          return (
            <span
              key={k}
              className="font-mono text-[9.5px] font-semibold"
              style={{
                padding: '1px 6px',
                borderRadius: 5,
                color: on ? 'var(--mint)' : muted(0.3),
                background: on
                  ? 'rgb(var(--mint-rgb) / 0.12)'
                  : 'rgb(var(--foreground-rgb) / 0.03)',
                textDecoration: on ? 'none' : 'line-through',
              }}
            >
              {k}
            </span>
          )
        })}
      </div>

      {/* Install terminal log */}
      {installing || installLog.length > 0 ? (
        <div
          className="overflow-y-auto rounded-lg p-2.5"
          style={{ maxHeight: 160, background: 'var(--terminal-bg, #0d1117)' }}
        >
          {installLog.length === 0 && (
            <div
              className="flex items-center gap-1.5 font-mono text-[11px]"
              style={{ color: 'rgb(201 209 217 / 0.7)' }}
            >
              <Terminal size={11} /> Starting install…
            </div>
          )}
          {installLog.map((line, i) => (
            <div
              key={i}
              className="font-mono text-[11px] leading-relaxed"
              style={{ color: 'rgb(201 209 217 / 0.7)' }}
            >
              {line}
            </div>
          ))}
          <div ref={logEndRef} />
        </div>
      ) : null}

      {/* Error */}
      {error && <FormattedAlert tone="error">{error}</FormattedAlert>}

      {/* Key input (api-key runtimes that need a key) */}
      {display === 'needs-auth' && entry.authKind === 'api-key' && (
        <div className="flex flex-col gap-1.5">
          <label
            className="font-mono text-[10px] uppercase tracking-widest"
            style={{ color: muted(0.5) }}
          >
            {entry.envVar}
          </label>
          <div className="relative">
            <input
              data-testid={`runtime-${entry.id}-key`}
              type={showKey ? 'text' : 'password'}
              value={keyInput}
              onChange={(e) => setKeyInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void handleConnect()
              }}
              placeholder={entry.keyPlaceholder}
              aria-label={`${entry.name} API key`}
              className="w-full rounded-lg px-3 py-2 pr-10 text-[12px] outline-none"
              style={{
                background: 'rgb(var(--foreground-rgb) / 0.04)',
                border: `1px solid ${muted(0.12)}`,
                color: 'var(--foreground)',
              }}
            />
            <button
              type="button"
              tabIndex={-1}
              aria-label={showKey ? 'Hide key' : 'Show key'}
              onClick={() => setShowKey((s) => !s)}
              className="absolute right-2 top-1/2 -translate-y-1/2"
              style={{
                color: muted(0.45),
                background: 'transparent',
                border: 'none',
                cursor: 'pointer',
              }}
            >
              {showKey ? <EyeOff size={15} /> : <Eye size={15} />}
            </button>
          </div>
        </div>
      )}

      {/* Login command (oauth runtimes — codex) */}
      {display === 'needs-login' && (
        <div className="flex flex-col gap-1.5">
          <FormattedAlert tone="info">
            {entry.name} uses your terminal login — run the command below, then re-check.
          </FormattedAlert>
          <div
            className="flex items-center justify-between gap-2 rounded-lg px-3 py-2"
            style={{ background: 'var(--code-block-bg, rgb(var(--foreground-rgb) / 0.05))' }}
          >
            <code className="font-mono text-[12px]" style={{ color: 'var(--foreground)' }}>
              {entry.loginCommand ?? status?.installCommand}
            </code>
            <button
              type="button"
              data-testid={`runtime-${entry.id}-login-copy`}
              aria-label="Copy command"
              onClick={handleCopyLogin}
              className="flex items-center gap-1 text-[10px]"
              style={{
                color: muted(0.5),
                background: 'transparent',
                border: 'none',
                cursor: 'pointer',
              }}
            >
              {copied ? <Check size={13} style={{ color: 'var(--mint)' }} /> : <Copy size={13} />}
            </button>
          </div>
        </div>
      )}

      {/* Action row */}
      <div className="mt-auto flex items-center gap-2">
        {display === 'not-installed' && (
          <>
            <ActionButton
              testid={`runtime-${entry.id}-install`}
              primary
              onClick={handleInstall}
              icon={<Download size={13} />}
            >
              Install
            </ActionButton>
            <span className="font-mono text-[10px]" style={{ color: muted(0.4) }}>
              {entry.installCommand}
            </span>
          </>
        )}

        {display === 'installing' && (
          <span className="flex items-center gap-2 text-[11px]" style={{ color: muted(0.55) }}>
            <Spinner size={13} /> Installing {entry.name}…
          </span>
        )}

        {display === 'needs-auth' && (
          <ActionButton
            testid={`runtime-${entry.id}-connect`}
            primary
            busy={busy}
            disabled={!keyInput.trim()}
            onClick={handleConnect}
            icon={<Plug2 size={13} />}
          >
            Connect
          </ActionButton>
        )}

        {display === 'needs-login' && (
          <ActionButton
            testid={`runtime-${entry.id}-recheck`}
            busy={busy}
            onClick={handleRecheck}
            icon={<RotateCcw size={13} />}
          >
            Re-check
          </ActionButton>
        )}

        {display === 'connecting' && (
          <span className="flex items-center gap-2 text-[11px]" style={{ color: muted(0.55) }}>
            <Spinner size={13} /> Working…
          </span>
        )}

        {display === 'ready' && (
          <>
            <ActionButton
              testid={`runtime-${entry.id}-recheck`}
              busy={busy}
              onClick={handleRecheck}
              icon={<RotateCcw size={13} />}
            >
              Re-check
            </ActionButton>
            {variant === 'panel' && (
              <button
                type="button"
                data-testid={`runtime-${entry.id}-disconnect`}
                onClick={() => void handleDisconnect()}
                className="text-[11px]"
                style={{
                  color: 'var(--primary)',
                  background: 'transparent',
                  border: 'none',
                  cursor: 'pointer',
                }}
              >
                Disconnect
              </button>
            )}
          </>
        )}

        {display === 'unknown' && (
          <ActionButton
            testid={`runtime-${entry.id}-recheck`}
            busy={busy}
            onClick={handleRecheck}
            icon={<RotateCcw size={13} />}
          >
            Re-check
          </ActionButton>
        )}

        {error && (display === 'not-installed' || display === 'needs-auth') && (
          <button
            type="button"
            onClick={display === 'needs-auth' ? () => void handleConnect() : handleInstall}
            className="text-[11px]"
            style={{
              color: muted(0.5),
              background: 'transparent',
              border: 'none',
              cursor: 'pointer',
            }}
          >
            Retry
          </button>
        )}
      </div>
    </div>
  )
}

/** The wizard "How do you want your agents to run?" pick card. A whole-surface
 *  button — keyboard-focusable, fires `onPick`. `primary` = the elevated,
 *  Recommended Native treatment; otherwise a muted secondary row. No connect
 *  state, no live status — selection only. */
function RuntimeChoiceCard({
  entry,
  primary,
  onPick,
}: {
  entry: RuntimeCatalogEntry
  primary: boolean
  onPick?: () => void
}) {
  return (
    <button
      type="button"
      data-testid={`runtime-pick-${entry.id}`}
      data-variant={primary ? 'wizard-primary' : 'wizard-secondary'}
      aria-label={`Choose ${entry.name}`}
      onClick={() => onPick?.()}
      className={[
        primary ? 'surface-overlay-tier' : 'surface-raised-tier',
        'group relative flex w-full items-center gap-3 rounded-xl text-left',
        'transition-[transform,border-color,filter] hover:-translate-y-px active:scale-[0.98]',
        'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2',
        primary ? 'p-5' : 'p-3.5',
      ].join(' ')}
      style={{ outlineColor: 'var(--primary)', opacity: primary ? 1 : 0.92, cursor: 'pointer' }}
    >
      <RuntimeIcon id={entry.id} size={primary ? 44 : 34} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span
            className="font-semibold"
            style={{ color: 'var(--foreground)', fontSize: primary ? 16 : 13.5 }}
          >
            {entry.name}
          </span>
          {primary && (
            <span
              className="inline-flex items-center gap-1 font-mono font-semibold uppercase tracking-wider"
              style={{
                fontSize: 9,
                padding: '2px 7px',
                borderRadius: 999,
                color: 'var(--mint)',
                background: 'rgb(var(--mint-rgb) / 0.12)',
              }}
            >
              <Sparkles size={10} /> Recommended
            </span>
          )}
        </div>
        <p
          className="mt-0.5 leading-relaxed"
          style={{ color: muted(primary ? 0.62 : 0.5), fontSize: primary ? 12 : 11 }}
        >
          {entry.blurb}
        </p>
      </div>
      <ArrowRight
        size={primary ? 18 : 15}
        className="shrink-0 transition-transform group-hover:translate-x-0.5"
        style={{ color: muted(primary ? 0.5 : 0.35) }}
      />
    </button>
  )
}

function ActionButton({
  children,
  onClick,
  icon,
  primary,
  busy,
  disabled,
  testid,
}: {
  children: React.ReactNode
  onClick: () => void | Promise<void>
  icon?: React.ReactNode
  primary?: boolean
  busy?: boolean
  disabled?: boolean
  testid?: string
}) {
  return (
    <button
      type="button"
      data-testid={testid}
      disabled={busy || disabled}
      onClick={() => void onClick()}
      className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[12px] font-semibold transition-[filter,transform] active:scale-[0.98] disabled:opacity-50"
      style={
        primary
          ? { background: 'var(--primary)', color: 'var(--primary-foreground)' }
          : {
              background: 'rgb(var(--foreground-rgb) / 0.06)',
              color: 'var(--foreground)',
              border: '1px solid rgb(var(--foreground-rgb) / 0.1)',
            }
      }
    >
      {busy ? <Spinner size={13} /> : icon}
      {children}
    </button>
  )
}
