/**
 * Colour maths shared by the variant tinters.
 *
 * The generated mascot colours itself from ONE hex: its body gradient runs tint to
 * `darkenHex(tint, 0.6)`, a plain per-channel multiply. Applied to a five stop ramp that multiply
 * flattens the variant's own hue drift and the result goes dull, so amber comes out mustard and
 * lime olive. The variants use the OKLCH model below instead, which keeps each locked colour's
 * offset from its anchor: a tint arrives as vivid as the locked file while the variant keeps its
 * shading, and feeding a variant its own anchor reproduces the locked colours exactly.
 */

interface Oklch {
  L: number
  C: number
  H: number
}

const srgbToLinear = (c: number): number => {
  const x = c / 255
  return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4
}

const linearToSrgb = (c: number): number => {
  const x = Math.max(0, Math.min(1, c))
  return x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055
}

const channels = (hex: string): number[] => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))

export function toOklch(hex: string): Oklch {
  const [r, g, b] = channels(hex).map(srgbToLinear) as [number, number, number]
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720453 * s
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s
  return { L, C: Math.hypot(A, B), H: ((Math.atan2(B, A) * 180) / Math.PI + 360) % 360 }
}

function okToLinear({ L, C, H }: Oklch): number[] {
  const a = C * Math.cos((H * Math.PI) / 180)
  const b = C * Math.sin((H * Math.PI) / 180)
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ]
}

const inGamut = (v: number[]): boolean => v.every((x) => x >= -1e-4 && x <= 1 + 1e-4)

/** OKLCH to hex, chroma reduced by bisection until the colour fits sRGB. */
export function fromOklch(o: Oklch): string {
  let c = { ...o }
  if (!inGamut(okToLinear(c))) {
    let lo = 0
    let hi = o.C
    for (let i = 0; i < 30; i++) {
      const mid = (lo + hi) / 2
      if (inGamut(okToLinear({ ...o, C: mid }))) lo = mid
      else hi = mid
    }
    c = { ...o, C: lo }
  }
  return (
    '#' +
    okToLinear(c)
      .map(linearToSrgb)
      .map((x) =>
        Math.round(x * 255)
          .toString(16)
          .padStart(2, '0'),
      )
      .join('')
      .toUpperCase()
  )
}

/**
 * Move `locked` by the same OKLCH offset that takes `anchor` to `tint`, so `anchor` maps onto
 * `tint` exactly and every other colour keeps its distance from it.
 */
export function shift(locked: string, anchor: string, tint: string): string {
  const o = toOklch(locked)
  const a = toOklch(anchor)
  const t = toOklch(tint)
  return fromOklch({
    L: Math.max(0, Math.min(1, t.L + (o.L - a.L))),
    C: a.C === 0 ? t.C : t.C * (o.C / a.C),
    H: (t.H + (o.H - a.H) + 360) % 360,
  })
}

export function luminance(hex: string): number {
  const [r, g, b] = channels(hex).map(srgbToLinear) as [number, number, number]
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** WCAG contrast ratio, rounded to two places the way the design folder reports it. */
export function contrast(a: string, b: string): number {
  const x = luminance(a)
  const y = luminance(b)
  return +((Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)).toFixed(2)
}
