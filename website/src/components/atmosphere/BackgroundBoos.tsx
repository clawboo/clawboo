/**
 * VENDORED from apps/web/src/features/atmosphere/BackgroundBoos.tsx.
 * EDITS vs source: the `@clawboo/ui` BooAvatar import is replaced with a local
 * inline BooAvatar that renders the vendored generator as an <img> data-URL
 * (no workspace dep, no dangerouslySetInnerHTML). Motion logic is verbatim.
 *
 * A faint "boo-verse" behind the welcome-screen clouds: small, blurred, dark
 * boo silhouettes drifting through 3D space (lateral ellipse + depth bob +
 * gentle bank). Deterministic (R2 scatter + golden-ratio depth + FNV-1a phase).
 * Reduced motion: the loop never starts; each boo renders static.
 */
import { memo, useEffect, useMemo } from 'react'
import { motion, useMotionValue, useTransform, animate as runAnimation } from 'framer-motion'
import { booAvatarToDataUrl } from '../../lib/boo-avatar'

const ASPECT = 92 / 100

// Inline BooAvatar — renders the vendored generator as a scalable <img> data-URL.
const BooAvatar = memo(function BooAvatar({ seed, size = 40 }: { seed: string; size?: number }) {
  const w = size
  const h = Math.round(size * ASPECT)
  return (
    <img
      src={booAvatarToDataUrl({ seed })}
      width={w}
      height={h}
      alt=""
      aria-hidden="true"
      style={{ display: 'block' }}
    />
  )
})

// ── FNV-1a ──
function fnv1a(str: string): number {
  let hash = 2166136261
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

function bytes(h: number): [number, number, number, number] {
  return [
    (h & 0xff) / 255,
    ((h >>> 8) & 0xff) / 255,
    ((h >>> 16) & 0xff) / 255,
    ((h >>> 24) & 0xff) / 255,
  ]
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t
const TAU = Math.PI * 2

const PHI2 = 1.324717957244746
const R2_A1 = 1 / PHI2
const R2_A2 = 1 / (PHI2 * PHI2)
const GOLDEN = 0.618033988749895

interface SpriteParams {
  seed: string
  leftPct: number
  topPct: number
  size: number
  blur: number
  opacity: number
  ax: number
  ay: number
  period: number
  dir: 1 | -1
  phase: number
  zAmp: number
  zPhase: number
  tilt: number
}

function deriveSprite(i: number): SpriteParams {
  const [p0, p1, , p3] = bytes(fnv1a(`booverse-${i}`))
  const [w0, w1, w2] = bytes(fnv1a(`booverse-${i}-w`))

  const n = i + 1
  const r2x = (0.5 + R2_A1 * n) % 1
  const r2y = (0.5 + R2_A2 * n) % 1
  const depth = (0.5 + GOLDEN * n) % 1

  return {
    seed: `booverse-${i}`,
    leftPct: 6 + r2x * 88 + (p0 - 0.5) * 4,
    topPct: 10 + r2y * 38 + (p1 - 0.5) * 3,
    size: Math.round(lerp(60, 26, depth)),
    blur: lerp(2.5, 7, depth),
    opacity: lerp(0.18, 0.06, depth),
    ax: lerp(180, 80, depth),
    ay: lerp(70, 32, depth),
    period: lerp(30, 66, depth) + w0 * 14,
    dir: p3 > 0.5 ? 1 : -1,
    phase: w1 * TAU,
    zAmp: lerp(0.22, 0.1, depth),
    zPhase: w2 * TAU,
    tilt: lerp(5, 3, depth),
  }
}

const BooSprite = memo(function BooSprite({ p, enabled }: { p: SpriteParams; enabled: boolean }) {
  const angle = useMotionValue(p.phase)
  const x = useTransform(angle, (a) => p.ax * Math.cos(a))
  const y = useTransform(angle, (a) => p.ay * Math.sin(a))
  const scale = useTransform(angle, (a) => 1 + p.zAmp * Math.cos(a + p.zPhase))
  const rotate = useTransform(angle, (a) => Math.cos(a) * p.dir * p.tilt)

  useEffect(() => {
    if (!enabled) return
    const controls = runAnimation(angle, p.phase + p.dir * TAU, {
      duration: p.period,
      ease: 'linear',
      repeat: Infinity,
    })
    return () => controls.stop()
  }, [enabled, angle, p.phase, p.dir, p.period])

  return (
    <div
      className="absolute"
      style={{
        left: `${p.leftPct}%`,
        top: `${p.topPct}%`,
        opacity: p.opacity,
        filter: `brightness(0) blur(${p.blur}px)`,
      }}
    >
      <motion.div style={{ x, y, scale, rotate, willChange: 'transform' }}>
        <BooAvatar seed={p.seed} size={p.size} />
      </motion.div>
    </div>
  )
})

export interface BackgroundBoosProps {
  count: number
  animate: boolean
}

export const BackgroundBoos = memo(function BackgroundBoos({
  count,
  animate,
}: BackgroundBoosProps) {
  const sprites = useMemo(
    () => Array.from({ length: Math.max(0, count) }, (_, i) => deriveSprite(i)),
    [count],
  )
  if (count <= 0) return null
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden">
      {sprites.map((p) => (
        <BooSprite key={p.seed} p={p} enabled={animate} />
      ))}
    </div>
  )
})
