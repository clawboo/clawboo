/**
 * SkyAtmosphere — the Welcome / Onboarding hero backdrop.
 *
 * A calm Day sky with soft drifting clouds (procedural SVG fractal-noise, three
 * parallax layers). Theme-INDEPENDENT by design: the welcome is always the
 * bright Day sky regardless of the app's light/dark preference (product
 * decision — one consistent, calm entry screen).
 *
 * Locked config (user-approved): mood=day, clouds=0.40, definition=0.70,
 * shading=0, glow=0. Props remain so the other moods (Dawn / Dusk / Night) and
 * 3D cloud shading stay available for future use — `<SkyAtmosphere />` renders
 * the locked look with no props.
 *
 * Zero WebGL — pure CSS/SVG, light on first paint of `npx clawboo`. Respects
 * prefers-reduced-motion (clouds stop drifting).
 */
import { useMemo } from 'react'
import { motion, useReducedMotion } from 'framer-motion'
import { BackgroundBoos } from './BackgroundBoos'

export type SkyMood = 'dawn' | 'day' | 'dusk' | 'night'

type RGB = [number, number, number]

interface MoodSpec {
  gradient: string
  glow: string
  cloudLit: RGB
  cloudShadow: RGB
  bloom: string
  darkSky: boolean
}

const SKY: Record<SkyMood, MoodSpec> = {
  dawn: {
    gradient:
      'linear-gradient(180deg, #c9bce9 0%, #aec3ee 22%, #c4dbf1 46%, #e3edf8 70%, #fcf1e7 100%)',
    glow: 'radial-gradient(ellipse 64% 46% at 50% 94%, rgba(255,238,212,0.9) 0%, rgba(255,238,212,0) 62%)',
    cloudLit: [1, 1, 1],
    cloudShadow: [0.66, 0.66, 0.8],
    bloom:
      'radial-gradient(ellipse 52% 42% at 50% 45%, rgba(255,255,255,0.42) 0%, rgba(255,255,255,0) 64%)',
    darkSky: false,
  },
  day: {
    gradient:
      'linear-gradient(180deg, #2f74c9 0%, #4f92df 22%, #79b1ec 46%, #aed1f3 72%, #e7f2fc 100%)',
    glow: 'radial-gradient(ellipse 52% 40% at 66% 14%, rgba(255,253,245,0.7) 0%, rgba(255,253,245,0) 56%)',
    cloudLit: [1, 1, 1],
    cloudShadow: [0.58, 0.69, 0.85],
    bloom:
      'radial-gradient(ellipse 52% 42% at 50% 45%, rgba(255,255,255,0.46) 0%, rgba(255,255,255,0) 64%)',
    darkSky: false,
  },
  dusk: {
    gradient:
      'linear-gradient(180deg, #5d5fa0 0%, #7b7fbe 22%, #a6a4d2 46%, #d2c2dd 70%, #f3d6c0 100%)',
    glow: 'radial-gradient(ellipse 66% 48% at 40% 92%, rgba(255,206,168,0.82) 0%, rgba(255,206,168,0) 60%)',
    cloudLit: [1, 0.95, 0.9],
    cloudShadow: [0.5, 0.46, 0.62],
    bloom:
      'radial-gradient(ellipse 54% 44% at 50% 45%, rgba(255,255,255,0.36) 0%, rgba(255,255,255,0) 66%)',
    darkSky: false,
  },
  night: {
    gradient:
      'linear-gradient(180deg, #070d1e 0%, #101936 28%, #1b2748 54%, #273459 78%, #34406b 100%)',
    glow: 'radial-gradient(circle 30% 26% at 72% 20%, rgba(208,222,255,0.5) 0%, rgba(208,222,255,0) 56%)',
    cloudLit: [0.78, 0.83, 0.96],
    cloudShadow: [0.1, 0.14, 0.3],
    bloom: 'radial-gradient(ellipse 56% 48% at 50% 46%, rgba(6,11,26,0.5) 0%, rgba(6,11,26,0) 66%)',
    darkSky: true,
  },
}

export function isDarkSky(mood: SkyMood): boolean {
  return SKY[mood].darkSky
}

