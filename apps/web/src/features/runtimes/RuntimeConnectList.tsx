// The runtime-connection LIST — the shared surface for BOTH the onboarding
// "Add more runtimes" step (variant "onboarding") and the Settings → Runtimes
// manager (variant "panel").
//
// Every runtime is a visible row (brand tile + name + one-line blurb). The row
// RIGHT CONTROL is state-driven and is the ONLY interactive element besides an
// optional diagnostics button (the header is presentational — no nested button):
//   - not connected  → an explicit CTA button (Connect / Install / Sign in /
//     Set up). It is a pure disclosure toggle: clicking it EXPANDS the row to
//     reveal the connect elements, and flips to a ghost "Close" while open, so
//     the action verb never doubles. The REAL submit lives in the expanded body.
//   - in progress    → a non-interactive spinner chip (Installing… / Connecting…);
//     the row force-expands so its terminal shows.
//   - connected      → a bespoke mint verified-disc + "Connected" (NOT a pill).
//   - before the first status fetch → a neutral placeholder (never a stray CTA).
// There is NO chevron anywhere. A per-row visually-hidden live region announces
// the Installing/Connecting/Connected transitions to assistive tech.
//
// Panel extras (variant "panel"): a diagnostics Info button on every row (opens
// the shared drawer, where Re-check + Disconnect live), the built-in native
// runtime is a managed row (not the static foundation), and the OpenClaw row
// carries its MCP attach config.
//
// The expandable body stays MOUNTED when a row is collapsed (a CSS grid
// 0fr↔1fr height animation + `inert`, NOT display:none) so an in-flight SSE
// install survives a collapse. The connect state machine itself is the shared
// RuntimeConnectionCard (headerless here — the row owns the name + status).
// OpenClaw isn't a RuntimeId, so its row hosts the inline Gateway setup directly.

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { ArrowRight, Check, Download, Info, LogIn, Plug2, Settings2, X } from 'lucide-react'

import type { RuntimeStatus } from '@clawboo/control-client'

import { Button, IconButton } from '@/features/shared/Button'
import { Skeleton } from '@/features/shared/Skeleton'
import { Spinner } from '@/features/shared/Spinner'
import { RuntimeConnectionCard, type DisplayState } from './RuntimeConnectionCard'
import { OpenClawIcon, RuntimeIcon } from './RuntimeBrand'
import { RUNTIME_CATALOG, type RuntimeCatalogEntry, type RuntimeId } from './runtimeCatalog'

const muted = (o: number) => `rgb(var(--foreground-rgb) / ${o})`

export type RuntimeConnectVariant = 'onboarding' | 'panel'

/** Config for the OpenClaw row (OpenClaw isn't a RuntimeId, so it doesn't route
 *  through RuntimeConnectionCard). Owned here now that the list is the single
 *  connect surface. */
export interface OpenClawTabConfig {
  connected: boolean
  /** Status label (used by the diagnostics wiring; the row itself shows the
   *  premium Connected indicator when connected). */
  statusLabel: string
  onSetup?: () => void
  /** Testid for the "Set up OpenClaw" button (differs per host). */
  setupTestId: string
  /** Panel host: opens the OpenClaw diagnostics drawer. */
  onDiagnostics?: () => void
  /** Panel host: extra body content (the MCP attach config). */
  extra?: ReactNode
  /** When true, the row body renders `setupContent` IN-PLACE (the inline
   *  OpenClaw setup) instead of the "Set up OpenClaw" button. */
  setupOpen?: boolean
  setupContent?: ReactNode
}

// Concise one-liners for the row summary (the catalog blurbs are longer, sized
// for a full pane). Parallel structure: "<maker>'s coding agent · <auth>".
const LIST_BLURB: Record<RuntimeId, string> = {
  'clawboo-native': 'Built-in runtime · provider key',
  'claude-code': "Anthropic's coding agent · API key",
  codex: "OpenAI's coding agent · sign in",
  hermes: 'Open-source agent · OpenRouter key',
}

