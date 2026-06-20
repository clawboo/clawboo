// Per-runtime diagnostics — a right-slide drawer (clones the board TaskDetailDrawer
// pattern) opened from each runtime card + the OpenClaw row. Shows the integration
// depth (derived from capabilities.runtimeClass, never a per-name switch), a
// client-side health-probe timeline, the depth-correct configuration facts, the
// vault-key PRESENCE (the env-var NAME + true/false — never the value), recent
// errors from the obs taxonomy, and a deep-link into the Capabilities panel
// filtered to this runtime.

import { useEffect, useState, useCallback } from 'react'
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

import { EmptyState } from '@/features/shared/EmptyState'
import { StatusPill, type StatusTone } from '@/features/shared/StatusPill'
import { fetchCapabilities } from '@/lib/capabilitiesClient'
import { formatRelative } from '@/lib/formatRelative'
import { ENTER_SPRING } from '@/lib/motion'
import { disconnectRuntime, type ConnectionState, type RuntimeClass } from '@/lib/runtimesClient'
import { useCapabilityFilterStore } from '@/stores/capabilityFilter'
import { useToastStore } from '@/stores/toast'
import { useViewStore } from '@/stores/view'

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
    <div style={{ marginBottom: 18 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 9 }}>
        <span style={{ color: muted(0.5), display: 'flex' }}>{icon}</span>
        <span
          className="font-mono"
          style={{
            fontSize: 11,
            fontWeight: 600,
            textTransform: 'uppercase',
            letterSpacing: '0.06em',
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
  const navigateTo = useViewStore((s) => s.navigateTo)
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
      !window.confirm(
        `Disconnect ${target.name}? This removes its saved API key from the encrypted vault — you'll need to re-enter it to reconnect.`,
      )
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
    navigateTo('capabilities')
    onClose()
  }

  function handleCopyLogin(): void {
    if (!target.loginCommand) return
    void navigator.clipboard?.writeText(target.loginCommand)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  const canDisconnect = target.connectionState === 'ready' && target.authKind === 'api-key'

  return (
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
          zIndex: 60,
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
          zIndex: 61,
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
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="shrink-0 rounded-md p-1 transition-colors hover:bg-foreground/[0.06]"
            style={{
              border: 'none',
              background: 'transparent',
              color: muted(0.5),
              cursor: 'pointer',
              display: 'flex',
            }}
          >
            <X size={16} />
          </button>
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
                  marginTop: 8,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 8,
                  borderRadius: 8,
                  padding: '7px 10px',
                  background: 'var(--code-block-bg, rgb(var(--foreground-rgb) / 0.05))',
                }}
              >
                <code className="font-data" style={{ fontSize: 12, color: 'var(--foreground)' }}>
                  {target.loginCommand}
                </code>
                <button
                  type="button"
                  aria-label="Copy login command"
                  onClick={handleCopyLogin}
                  style={{
                    border: 'none',
                    background: 'transparent',
                    color: muted(0.5),
                    cursor: 'pointer',
                    display: 'flex',
                  }}
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
            <ActionButton
              testid="runtime-diagnostics-recheck"
              busy={busy}
              onClick={handleRecheck}
              icon={<RotateCcw size={13} />}
            >
              Re-check
            </ActionButton>
            <ActionButton
              testid="runtime-diagnostics-capabilities"
              onClick={handleViewCapabilities}
              icon={<Boxes size={13} />}
            >
              View capabilities
            </ActionButton>
            {target.docsUrl ? (
              <a
                href={target.docsUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg px-3 text-[12px] font-semibold transition-[background] hover:bg-foreground/[0.1]"
                style={{
                  height: 32,
                  background: 'rgb(var(--foreground-rgb) / 0.06)',
                  color: 'var(--foreground)',
                  border: '1px solid rgb(var(--foreground-rgb) / 0.1)',
                  textDecoration: 'none',
                }}
              >
                <BookOpen size={13} /> Docs <ExternalLink size={11} />
              </a>
            ) : null}
            {canDisconnect ? (
              <button
                type="button"
                data-testid="runtime-diagnostics-disconnect"
                onClick={() => void handleDisconnect()}
                className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg px-3 text-[12px] font-semibold transition-[background,border-color]"
                style={{
                  marginLeft: 'auto',
                  height: 32,
                  border: '1px solid rgb(var(--primary-rgb) / 0.25)',
                  background: 'transparent',
                  color: 'var(--primary)',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = 'rgb(var(--primary-rgb) / 0.1)'
                  e.currentTarget.style.borderColor = 'rgb(var(--primary-rgb) / 0.4)'
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = 'transparent'
                  e.currentTarget.style.borderColor = 'rgb(var(--primary-rgb) / 0.25)'
                }}
              >
                <Plug size={13} /> Disconnect
              </button>
            ) : null}
          </div>
        </div>
      </motion.div>
    </>
  )
}

/** Render credential presence WITHOUT the value — the env-var name + a boolean. */
function presence(has: boolean | undefined, envVar: string | null | undefined): string {
  const name = envVar ? ` (${envVar})` : ''
  return has ? `present${name}` : `missing${name}`
}

function ActionButton({
  children,
  onClick,
  icon,
  busy,
  testid,
}: {
  children: React.ReactNode
  onClick: () => void | Promise<void>
  icon?: React.ReactNode
  busy?: boolean
  testid?: string
}) {
  return (
    <button
      type="button"
      data-testid={testid}
      disabled={busy}
      onClick={() => void onClick()}
      className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg px-3 text-[12px] font-semibold transition-[filter,transform,background] hover:bg-foreground/[0.1] active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50"
      style={{
        height: 32,
        background: 'rgb(var(--foreground-rgb) / 0.06)',
        color: 'var(--foreground)',
        border: '1px solid rgb(var(--foreground-rgb) / 0.1)',
      }}
    >
      {icon}
      {children}
    </button>
  )
}