function cloudUri(
  seed: number,
  freq: number,
  slope: number,
  intercept: number,
  rgb: RGB,
  w: number,
  h: number,
): string {
  const [r, g, b] = rgb
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='${w}' height='${h}'><filter id='c' x='0' y='0' width='100%' height='100%'><feTurbulence type='fractalNoise' baseFrequency='${freq}' numOctaves='5' seed='${seed}' stitchTiles='stitch'/><feColorMatrix type='matrix' values='0 0 0 0 ${r}  0 0 0 0 ${g}  0 0 0 0 ${b}  0 0 0 ${slope} ${intercept}'/></filter><rect width='100%' height='100%' filter='url(#c)'/></svg>`
  return `data:image/svg+xml,${encodeURIComponent(svg)}`
}

const GRAIN = `data:image/svg+xml,${encodeURIComponent(
  `<svg xmlns='http://www.w3.org/2000/svg'><filter id='g'><feTurbulence type='fractalNoise' baseFrequency='0.8' numOctaves='3' stitchTiles='stitch'/><feColorMatrix type='saturate' values='0'/></filter><rect width='100%' height='100%' filter='url(#g)'/></svg>`,
)}`

interface CloudProps {
  lit: string
  shadow: string
  size: string
  travel: number
  duration: number
  blur: number
  opacity: number
  mask: string
  animate: boolean
  shading: number
  dy: number
}

function Cloud({
  lit,
  shadow,
  size,
  travel,
  duration,
  blur,
  opacity,
  mask,
  animate,
  shading,
  dy,
}: CloudProps) {
  const drift = animate ? { backgroundPositionX: ['0px', `${travel}px`] } : undefined
  const driftT = animate ? { duration, repeat: Infinity, ease: 'linear' as const } : undefined
  return (
    <>
      {shading > 0 && (
        <motion.div
          className="absolute inset-0"
          style={{
            backgroundImage: `url("${shadow}")`,
            backgroundSize: size,
            backgroundRepeat: 'repeat',
            backgroundPositionY: `${dy}px`,
            opacity: opacity * (0.5 + 0.45 * shading),
            filter: `blur(${blur + 6}px)`,
            WebkitMaskImage: mask,
            maskImage: mask,
          }}
          animate={drift}
          transition={driftT}
        />
      )}
      <motion.div
        className="absolute inset-0"
        style={{
          backgroundImage: `url("${lit}")`,
          backgroundSize: size,
          backgroundRepeat: 'repeat',
          opacity,
          filter: blur ? `blur(${blur}px)` : undefined,
          WebkitMaskImage: mask,
          maskImage: mask,
        }}
        animate={drift}
        transition={driftT}
      />
    </>
  )
}

export interface SkyAtmosphereProps {
  mood?: SkyMood
  /** 0–1.3 — cloud density/opacity multiplier. */
  clouds?: number
  /** 0–1 — cloud edge definition: 0 = soft/hazy, 1 = crisp/defined puffs. */
  definition?: number
  /** 0–1 — 3D shading: lit-top / shadowed-underside volume. */
  shading?: number
  /** 0–1.3 — sun/moon glow strength. */
  glow?: number
  /** Faint background boo silhouettes drifting behind the clouds. 0 disables. */
  boos?: number
  motionEnabled?: boolean
}

export function SkyAtmosphere({
  mood = 'day',
  clouds = 0.4,
  definition = 0.7,
  shading = 0,
  glow = 0,
  boos = 6,
  motionEnabled = true,
}: SkyAtmosphereProps) {
  const reduce = useReducedMotion()
  const animate = motionEnabled && !reduce
  const sky = SKY[mood]

  const layers = useMemo(() => {
    const slope = 1.4 + definition * 2.6
    const intercept = 0.5 - 0.5 * slope
    const lit = sky.cloudLit
    const sh = sky.cloudShadow
    const mk = (seed: number, freq: number, w: number, h: number) => ({
      lit: cloudUri(seed, freq, slope, intercept, lit, w, h),
      shadow: cloudUri(seed, freq, slope, intercept, sh, w, h),
    })
    return {
      far: mk(2, 0.0085, 1300, 820),
      mid: mk(7, 0.013, 960, 700),
      near: mk(4, 0.02, 700, 560),
    }
  }, [definition, sky.cloudLit, sky.cloudShadow])

  const farBlur = 8 - definition * 4.5
  const midBlur = 4 - definition * 3.2
  const nearBlur = Math.max(0.2, 2 - definition * 1.8)
  const dy = 5 + 12 * shading

  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
      <div className="absolute inset-0" style={{ background: sky.gradient }} />
      <div className="absolute inset-0" style={{ background: sky.glow, opacity: glow }} />

      {/* Faint "boo-verse" — distant boo silhouettes behind the clouds. */}
      <BackgroundBoos count={boos} animate={animate} />

      <Cloud
        lit={layers.far.lit}
        shadow={layers.far.shadow}
        size="1300px 820px"
        travel={-1300}
        duration={190}
        blur={farBlur}
        opacity={0.58 * clouds}
        mask="linear-gradient(180deg, #000 0%, #000 46%, transparent 74%)"
        animate={animate}
        shading={shading}
        dy={dy}
      />
      <Cloud
        lit={layers.mid.lit}
        shadow={layers.mid.shadow}
        size="960px 700px"
        travel={-960}
        duration={140}
        blur={midBlur}
        opacity={0.72 * clouds}
        mask="linear-gradient(180deg, transparent 4%, #000 28%, #000 64%, transparent 86%)"
        animate={animate}
        shading={shading}
        dy={dy}
      />
      <Cloud
        lit={layers.near.lit}
        shadow={layers.near.shadow}
        size="700px 560px"
        travel={-700}
        duration={95}
        blur={nearBlur}
        opacity={0.5 * clouds}
        mask="linear-gradient(180deg, transparent 22%, #000 44%, #000 74%, transparent 94%)"
        animate={animate}
        shading={shading}
        dy={dy}
      />

      <div
        className="absolute inset-0"
        style={{
          backgroundImage: `url("${GRAIN}")`,
          backgroundSize: '200px 200px',
          opacity: 0.07,
          mixBlendMode: 'overlay',
        }}
      />

      <div className="absolute inset-0" style={{ background: sky.bloom }} />
    </div>
  )
}