// The native "foundation" row in onboarding uses a warmer blurb (it is already
// powering the team); the panel uses the neutral catalog-style blurb above.
const NATIVE_FOUNDATION_BLURB = 'Powering your team'

// The state → CTA verb for the row's disclosure toggle. The toggle only reveals
// the body; the body owns the real action, so these labels never render twice.
const DEFAULT_CTA = { label: 'Connect', icon: <Plug2 size={13} /> }
const ROW_CTA: Partial<Record<DisplayState, { label: string; icon: ReactNode }>> = {
  'not-installed': { label: 'Install', icon: <Download size={13} /> },
  'needs-auth': { label: 'Connect', icon: <Plug2 size={13} /> },
  'needs-login': { label: 'Sign in', icon: <LogIn size={13} /> },
}

export interface RuntimeConnectListProps {
  /** The runtimes to render. Onboarding passes the coding runtimes (native shown
   *  separately as the connected foundation); the panel passes all of them. */
  runtimeIds: RuntimeId[]
  statuses: RuntimeStatus[]
  /** True once the first /api/runtimes fetch has settled — until then rows show
   *  a neutral placeholder instead of a premature "Connect" affordance. */
  loaded: boolean
  onChanged: () => void | Promise<void>
  openclaw: OpenClawTabConfig
  variant?: RuntimeConnectVariant
  /** Panel host: open the diagnostics drawer for a runtime. */
  onDiagnostics?: (id: RuntimeId) => void
}

export function RuntimeConnectList({
  runtimeIds,
  statuses,
  loaded,
  onChanged,
  openclaw,
  variant = 'onboarding',
  onDiagnostics,
}: RuntimeConnectListProps) {
  return (
    <div className="flex flex-col gap-2.5">
      {/* Onboarding only: the native foundation — already connected; the anchor
          for "add MORE". In the panel, native is a managed row in `runtimeIds`. */}
      {variant === 'onboarding' && (
        <AccordionRow
          testId="runtime-list-row-clawboo-native"
          icon={<RuntimeIcon id="clawboo-native" size={36} />}
          name={RUNTIME_CATALOG['clawboo-native'].name}
          blurb={NATIVE_FOUNDATION_BLURB}
          rightControl={<ConnectedIndicator />}
        />
      )}

      {runtimeIds.map((id) => (
        <RuntimeRow
          key={id}
          entry={RUNTIME_CATALOG[id]}
          status={statuses.find((s) => s.id === id)}
          loaded={loaded}
          variant={variant}
          onChanged={onChanged}
          onDiagnostics={onDiagnostics}
        />
      ))}

      <OpenClawRow config={openclaw} />
    </div>
  )
}

