// Shared integration-depth chrome — the badge + the id-agnostic runtime glyph —
// so the diagnostics drawer AND the fleet-health tiles tell the same story. The
// depth is always DERIVED from `capabilities.runtimeClass` (never a per-name
// switch); OpenClaw is the synthesized connected-substrate, the native runtime is
// native, the CLI runtimes are wrapped-oneshot.

import { Cpu } from 'lucide-react'

import type { RuntimeClass } from '@/lib/runtimesClient'

import { RuntimeIcon } from './RuntimeBrand'
import type { RuntimeId } from './runtimeCatalog'

const muted = (o: number) => `rgb(var(--foreground-rgb) / ${o})`

export const DEPTH_META: Record<RuntimeClass, { label: string; color: string; bg: string }> = {
  native: { label: 'Native peer', color: 'var(--mint)', bg: 'rgb(var(--mint-rgb) / 0.12)' },
  'connected-substrate': {
    label: 'Connected substrate',
    color: 'var(--amber)',
    bg: 'rgb(var(--amber-rgb) / 0.12)',
  },
  'wrapped-oneshot': {
    label: 'Wrapped one-shot',
    color: muted(0.6),
    bg: 'rgb(var(--foreground-rgb) / 0.06)',
  },
}

export function RuntimeDepthBadge({
  runtimeClass,
  testid,
}: {
  runtimeClass: RuntimeClass
  testid?: string
}) {
  const d = DEPTH_META[runtimeClass]
  return (
    <span
      data-testid={testid}
      style={{
        display: 'inline-block',
        fontSize: 9.5,
        fontWeight: 600,
        fontFamily: 'var(--font-geist-mono, monospace)',
        textTransform: 'uppercase',
        letterSpacing: '0.04em',
        padding: '1px 7px',
        borderRadius: 999,
        color: d.color,
        background: d.bg,
      }}
    >
      {d.label}
    </span>
  )
}

const BRANDED_RUNTIMES = new Set<string>(['clawboo-native', 'claude-code', 'codex', 'hermes'])

/** Runtime icon that falls back to a host tile (Cpu) for OpenClaw / any future
 *  runtime outside the four brand-marked ones — keeps callers RuntimeId-agnostic. */
export function RuntimeGlyph({ id, size }: { id: string; size: number }) {
  if (BRANDED_RUNTIMES.has(id)) return <RuntimeIcon id={id as RuntimeId} size={size} />
  return (
    <span
      aria-hidden
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: size,
        height: size,
        borderRadius: Math.round(size * 0.3),
        color: 'var(--primary)',
        background: 'rgb(var(--primary-rgb) / 0.12)',
        flexShrink: 0,
      }}
    >
      <Cpu size={Math.round(size * 0.58)} />
    </span>
  )
}
