// The shared runtime connection state-machine content — the body an expanded
// RuntimeConnectList row reveals (onboarding Add-runtimes step + the Settings
// Runtimes panel). One component, one state machine:
//
//   not-installed (Install, SSE) → installing
//     → needs-auth (paste key) | needs-login (codex login + Re-check)
//     → connecting → ready (Re-check + Disconnect[panel])   (+ error / unknown)
//
// With `hideHeader` (the list host) it carries NO name/status header, no brand
// tile (the row owns them) — just the status-specific inputs + the one action
// the current state needs. Reuses the onboarding InstallStep SSE-terminal pattern
// (no abort on unmount; Retry aborts the prior controller) + the ConfigureStep
// key-input affordance. `onDisplayState` reports the live state up so the row can
// drive its CTA / Connected indicator.

import { useEffect, useRef, useState } from 'react'
import {
  ArrowRight,
  Download,
  ExternalLink,
  Eye,
  EyeOff,
  Info,
  Plug2,
  RotateCcw,
  Sparkles,
  Terminal,
} from 'lucide-react'

import { Button, IconButton } from '@/features/shared/Button'
import { FormattedAlert } from '@/features/shared/FormattedAlert'
import { ChatGptSignIn } from './ChatGptSignIn'
import { InstalledAck } from './InstalledAck'
import { Spinner } from '@/features/shared/Spinner'
import { StatusPill, type StatusTone } from '@/features/shared/StatusPill'
import {
  connectRuntime,
  disconnectRuntime,
  installRuntime,
  type ConnectionState,
  type RuntimeStatus,
} from '@clawboo/control-client'

import { confirm } from '@/stores/confirm'
import { RuntimeIcon } from './RuntimeBrand'
import type { RuntimeCatalogEntry } from './runtimeCatalog'

const muted = (o: number) => `rgb(var(--foreground-rgb) / ${o})`

export type DisplayState = ConnectionState | 'installing' | 'connecting'

/** The canonical state → pill map for this component's own (non-hideHeader)
 *  header. Exported so hosts can reuse the exact same tones + labels. */
export const DISPLAY_PILL: Record<DisplayState, { tone: StatusTone; label: string }> = {
  'not-installed': { tone: 'idle', label: 'Not installed' },
  installing: { tone: 'working', label: 'Installing…' },
  'needs-auth': { tone: 'warning', label: 'Needs key' },
  'needs-login': { tone: 'warning', label: 'Needs login' },
  connecting: { tone: 'working', label: 'Connecting…' },
  ready: { tone: 'success', label: 'Connected' },
  unknown: { tone: 'idle', label: 'Unknown' },
}

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
  /** Fired after any state-changing action so the host can refetch status. May
   *  return a promise; the card awaits it so it can hold its in-flight state
   *  (Connecting… / Installing…) until the refreshed status lands, instead of
   *  briefly reverting to the stale pre-action state. */
  onChanged?: () => void | Promise<void>
  /** Fired when a wizard-pick card is chosen (wizard-* variants only). */
  onPick?: () => void
  /** Opens the diagnostics drawer for this runtime (panel variant only). */
  onDiagnostics?: () => void
  /** Reports the live display state up so the row can drive its CTA / indicator. */
  onDisplayState?: (state: DisplayState) => void
  /** Hide the internal name+status header — the LIST host (RuntimeConnectList)
   *  renders its own row summary, so the card supplies only the connect body. */
  hideHeader?: boolean
  /** Whether Codex (the ChatGPT-subscription runtime) is already connected.
   *  Gates the OPTIONAL "use your ChatGPT subscription" affordance on OTHER
   *  runtimes' cards (hermes) — the subscription is set up on the Providers
   *  surfaces first; here it only surfaces once that's a detected fact. */
  codexReady?: boolean
}