function RuntimeRow({
  entry,
  status,
  loaded,
  variant,
  onChanged,
  onDiagnostics,
}: {
  entry: RuntimeCatalogEntry
  status?: RuntimeStatus
  loaded: boolean
  variant: RuntimeConnectVariant
  onChanged: () => void | Promise<void>
  onDiagnostics?: (id: RuntimeId) => void
}) {
  const [userExpanded, setUserExpanded] = useState(false)
  const [display, setDisplay] = useState<DisplayState>('unknown')
  const prevShownRef = useRef<DisplayState | null>(null)
  // The fetched status (`live`) is the source of truth for SETTLED states; the
  // card's `display` only supplies the transient installing/connecting overlay
  // while it is mounted. Never latch a settled state on `display` — the card
  // reports 'ready' only when `status.connectionState` is already 'ready' (the
  // connect flow awaits the refetch), so a stale 'ready' must not outlive `live`
  // (else a connect-then-disconnect leaves the row falsely "Connected").
  const live = status?.connectionState as DisplayState | undefined
  const shown: DisplayState =
    display === 'installing' || display === 'connecting' ? display : (live ?? 'unknown')
  const testId = `runtime-list-row-${entry.id}`
  const rowProps = {
    testId,
    icon: <RuntimeIcon id={entry.id} size={36} />,
    name: entry.name,
    blurb: LIST_BLURB[entry.id],
  }
  const diag =
    variant === 'panel' && onDiagnostics ? (
      <DiagnosticsButton id={entry.id} name={entry.name} onClick={() => onDiagnostics(entry.id)} />
    ) : null
  const withDiag = (control: ReactNode) => (
    <div className="flex shrink-0 items-center gap-1">
      {diag}
      {control}
    </div>
  )

  const inProgress = shown === 'installing' || shown === 'connecting'

  // On a genuine connect/install completion, the focused control (key input /
  // Connect button, then the whole card) unmounts as the row settles to the
  // static Connected indicator — move focus to the row's diagnostics button
  // (panel) so keyboard/AT focus is not dumped to <body>. No-op in onboarding.
  useEffect(() => {
    const prev = prevShownRef.current
    prevShownRef.current = shown
    if (shown === 'ready' && (prev === 'connecting' || prev === 'installing')) {
      const active = document.activeElement
      if (!active || active === document.body) {
        document
          .querySelector<HTMLElement>(`[data-testid="runtime-${entry.id}-diagnostics"]`)
          ?.focus?.()
      }
    }
  }, [shown, entry.id])

  // Before the first status fetch lands, don't flash a generic "Connect" CTA (an
  // already-connected runtime would briefly look unconnected). Neutral placeholder.
  if (!loaded && shown === 'unknown') {
    return <AccordionRow {...rowProps} rightControl={withDiag(<Skeleton width={92} height={30} radius={9} />)} />
  }

  // A connected runtime settles to the indicator (its visible label is the
  // accessible "Connected"); the card unmounts. In the panel its Re-check /
  // Disconnect live in the diagnostics drawer (the Info button).
  if (shown === 'ready') {
    return <AccordionRow {...rowProps} rightControl={withDiag(<ConnectedIndicator />)} />
  }

  const expanded = userExpanded || inProgress
  const progressLabel = shown === 'installing' ? 'Installing…' : 'Connecting…'
  const control = inProgress ? (
    <InProgressChip label={progressLabel} />
  ) : (
    <CtaToggle
      expanded={expanded}
      onToggle={() => setUserExpanded((v) => !v)}
      bodyId={`${testId}-body`}
      cta={ROW_CTA[shown] ?? DEFAULT_CTA}
      name={entry.name}
      testId={testId}
    />
  )

  return (
    <AccordionRow
      {...rowProps}
      rightControl={withDiag(control)}
      expanded={expanded}
      announce={inProgress ? progressLabel : ''}
    >
      <RuntimeConnectionCard
        hideHeader
        entry={entry}
        status={status}
        variant={variant}
        onChanged={onChanged}
        onDisplayState={setDisplay}
      />
    </AccordionRow>
  )
}

