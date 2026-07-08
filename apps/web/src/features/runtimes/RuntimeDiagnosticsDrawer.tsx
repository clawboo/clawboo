// Per-runtime diagnostics — a right-slide drawer (clones the board TaskDetailDrawer
// pattern) opened from each runtime card + the OpenClaw row. Shows the integration
// depth (derived from capabilities.runtimeClass, never a per-name switch), a
// client-side health-probe timeline, the depth-correct configuration facts, the
// vault-key PRESENCE (the env-var NAME + true/false — never the value), recent
// errors from the obs taxonomy, and a deep-link into the Capabilities panel
// filtered to this runtime.

import { useEffect, useState, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { motion } from 'framer-motion'
import {
  Activity,
  AlertCircle,
  BookOpen,
  Boxes,
  Check,
  Copy,
  ExternalLink,
  KeyRound,
  Plug,
  RotateCcw,
  ShieldCheck,
  X,
} from 'lucide-react'

import { Button, IconButton } from '@/features/shared/Button'
import { EmptyState } from '@/features/shared/EmptyState'
import { StatusPill, type StatusTone } from '@/features/shared/StatusPill'
import { fetchCapabilities } from '@/lib/capabilitiesClient'
import { formatRelative } from '@/lib/formatRelative'
import { ENTER_SPRING } from '@/lib/motion'
import { disconnectRuntime, type ConnectionState, type RuntimeClass } from '@clawboo/control-client'
import { useCapabilityFilterStore } from '@/stores/capabilityFilter'
import { useToastStore } from '@/stores/toast'
import { confirm } from '@/stores/confirm'
import { useSettingsModalStore } from '@/stores/settingsModal'

import { RuntimeDepthBadge, RuntimeGlyph } from './runtimeDepth'
import { useRuntimeProbeStore, type ProbeSample } from './runtimeProbeStore'
import type { RuntimeId } from './runtimeCatalog'

const muted = (o: number) => `rgb(var(--foreground-rgb) / ${o})`

// Stable empty reference — selecting `s.history[id] ?? []` inline would mint a new
// array each render and loop the zustand subscription. Default OUTSIDE the selector.
const EMPTY_HISTORY: ProbeSample[] = []

/** The normalized, RuntimeId-agnostic input the panel builds for either an
 *  OpenClaw row or a non-OpenClaw card. Carries ONLY presence + names — never a
 *  secret value (the leak invariant is upheld by construction here). */
export interface RuntimeDiagnosticsTarget {
  id: string
  name: string
  runtimeClass: RuntimeClass
  statusTone: StatusTone
  statusLabel: string
  health: { ok: boolean; message?: string }
  docsUrl?: string
  /** Capabilities for the chip row. */
  caps?: { streaming?: boolean; mcp?: boolean; worktrees?: boolean; resume?: boolean }
  // ── wrapped-oneshot / native facts ──
  connectionState?: ConnectionState
  installed?: boolean
  binPath?: string | null
  authKind?: string
  envVar?: string | null
  hasCredential?: boolean
  loginCommand?: string
  models?: string[]
  contextWindowTokens?: number
  nativeHome?: { scope: string; persist: boolean }
  nativeMemory?: string
  nativeSkills?: string
  // ── connected-substrate (OpenClaw) facts ──
  gatewayUrl?: string | null
  connectionStatus?: string
}

interface RuntimeErrorRow {
  runtime?: string | null
  errorClass?: string
  message?: string
  ts?: number
}

function Section({
  icon,
  title,
  children,
}: {
  icon: React.ReactNode
  title: string
  children: React.ReactNode
}) {
  return (
    <div style={{ marginBottom: 20 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 10 }}>
        <span style={{ color: muted(0.45), display: 'flex' }}>{icon}</span>
        <span
          className="font-mono uppercase"
          style={{
            fontSize: 11,
            letterSpacing: '0.14em',
            color: muted(0.45),
          }}
        >
          {title}
        </span>
      </div>
      {children}
    </div>
  )
}

function kv(label: string, value: string) {
  return (
    <div style={{ display: 'flex', gap: 10, fontSize: 12, marginBottom: 4 }}>
      <span style={{ color: muted(0.4), minWidth: 96 }}>{label}</span>
      <span className="font-data" style={{ color: 'var(--foreground)', wordBreak: 'break-all' }}>
        {value}
      </span>
    </div>
  )
}

export function RuntimeDiagnosticsDrawer({
  target,
  onClose,
  onRecheck,
}: {
  target: RuntimeDiagnosticsTarget
  onClose: () => void
  onRecheck: () => void | Promise<void>
}) {
  const history = useRuntimeProbeStore((s) => s.history[target.id]) ?? EMPTY_HISTORY
  const setPendingRuntime = useCapabilityFilterStore((s) => s.setPendingRuntime)
  const openSettings = useSettingsModalStore((s) => s.openSettings)
  const [errors, setErrors] = useState<RuntimeErrorRow[]>([])
  const [skillCount, setSkillCount] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const [, setNow] = useState(Date.now())
  const addToast = useToastStore((s) => s.addToast)

  // Recent errors from the obs taxonomy, filtered to this runtime (defensive).
  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const res = await fetch('/api/obs/errors')
        if (!res.ok) return
        const body = (await res.json()) as { errors?: RuntimeErrorRow[] }
        if (alive) setErrors((body.errors ?? []).filter((e) => e.runtime === target.id).slice(0, 5))
      } catch {
        /* leave empty */
      }
    })()
    return () => {
      alive = false
    }
  }, [target.id])

  // Hermes skills count comes from the unified capability inventory (no new endpoint).
  useEffect(() => {
    if (target.id !== 'hermes') return
    let alive = true
    void (async () => {
      const view = await fetchCapabilities({ runtime: 'hermes', kind: 'skill' })
      if (alive) setSkillCount(view.records.length)
    })()
    return () => {
      alive = false
    }
  }, [target.id])

  // Keep the relative timestamps fresh while open.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 15_000)
    return () => clearInterval(id)
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const handleRecheck = useCallback(async () => {
    setBusy(true)
    await onRecheck()
    setTimeout(() => setBusy(false), 400)
  }, [onRecheck])

  const handleDisconnect = useCallback(async () => {
    if (
      !(await confirm({
        title: `Disconnect ${target.name}?`,
        message:
          "This removes its saved API key from the encrypted vault — you'll need to re-enter it to reconnect.",
        confirmLabel: 'Disconnect',
        tone: 'danger',
      }))
    ) {
      return
    }
    setBusy(true)
    const r = await disconnectRuntime(target.id as RuntimeId)
    setBusy(false)
    if (!r.ok) {
      addToast({ message: r.error ?? `Failed to disconnect ${target.name}`, type: 'error' })
      return
    }
    await onRecheck()
  }, [target.id, target.name, onRecheck, addToast])

  function handleViewCapabilities(): void {
    setPendingRuntime(target.id)
    // Capabilities lives in the Settings modal now — switch the modal to it
    // (CapabilitiesPanel consumes pendingRuntime for the pre-filter).
    openSettings('capabilities')
    onClose()
  }

  function handleCopyLogin(): void {
    if (!target.loginCommand) return
    void navigator.clipboard?.writeText(target.loginCommand)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  const canDisconnect = target.connectionState === 'ready' && target.authKind === 'api-key'

  // Portalled to <body> so the fixed-position drawer resolves against the
  // viewport (not clipped/contained when this panel is rendered inside the
  // Settings modal, whose glass backdrop-filter + overflow-hidden would
  // otherwise trap it). z above the settings scrim (z-70).
  return createPortal(
    <>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        onClick={onClose}
        style={{
          position: 'fixed',
          inset: 0,
          background: 'var(--overlay-scrim, rgb(0 0 0 / 0.5))',
          zIndex: 80,
        }}
      />
      <motion.div
        data-testid="runtime-diagnostics-drawer"
        role="dialog"
        aria-label={`${target.name} diagnostics`}
        className="surface-overlay-tier"
        initial={{ x: '100%' }}
        animate={{ x: 0 }}
        exit={{ x: '100%' }}
        transition={ENTER_SPRING}
        style={{
          position: 'fixed',
          top: 0,
          right: 0,
          bottom: 0,
          width: 'min(480px, 92vw)',
          borderRadius: 0,
          borderLeft: '1px solid var(--border-overlay, rgb(var(--foreground-rgb) / 0.08))',
          zIndex: 81,
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {/* Header */}
        <div
          style={{
            height: 56,
            flexShrink: 0,
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '0 14px',
            borderBottom: '1px solid rgb(var(--foreground-rgb) / 0.08)',
          }}
        >
          <RuntimeGlyph id={target.id} size={26} />
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span
                style={{
                  fontSize: 14,
                  fontWeight: 600,
                  color: 'var(--foreground)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {target.name}
              </span>
              <StatusPill tone={target.statusTone} label={target.statusLabel} />
            </div>
            <div style={{ marginTop: 2 }}>
              <RuntimeDepthBadge runtimeClass={target.runtimeClass} testid="runtime-depth-badge" />
            </div>
          </div>
          <IconButton variant="ghost" size="sm" label="Close" onClick={onClose}>
            <X size={16} />
          </IconButton>
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: '16px 16px 32px' }}>
          {/* Health-probe history */}
          <Section icon={<Activity size={13} />} title="Health checks">
            {history.length === 0 ? (
              <div style={{ fontSize: 11, color: muted(0.4) }}>
                No checks recorded yet — they accrue every few seconds.
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                {[...history]
                  .slice(-8)
                  .reverse()
                  .map((s, i) => (
                    <div
                      key={`${s.ts}-${i}`}
                      style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11.5 }}
                    >
                      <span
                        aria-hidden
                        style={{
                          width: 7,
                          height: 7,
                          borderRadius: 4,
                          flexShrink: 0,
                          background: s.ok ? 'var(--mint)' : 'var(--primary)',
                        }}
                      />
                      <span style={{ color: muted(0.55), minWidth: 64 }}>
                        {formatRelative(s.ts)}
                      </span>
                      <span style={{ color: s.ok ? 'var(--mint)' : 'var(--primary)' }}>
                        {s.ok ? 'healthy' : (s.message ?? 'unavailable')}
                      </span>
                    </div>
                  ))}
              </div>
            )}
          </Section>

          {/* Integration / configuration — branch on the derived depth */}
          <Section icon={<Plug size={13} />} title="Integration">
            {target.runtimeClass === 'connected-substrate' ? (
              <>
                {kv('Gateway', target.gatewayUrl ?? '—')}
                {kv(
                  'Connection',
                  target.connectionStatus ?? (target.health.ok ? 'connected' : 'disconnected'),
                )}
                {kv('Channels', 'native to OpenClaw (read-only)')}
              </>
            ) : (
              <>
                {target.runtimeClass === 'native' ? (
                  <>
                    {kv('Provider key', presence(target.hasCredential, target.envVar))}
                    {target.models && target.models.length > 0
                      ? kv('Models', target.models.slice(0, 3).join(', '))
                      : null}
                    {typeof target.contextWindowTokens === 'number'
                      ? kv('Context', `${Math.round(target.contextWindowTokens / 1000)}k tokens`)
                      : null}
                    {target.nativeMemory ? kv('Memory', target.nativeMemory) : null}
                  </>
                ) : (
                  <>
                    {kv(
                      'CLI',
                      target.installed ? (target.binPath ?? 'installed') : 'not installed',
                    )}
                    {target.authKind === 'oauth'
                      ? kv('Auth', target.connectionState === 'ready' ? 'signed in' : 'needs login')
                      : kv('Provider key', presence(target.hasCredential, target.envVar))}
                  </>
                )}
                {target.nativeHome
                  ? kv(
                      'Home',
                      target.nativeHome.persist
                        ? `persistent · ${target.nativeHome.scope}`
                        : 'ephemeral (per run)',
                    )
                  : null}
                {target.id === 'hermes' ? (
                  <>
                    {kv('Skills', skillCount === null ? '…' : String(skillCount))}
                    {kv('Self-improvement', 'managed by Hermes')}
                  </>
                ) : null}
              </>
            )}

            {/* Codex login affordance */}
            {target.connectionState === 'needs-login' && target.loginCommand ? (
              <div
                style={{
                  marginTop: 10,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 8,
                  borderRadius: 12,
                  padding: '10px 12px',
                  background: 'var(--terminal-bg)',
                }}
              >
                <code
                  className="font-mono"
                  style={{ fontSize: 12, color: 'rgb(201 209 217 / 0.9)' }}
                >
                  {target.loginCommand}
                </code>
                <button
                  type="button"
                  aria-label="Copy login command"
                  onClick={handleCopyLogin}
                  className="flex shrink-0 cursor-pointer rounded-md p-1 transition-colors hover:bg-white/10"
                  style={{ color: 'rgb(201 209 217 / 0.6)' }}
                >
                  {copied ? (
                    <Check size={13} style={{ color: 'var(--mint)' }} />
                  ) : (
                    <Copy size={13} />
                  )}
                </button>
              </div>
            ) : null}
          </Section>

          {/* Vault-key presence — env-var NAME + boolean, never the value */}
          {target.runtimeClass !== 'connected-substrate' && target.envVar ? (
            <Section icon={<KeyRound size={13} />} title="Credential">
              {kv('Env var', target.envVar)}
              {kv('Status', target.hasCredential ? 'present (stored encrypted)' : 'missing')}
            </Section>
          ) : null}

          {/* Recent errors from the obs taxonomy */}
          <Section icon={<AlertCircle size={13} />} title={`Recent errors (${errors.length})`}>
            {errors.length === 0 ? (
              <EmptyState
                icon={ShieldCheck}
                tone="mint"
                title="No recent errors"
                helper="Runtime errors from the observability taxonomy would surface here."
                paddingTop={20}
              />
            ) : (
              errors.map((e, i) => (
                <div
                  key={i}
                  style={{
                    fontSize: 11,
                    padding: '6px 0',
                    borderTop: '1px solid rgb(var(--foreground-rgb) / 0.05)',
                  }}
                >
                  <span style={{ color: 'var(--primary)', fontWeight: 600 }}>
                    {e.errorClass ?? 'Unknown'}
                  </span>{' '}
                  <span style={{ color: muted(0.4) }}>{e.ts ? formatRelative(e.ts) : ''}</span>
                  {e.message ? (
                    <div style={{ color: muted(0.6), marginTop: 2 }}>{e.message}</div>
                  ) : null}
                </div>
              ))
            )}
          </Section>

          {/* Actions */}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 4 }}>
            <Button
              data-testid="runtime-diagnostics-recheck"
              variant="secondary"
              size="sm"
              loading={busy}
              onClick={() => void handleRecheck()}
            >
              {busy ? null : <RotateCcw size={13} strokeWidth={2} />} Re-check
            </Button>
            <Button
              data-testid="runtime-diagnostics-capabilities"
              variant="secondary"
              size="sm"
              onClick={handleViewCapabilities}
            >
              <Boxes size={13} strokeWidth={2} /> View capabilities
            </Button>
            {target.docsUrl ? (
              <a
                href={target.docsUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex h-8 shrink-0 cursor-pointer items-center gap-1.5 rounded-lg border border-border bg-surface px-3 text-[13px] font-medium text-foreground no-underline shadow-[var(--shadow-raised)] transition-[background-color,border-color] hover:border-border-strong hover:bg-foreground/[0.02]"
              >
                <BookOpen size={13} strokeWidth={2} /> Docs <ExternalLink size={11} strokeWidth={2} />
              </a>
            ) : null}
            {canDisconnect ? (
              <Button
                variant="ghost"
                size="sm"
                data-testid="runtime-diagnostics-disconnect"
                onClick={() => void handleDisconnect()}
                className="ml-auto"
              >
                <Plug size={13} strokeWidth={2} /> Disconnect
              </Button>
            ) : null}
          </div>
        </div>
      </motion.div>
    </>,
    document.body,
  )
}

/** Render credential presence WITHOUT the value — the env-var name + a boolean. */
function presence(has: boolean | undefined, envVar: string | null | undefined): string {
  const name = envVar ? ` (${envVar})` : ''
  return has ? `present${name}` : `missing${name}`
}
