/**
 * BooSquad — the foreground "team photo" of live colored Boos on the hero sky.
 * Built on the vendored generator (../../lib/boo-avatar): a reserved-red Boo
 * Zero leads at center-front, with six teammates fanned out by tint. Each Boo
 * idles with a gentle float and an occasional blink. Reduced motion: static.
 *
 * Rendered as <img> data-URLs (crisp at any scale, no innerHTML). Responsive
 * scaling is supplied by the host section via the `.clawboo-boo-squad` class.
 */
import { memo, useEffect, useState } from 'react'
import { motion, useReducedMotion } from 'framer-motion'
import { booAvatarToDataUrl, TINTS, type EyeShape } from '../../lib/boo-avatar'

const ASPECT = 92 / 100

interface Member {
  seed: string
  tint?: string
  isBooZero?: boolean
  size: number
  lift: number // raises smaller Boos so the squad reads as a curved row
  z: number
  dur: number
  delay: number
}

// Symmetric squad: leader (Boo Zero) center-front, teammates stepping outward.
const ROSTER: Member[] = [
  { seed: 'squad-sky', tint: TINTS[6], size: 68, lift: 34, z: 1, dur: 5.4, delay: 0.0 },
  { seed: 'squad-mint', tint: TINTS[1], size: 84, lift: 18, z: 2, dur: 6.2, delay: 0.6 },
  { seed: 'squad-amber', tint: TINTS[2], size: 98, lift: 6, z: 3, dur: 5.0, delay: 0.3 },
  { seed: 'boo-zero', isBooZero: true, size: 130, lift: 0, z: 5, dur: 6.8, delay: 0.15 },
  { seed: 'squad-blue', tint: TINTS[3], size: 98, lift: 6, z: 3, dur: 5.6, delay: 0.45 },
  { seed: 'squad-purple', tint: TINTS[4], size: 84, lift: 18, z: 2, dur: 6.0, delay: 0.9 },
  { seed: 'squad-pink', tint: TINTS[5], size: 68, lift: 34, z: 1, dur: 5.2, delay: 0.75 },
]

const BooMember = memo(function BooMember({ m, animate }: { m: Member; animate: boolean }) {
  const [blink, setBlink] = useState(false)

  useEffect(() => {
    if (!animate) return
    let timer: ReturnType<typeof setTimeout>
    let closeTimer: ReturnType<typeof setTimeout>
    const loop = () => {
      const wait = 2800 + Math.random() * 4600
      timer = setTimeout(() => {
        setBlink(true)
        closeTimer = setTimeout(() => {
          setBlink(false)
          loop()
        }, 150)
      }, wait)
    }
    loop()
    return () => {
      clearTimeout(timer)
      clearTimeout(closeTimer)
    }
  }, [animate])

  const w = m.size
  const h = Math.round(m.size * ASPECT)
  const eyeShape: EyeShape = blink ? 3 : 0
  const url = booAvatarToDataUrl({
    seed: m.seed,
    tint: m.tint,
    isBooZero: m.isBooZero,
    eyeShape,
  })

  return (
    <motion.div
      style={{ zIndex: m.z, marginInline: -10 }}
      animate={animate ? { y: [0, -9, 0] } : undefined}
      transition={
        animate
          ? { duration: m.dur, repeat: Infinity, ease: 'easeInOut', delay: m.delay }
          : undefined
      }
    >
      <img
        src={url}
        width={w}
        height={h}
        alt=""
        aria-hidden="true"
        style={{
          display: 'block',
          marginBottom: m.lift,
          filter: 'drop-shadow(0 12px 24px rgba(18, 28, 56, 0.3))',
        }}
      />
    </motion.div>
  )
})

export function BooSquad() {
  const reduce = useReducedMotion()
  const animate = !reduce
  return (
    <div
      className="clawboo-boo-squad pointer-events-none flex items-end justify-center"
      aria-hidden="true"
    >
      {ROSTER.map((m) => (
        <BooMember key={m.seed} m={m} animate={animate} />
      ))}
    </div>
  )
}