function OpenClawRow({ config }: { config: OpenClawTabConfig }) {
  const [userExpanded, setUserExpanded] = useState(false)
  const testId = 'runtime-list-row-openclaw'
  const rowProps = {
    testId,
    icon: <OpenClawIcon size={36} />,
    name: 'OpenClaw',
    blurb: 'Run OpenClaw agents on a local Gateway',
  }
  const diag = config.onDiagnostics ? (
    <DiagnosticsButton id="openclaw" name="OpenClaw" onClick={config.onDiagnostics} />
  ) : null
  const withDiag = (control: ReactNode) => (
    <div className="flex shrink-0 items-center gap-1">
      {diag}
      {control}
    </div>
  )

  if (config.connected) {
    // Panel: expandable "Manage" to the MCP attach config. Onboarding (no extra):
    // a static Connected indicator, nothing to manage.
    if (config.extra) {
      return (
        <AccordionRow
          {...rowProps}
          rightControl={withDiag(
            <div className="flex shrink-0 items-center gap-1.5">
              <ConnectedIndicator />
              <CtaToggle
                expanded={userExpanded}
                onToggle={() => setUserExpanded((v) => !v)}
                bodyId={`${testId}-body`}
                cta={{ label: 'Manage', icon: <Settings2 size={13} /> }}
                name="OpenClaw"
                testId={testId}
              />
            </div>,
          )}
          expanded={userExpanded}
        >
          {config.extra}
        </AccordionRow>
      )
    }
    return <AccordionRow {...rowProps} rightControl={withDiag(<ConnectedIndicator />)} />
  }

  const settingUp = !!config.setupOpen
  const expanded = userExpanded || settingUp
  // While the inline setup is open it moves through automated AND user-waiting
  // phases (paste a key, approve the device). The body owns the live phase UI,
  // so the header shows a calm neutral marker, never a perpetual spinner.
  const control = settingUp ? (
    <span className="inline-flex shrink-0 items-center text-[12px]" style={{ color: muted(0.55) }}>
      In setup
    </span>
  ) : (
    <CtaToggle
      expanded={expanded}
      onToggle={() => setUserExpanded((v) => !v)}
      bodyId={`${testId}-body`}
      cta={{ label: 'Set up', icon: <ArrowRight size={13} /> }}
      name="OpenClaw"
      testId={testId}
    />
  )

  return (
    <AccordionRow {...rowProps} rightControl={withDiag(control)} expanded={expanded}>
      {settingUp && config.setupContent ? (
        config.setupContent
      ) : (
        <div className="flex flex-col gap-3">
          <p className="text-[12px] leading-relaxed" style={{ color: muted(0.55) }}>
            The pro path: Clawboo detects, installs, and starts a local OpenClaw Gateway, reusing the
            provider key you already connected.
          </p>
          {config.onSetup && (
            <div>
              <Button
                variant="secondary"
                size="sm"
                data-testid={config.setupTestId}
                onClick={config.onSetup}
              >
                Set up OpenClaw
              </Button>
            </div>
          )}
          {config.extra}
        </div>
      )}
    </AccordionRow>
  )
}

/** Ghost Info button that opens the shared diagnostics drawer (panel only). */
function DiagnosticsButton({
  id,
  name,
  onClick,
}: {
  id: string
  name: string
  onClick: () => void
}) {
  return (
    <IconButton
      variant="ghost"
      size="sm"
      label={`${name} diagnostics`}
      data-testid={`runtime-${id}-diagnostics`}
      onClick={onClick}
      className="shrink-0"
    >
      <Info size={15} />
    </IconButton>
  )
}

/** The state CTA that doubles as the row's disclosure toggle. Collapsed it is a
 *  secondary `[icon] verb` button; expanded it flips to a ghost `X Close` in the
 *  SAME DOM position (so focus survives the swap). It only reveals the body —
 *  the real submit lives inside. No chevron. */
function CtaToggle({
  expanded,
  onToggle,
  bodyId,
  cta,
  name,
  testId,
}: {
  expanded: boolean
  onToggle: () => void
  bodyId: string
  cta: { label: string; icon: ReactNode }
  name: string
  testId: string
}) {
  return (
    <Button
      variant={expanded ? 'ghost' : 'secondary'}
      size="sm"
      onClick={onToggle}
      aria-expanded={expanded}
      aria-controls={bodyId}
      aria-label={expanded ? `Collapse ${name}` : `${cta.label} ${name}`}
      data-testid={`${testId}-toggle`}
      className="shrink-0"
    >
      {expanded ? (
        <>
          <X size={14} /> Close
        </>
      ) : (
        <>
          {cta.icon} {cta.label}
        </>
      )}
    </Button>
  )
}

/** Visual-only in-progress chip (aria-hidden; the row's live region does the
 *  announcing). The row is force-expanded while this shows, so the terminal is
 *  visible underneath. */
function InProgressChip({ label }: { label: string }) {
  return (
    <span
      aria-hidden
      className="inline-flex shrink-0 items-center gap-1.5 text-[12px]"
      style={{ color: muted(0.55) }}
    >
      <Spinner size={13} /> {label}
    </span>
  )
}