export function RuntimeConnectionCard({
  entry,
  status,
  variant,
  onChanged,
  onPick,
  onDiagnostics,
  onDisplayState,
  hideHeader,
  codexReady,
}: RuntimeConnectionCardProps) {
  const [installing, setInstalling] = useState(false)
  // Set only by an install's own completion → drives the "just installed" ack.
  const [justInstalled, setJustInstalled] = useState(false)
  const [installLog, setInstallLog] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [keyInput, setKeyInput] = useState('')
  const [showKey, setShowKey] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const controllerRef = useRef<AbortController | null>(null)
  const logEndRef = useRef<HTMLDivElement | null>(null)

  // Computed ABOVE the wizard early-return so the display-state effect (a hook)
  // always runs in the same order regardless of variant.
  const display: DisplayState = installing
    ? 'installing'
    : busy
      ? 'connecting'
      : (status?.connectionState ?? 'unknown')

  useEffect(() => {
    onDisplayState?.(display)
  }, [display, onDisplayState])

  // Wizard-pick variants: a selection surface, not the connect machine. Picking
  // sets the chosen runtime and advances the wizard to the right next step.
  if (variant === 'wizard-primary' || variant === 'wizard-secondary') {
    return (
      <RuntimeChoiceCard entry={entry} primary={variant === 'wizard-primary'} onPick={onPick} />
    )
  }

  const pill = DISPLAY_PILL[display]

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
        // Hold 'installing' until the refetch lands the post-install state, so the
        // row doesn't flash the stale 'Install' affordance before it settles.
        void (async () => {
          await onChanged?.()
          setInstalling(false)
          setJustInstalled(true) // acknowledge the install before the connect step
        })()
      },
    })
  }

  async function handleConnect(): Promise<void> {
    if (!keyInput.trim()) return
    setBusy(true)
    setError(null)
    const r = await connectRuntime(entry.id, keyInput.trim())
    if (!r.ok) {
      setBusy(false)
      setError(r.error ?? 'Failed to save the key')
      return
    }
    setKeyInput('')
    // Hold the 'connecting' state until the parent's status refetch lands, so the
    // row settles Connecting → Connected without flashing back to the stale form.
    await onChanged?.()
    setBusy(false)
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
      !(await confirm({
        title: `Disconnect ${entry.name}?`,
        message:
          "This removes its saved API key from the encrypted vault. You'll need to re-enter it to reconnect.",
        confirmLabel: 'Disconnect',
        tone: 'danger',
      }))
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

  return (
    <div data-testid={`runtime-card-${entry.id}`} className="flex flex-col gap-3.5">
      {/* Header — name + status. Hidden in the LIST host (hideHeader), which
          renders its own row summary (brand tile + name + state control). */}
      {!hideHeader && (
        <div className="flex items-center gap-2.5">
          <span
            className="whitespace-nowrap text-[13.5px] font-semibold"
            style={{ color: 'var(--foreground)' }}
          >
            {entry.name}
          </span>
          <StatusPill tone={pill.tone} label={pill.label} />
          <span className="flex-1" />
          {variant === 'panel' && onDiagnostics && (
            <IconButton
              variant="ghost"
              size="sm"
              label={`${entry.name} diagnostics`}
              data-testid={`runtime-${entry.id}-diagnostics`}
              onClick={onDiagnostics}
              className="shrink-0"
            >
              <Info size={15} />
            </IconButton>
          )}
        </div>
      )}

      {/* Install terminal log — collapses to the clean "installed" ack below
          once the install completes (the raw log has served its purpose). */}
      {installing || (installLog.length > 0 && !justInstalled) ? (
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

      {/* Just-installed acknowledgement — the success beat between "Installing…"
          and the connect/sign-in step. Only in a genuine post-install connect
          state (never contradicting a still-'not-installed' refetch), and it
          clears once the runtime is connected. */}
      {justInstalled && (display === 'needs-auth' || display === 'needs-login') && (
        <InstalledAck name={entry.name} testId={`runtime-${entry.id}-installed-ack`} />
      )}

      {/* Error */}
      {error && <FormattedAlert tone="error">{error}</FormattedAlert>}

      {/* Key input (api-key runtimes that need a key) */}
      {display === 'needs-auth' && entry.authKind === 'api-key' && (
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between">
            <label
              className="font-mono text-[10px] uppercase tracking-widest"
              style={{ color: muted(0.5) }}
            >
              {entry.envVar}
            </label>
            {entry.keyUrl && (
              <a
                href={entry.keyUrl}
                target="_blank"
                rel="noreferrer noopener"
                data-testid={`runtime-${entry.id}-get-key`}
                className="inline-flex items-center gap-1 text-[10px] font-medium underline-offset-2 hover:underline"
                style={{ color: 'var(--primary)' }}
              >
                Get a key <ExternalLink size={10} />
              </a>
            )}
          </div>
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
              className="w-full rounded-lg border border-border bg-surface px-3 py-2.5 pr-10 font-mono text-[12.5px] text-foreground outline-none transition focus:border-primary focus:ring-4 focus:ring-primary/15 placeholder:text-foreground/30"
            />
            <button
              type="button"
              tabIndex={-1}
              aria-label={showKey ? 'Hide key' : 'Show key'}
              onClick={() => setShowKey((s) => !s)}
              className="absolute right-1.5 top-1/2 flex -translate-y-1/2 cursor-pointer items-center justify-center rounded-md p-1.5 text-foreground/45 transition-colors hover:bg-foreground/[0.06] hover:text-foreground/70"
            >
              {showKey ? <EyeOff size={15} /> : <Eye size={15} />}
            </button>
          </div>
        </div>
      )}

      {/* Optional ChatGPT-subscription path (hermes) — surfaced ONLY once Codex
          is a detected fact (it gets connected on the Providers surfaces, not
          here). Deliberately quiet: the key input above stays the primary
          connect path; this is a subordinate alternative, never a demand. */}
      {display === 'needs-auth' && entry.altLoginCommand && codexReady && (
        <div
          className="flex flex-col gap-2 rounded-xl border border-border px-3.5 py-3"
          style={{ background: 'rgb(var(--foreground-rgb) / 0.02)' }}
          data-testid={`runtime-${entry.id}-alt-login`}
        >
          <p className="text-[11.5px] leading-snug" style={{ color: muted(0.55) }}>
            <span className="font-medium" style={{ color: muted(0.75) }}>
              Codex is connected.
            </span>{' '}
            {entry.name} can run on your ChatGPT subscription instead of a key. Each runtime keeps
            its own sign-in, so connect it here too.
          </p>
          <ChatGptSignIn
            tool="hermes"
            loginCommand={entry.altLoginCommand}
            onLoggedIn={() => void handleRecheck()}
            label="Use my ChatGPT subscription"
          />
        </div>
      )}

      {/* ChatGPT sign-in (oauth runtimes — codex): signing in IS this runtime's
          connect action. The manual command surfaces inside the flow's failure
          states — not as standing chrome. */}
      {display === 'needs-login' && entry.id === 'codex' && (
        <ChatGptSignIn
          tool="codex"
          loginCommand={entry.loginCommand ?? 'codex login'}
          onLoggedIn={() => void handleRecheck()}
        />
      )}

      {/* Install command — subdued, its own row (the primary action is the
          Install button below), so a long `npm install -g …` never competes
          with or crowds the CTA on the narrow onboarding card. */}
      {display === 'not-installed' && entry.installCommand && (
        <div
          className="rounded-lg px-3 py-2 font-mono text-[10px]"
          style={{
            background: 'var(--code-block-bg, rgb(var(--foreground-rgb) / 0.05))',
            color: muted(0.5),
          }}
        >
          {entry.installCommand}
        </div>
      )}

      {/* Action row — exactly one prominent action per state (Install /
          Connect); Re-check / Disconnect / copy are subdued. */}
      <div className="mt-auto flex items-center gap-2">
        {display === 'not-installed' && (
          <ActionButton
            testid={`runtime-${entry.id}-install`}
            primary={variant === 'panel'}
            onClick={handleInstall}
            icon={<Download size={13} />}
          >
            Install
          </ActionButton>
        )}

        {display === 'installing' && (
          <span className="flex items-center gap-2 text-[11px]" style={{ color: muted(0.55) }}>
            <Spinner size={13} /> Installing {entry.name}…
          </span>
        )}

        {display === 'needs-auth' && (
          <ActionButton
            testid={`runtime-${entry.id}-connect`}
            primary={variant === 'panel'}
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
              <Button
                variant="ghost"
                size="sm"
                data-testid={`runtime-${entry.id}-disconnect`}
                onClick={() => void handleDisconnect()}
              >
                Disconnect
              </Button>
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
          <Button
            variant="ghost"
            size="sm"
            onClick={display === 'needs-auth' ? () => void handleConnect() : handleInstall}
          >
            Retry
          </Button>
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
  // Routes through the shared Button primitive so Install / Connect / Re-check
  // inherit the standard height, brand shadow, focus ring, and disabled state.
  return (
    <Button
      variant={primary ? 'primary' : 'secondary'}
      size="sm"
      data-testid={testid}
      loading={busy}
      disabled={disabled}
      onClick={() => void onClick()}
    >
      {!busy && icon}
      {children}
    </Button>
  )
}
