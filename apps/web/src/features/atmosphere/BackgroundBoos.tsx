/**
 * BackgroundBoos — a faint "boo-verse" behind the welcome-screen clouds.
 *
 * A few small, blurred, dark boo SILHOUETTES that slowly drift far away in the
 * sky, BEHIND the cloud layers (so passing clouds occlude them → depth),
 * suggesting there are many other boos out there. Purely decorative.
 *
 * The boo avatar is a single FRONT-facing flat SVG (no profile / 3D pose), so
 * rotating it to "face sideways" just turns a flat plane edge-on → cardboard.
 * Instead we read as 3D creatures by moving them through 3D SPACE rather than
 * rotating the plane:
 *   - lateral drift along a slow elongated ellipse ("goes somewhere"),
 *   - a DEPTH bob — a uniform scale oscillation per orbit, so each boo drifts
 *     nearer (bigger) and farther (smaller) like it's floating in a volume,
 *   - a gentle in-plane bank (small tilt) for life.
 * Every boo keeps its creature form facing us; the 3D feeling comes from the
 * depth travel + varied base distances + parallax, NOT from flipping a card.
 *
 *   - Silhouettes: the shared `BooAvatar` (from `@clawboo/ui`) inside a wrapper
 *     with `filter: brightness(0)` (pure-black outline) + blur + low opacity.
 *     (As a boo scales up in its depth bob, the fixed-px blur reads relatively
 *     sharper → reinforces "nearer".)
 *   - Deterministic: lateral scatter via an R2 low-discrepancy sequence, base
 *     depth via the golden ratio, phases/jitter via FNV-1a (stable across
 *     reloads; never Math.random).
 *   - Reduced motion: when `animate` is false the loop never starts, so each
 *     boo renders static at its start phase (still faint + scattered + sized).
 */
import { memo, useEffect, useMemo } from 'react'
import { motion, useMotionValue, useTransform, animate as runAnimation } from 'framer-motion'
import { BooAvatar } from '@clawboo/ui'

// ── FNV-1a (inline, per repo convention — see features/graph/useFloatingMotion.ts) ──
function fnv1a(str: string): number {
  let hash = 2166136261
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

/** Four normalized [0,1] values from the four bytes of a 32-bit hash. */
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

// Low-discrepancy sequences spread points evenly with no clustering and no
// grid, deterministically by index — used so the boos always scatter across the
// sky (R2, 2D) and span a range of base depths (golden ratio, 1D) regardless of
// hash luck (a pure per-seed hash can cluster them for small N).
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
  ax: number // ellipse radius x (px) — dominant (horizontal drift)
  ay: number // ellipse radius y (px)
  period: number // seconds per loop
  dir: 1 | -1 // orbit direction
  phase: number // start angle (rad)
  zAmp: number // depth-bob amplitude (fraction of size)
  zPhase: number // depth-bob phase offset
  tilt: number // max bank (deg)
}

/** Deterministic per-sprite params. `depth` 0 = nearest, 1 = furthest. */
function deriveSprite(i: number): SpriteParams {
  const [p0, p1, , p3] = bytes(fnv1a(`booverse-${i}`))
  const [w0, w1, w2] = bytes(fnv1a(`booverse-${i}-w`))

  const n = i + 1
  // Even 2D scatter (R2) + tiny per-seed jitter; upper-mid vertical band.
  const r2x = (0.5 + R2_A1 * n) % 1
  const r2y = (0.5 + R2_A2 * n) % 1
  // Spread base depth across the full range so sizes are clearly varied.
  const depth = (0.5 + GOLDEN * n) % 1

  return {
    seed: `booverse-${i}`,
    leftPct: 6 + r2x * 88 + (p0 - 0.5) * 4,
    topPct: 10 + r2y * 38 + (p1 - 0.5) * 3,
    size: Math.round(lerp(60, 26, depth)), // near big → far small (clear depth)
    blur: lerp(2.5, 7, depth), // near sharper → far hazier
    opacity: lerp(0.18, 0.06, depth), // near more present → far fainter
    ax: lerp(180, 80, depth), // near drifts farther (parallax)
    ay: lerp(70, 32, depth), // < ax → mostly-horizontal drift
    period: lerp(30, 66, depth) + w0 * 14, // near faster → far slower
    dir: p3 > 0.5 ? 1 : -1,
    phase: w1 * TAU, // desync start
    zAmp: lerp(0.22, 0.1, depth), // near boos swing more in depth (parallax)
    zPhase: w2 * TAU,
    tilt: lerp(5, 3, depth),
  }
}

const BooSprite = memo(function BooSprite({ p, enabled }: { p: SpriteParams; enabled: boolean }) {
  // `angle` advances over time; everything else derives from it. Starts at the
  // seeded phase (also the static pose).
  const angle = useMotionValue(p.phase)
  const x = useTransform(angle, (a) => p.ax * Math.cos(a))
  const y = useTransform(angle, (a) => p.ay * Math.sin(a))
  // DEPTH bob — uniform scale (nearer/farther), NOT a horizontal squish. This is
  // what makes a flat sprite read as a creature moving in 3D space instead of a
  // card rotating edge-on.
  const scale = useTransform(angle, (a) => 1 + p.zAmp * Math.cos(a + p.zPhase))
  // Gentle in-plane bank toward the vertical motion.
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
        // brightness(0) → pure-black silhouette; blur is STATIC (never animated).
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
  /** Number of faint background boo silhouettes. 0 → renders nothing. */
  count: number
  /** Drift when true; render static when false (reduced motion). */
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