/** The premium "connected" indicator that replaces the outdated status pill:
 *  a small filled mint verified-disc (rhyming with the row's brand tile) + a
 *  calm neutral-ink sentence-case label. No pill, no uppercase, no mono. */
function ConnectedIndicator() {
  return (
    // The "Connected" text is the accessible label (read on navigation); the mint
    // disc is decorative. In-progress transitions are announced via the row's
    // live region — the connected state is not re-announced (it would spam on load
    // + double-read against this label).
    <span className="inline-flex shrink-0 items-center gap-1.5">
      <span
        aria-hidden
        className="inline-flex items-center justify-center"
        style={{
          width: 18,
          height: 18,
          borderRadius: 999,
          background: 'var(--mint)',
          boxShadow: '0 1px 2px rgb(var(--mint-rgb) / 0.35)',
          animation: 'clawboo-disc-pop 0.26s cubic-bezier(0.34, 1.4, 0.64, 1)',
        }}
      >
        <Check size={11} strokeWidth={2.75} style={{ color: 'var(--background)' }} aria-hidden />
      </span>
      <span
        className="text-[12.5px] font-medium"
        style={{ color: 'rgb(var(--foreground-rgb) / 0.72)', letterSpacing: '-0.006em' }}
      >
        Connected
      </span>
    </span>
  )
}

/** One list row: a presentational header (brand tile + name + blurb + the single
 *  state-driven right control) over a height-animated body that stays mounted
 *  when collapsed (so an in-flight install survives). Omit `children` for a
 *  static row (the connected native foundation / a settled runtime). `announce`
 *  feeds a persistent visually-hidden live region so state transitions
 *  (Installing/Connecting/Connected) are spoken to assistive tech. */
function AccordionRow({
  testId,
  icon,
  name,
  blurb,
  rightControl,
  expanded = false,
  announce = '',
  children,
}: {
  testId: string
  icon: ReactNode
  name: string
  blurb: string
  rightControl: ReactNode
  expanded?: boolean
  announce?: string
  children?: ReactNode
}) {
  const bodyId = `${testId}-body`
  const bodyRef = useRef<HTMLDivElement>(null)
  // On expand, move focus into the revealed body — prefer the key input over the
  // "Get a key" link (querySelector honours document order, and the link precedes
  // the input). Optional-chained → no-ops in jsdom/tests.
  useEffect(() => {
    if (!expanded) return
    const id = requestAnimationFrame(() => {
      const el =
        bodyRef.current?.querySelector<HTMLElement>('input, textarea') ??
        bodyRef.current?.querySelector<HTMLElement>('button, a[href]')
      el?.focus?.()
    })
    return () => cancelAnimationFrame(id)
  }, [expanded])

  return (
    <div
      data-testid={testId}
      className="overflow-hidden rounded-2xl border border-border"
      style={{ background: 'var(--surface)' }}
    >
      <div className="flex w-full items-center gap-3 px-4 py-3.5">
        {icon}
        <span className="min-w-0 flex-1">
          <span
            className="block truncate text-[13.5px] font-semibold"
            style={{ color: 'var(--foreground)' }}
          >
            {name}
          </span>
          <span className="mt-0.5 block truncate text-[11.5px]" style={{ color: muted(0.5) }}>
            {blurb}
          </span>
        </span>
        {rightControl}
      </div>

      {/* The row's accessible status — read after the name on navigation, and
          announced (polite) on Installing/Connecting/Connected transitions. */}
      <span role="status" aria-live="polite" className="sr-only">
        {announce}
      </span>

      {children != null && (
        <div
          className="grid"
          style={{
            gridTemplateRows: expanded ? '1fr' : '0fr',
            transition: 'grid-template-rows 220ms cubic-bezier(0.4,0,0.2,1)',
          }}
        >
          <div
            ref={bodyRef}
            id={bodyId}
            className="overflow-hidden"
            style={{ minHeight: 0 }}
            inert={!expanded ? true : undefined}
          >
            <div className="border-t border-border px-4 py-4">{children}</div>
          </div>
        </div>
      )}
    </div>
  )
}
