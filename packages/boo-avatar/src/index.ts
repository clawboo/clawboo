// Procedural SVG avatar generator for Clawboo's Boo characters.
// viewBox: 0 0 100 92
// Every Boo has:
//   - Ghost body: rounded blob dome + 3 soft wavy bottom bumps, solid color fill
//   - Antennae: two curved organic lines (no ball tips)
//   - Arms: round bumps on each side of the body
//   - Eyes: 5 variants (0=classic, 1=surprised, 2=dot, 3=sleepy, 4=x) with mint pupils
//   - Accessory: none | glasses | hat | bowtie | headphones | crown
// All variation is deterministic from the seed hash.

export type EyeShape = 0 | 1 | 2 | 3 | 4

export type Accessory = 'none' | 'glasses' | 'hat' | 'bowtie' | 'headphones' | 'crown'

export interface BooAvatarParams {
  /** Deterministic seed — typically the agent name or id */
  seed: string
  /** Body tint color (hex). Derived from seed hash if omitted. */
  tint?: string
  /** Eye variant 0–4 */
  eyeShape?: EyeShape
  /** Accessory decoration */
  accessory?: Accessory
}

// ─── Hashing + PRNG ──────────────────────────────────────────────────────────

/** FNV-1a 32-bit hash */
function fnv1a(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
    h >>>= 0
  }
  return h >>> 0
}

/** Xorshift32 PRNG seeded from hash */
function seededRng(seed: number): () => number {
  let s = seed >>> 0 || 1 // must be non-zero
  return function next(): number {
    s ^= s << 13
    s ^= s >>> 17
    s ^= s << 5
    s = s >>> 0
    return s / 4294967296
  }
}

// ─── Color palette ────────────────────────────────────────────────────────────

const TINTS = [
  '#E94560', // accent red
  '#34D399', // mint green
  '#FBBF24', // amber
  '#60A5FA', // blue
  '#A78BFA', // purple
  '#F472B6', // pink
  '#38BDF8', // sky
  '#FB923C', // orange
  '#4ADE80', // lime
  '#F87171', // rose
] as const

function deriveColor(h: number): string {
  return TINTS[Math.abs(h) % TINTS.length]!
}

// ─── Ghost body path ──────────────────────────────────────────────────────────
// Rounded blob dome with curved sides and 3 soft bottom bumps.
// Body occupies roughly x=[12..88], y=[16..80] within the 100×92 viewBox.

const GHOST_BODY = [
  'M50,16',
  'C30,16 12,28 12,46',
  'C12,56 14,64 20,72',
  'C26,80 34,72 42,70',
  'C46,80 54,80 58,70',
  'C64,72 74,80 80,72',
  'C86,64 88,56 88,46',
  'C88,28 70,16 50,16',
  'Z',
].join(' ')

// ─── Eyes ─────────────────────────────────────────────────────────────────────

function renderEyes(shape: EyeShape, _tint: string): string {
  const lx = 38,
    ly = 42,
    rx = 62,
    ry = 42

  switch (shape) {
    case 0: // Classic oval eyes with dark sclera + cyan/mint pupil + highlight
      return (
        `<ellipse cx="${lx}" cy="${ly}" rx="8" ry="9.5" fill="rgba(10,14,26,0.92)"/>` +
        `<circle cx="${lx}" cy="${ly + 0.5}" r="3.2" fill="#34D399"/>` +
        `<circle cx="${lx - 1.5}" cy="${ly - 2.5}" r="1.3" fill="rgba(255,255,255,0.55)"/>` +
        `<ellipse cx="${rx}" cy="${ry}" rx="8" ry="9.5" fill="rgba(10,14,26,0.92)"/>` +
        `<circle cx="${rx}" cy="${ry + 0.5}" r="3.2" fill="#34D399"/>` +
        `<circle cx="${rx - 1.5}" cy="${ry - 2.5}" r="1.3" fill="rgba(255,255,255,0.55)"/>`
      )

    case 1: // Wide surprised eyes — bigger sclera, larger pupils
      return (
        `<ellipse cx="${lx}" cy="${ly}" rx="9.5" ry="10.5" fill="rgba(10,14,26,0.92)"/>` +
        `<circle cx="${lx}" cy="${ly}" r="4.2" fill="#34D399"/>` +
        `<circle cx="${lx - 2}" cy="${ly - 2.5}" r="1.8" fill="rgba(255,255,255,0.6)"/>` +
        `<ellipse cx="${rx}" cy="${ry}" rx="9.5" ry="10.5" fill="rgba(10,14,26,0.92)"/>` +
        `<circle cx="${rx}" cy="${ry}" r="4.2" fill="#34D399"/>` +
        `<circle cx="${rx - 2}" cy="${ry - 2.5}" r="1.8" fill="rgba(255,255,255,0.6)"/>`
      )

    case 2: // Minimal round dot eyes
      return (
        `<circle cx="${lx}" cy="${ly}" r="6" fill="rgba(10,14,26,0.92)"/>` +
        `<circle cx="${lx + 0.5}" cy="${ly + 0.5}" r="2.5" fill="#34D399"/>` +
        `<circle cx="${rx}" cy="${ry}" r="6" fill="rgba(10,14,26,0.92)"/>` +
        `<circle cx="${rx + 0.5}" cy="${ry + 0.5}" r="2.5" fill="#34D399"/>`
      )

    case 3: // Sleepy half-arc eyes (curved stroke + faint mint accent below)
      return (
        `<path d="M${lx - 8},${ly + 1} Q${lx},${ly - 6} ${lx + 8},${ly + 1}" fill="rgba(10,14,26,0.25)" stroke="rgba(10,14,26,0.85)" stroke-width="2.5" stroke-linecap="round"/>` +
        `<circle cx="${lx}" cy="${ly + 3}" r="1.5" fill="#34D399" fill-opacity="0.5"/>` +
        `<path d="M${rx - 8},${ry + 1} Q${rx},${ry - 6} ${rx + 8},${ry + 1}" fill="rgba(10,14,26,0.25)" stroke="rgba(10,14,26,0.85)" stroke-width="2.5" stroke-linecap="round"/>` +
        `<circle cx="${rx}" cy="${ry + 3}" r="1.5" fill="#34D399" fill-opacity="0.5"/>`
      )

    case 4: // X eyes (dizzy) — dark ovals with mint X marks
      return (
        `<ellipse cx="${lx}" cy="${ly}" rx="8" ry="9" fill="rgba(10,14,26,0.88)"/>` +
        `<line x1="${lx - 4}" y1="${ly - 4.5}" x2="${lx + 4}" y2="${ly + 4.5}" stroke="#34D399" stroke-width="2.5" stroke-linecap="round" stroke-opacity="0.85"/>` +
        `<line x1="${lx + 4}" y1="${ly - 4.5}" x2="${lx - 4}" y2="${ly + 4.5}" stroke="#34D399" stroke-width="2.5" stroke-linecap="round" stroke-opacity="0.85"/>` +
        `<ellipse cx="${rx}" cy="${ry}" rx="8" ry="9" fill="rgba(10,14,26,0.88)"/>` +
        `<line x1="${rx - 4}" y1="${ry - 4.5}" x2="${rx + 4}" y2="${ry + 4.5}" stroke="#34D399" stroke-width="2.5" stroke-linecap="round" stroke-opacity="0.85"/>` +
        `<line x1="${rx + 4}" y1="${ry - 4.5}" x2="${rx - 4}" y2="${ry + 4.5}" stroke="#34D399" stroke-width="2.5" stroke-linecap="round" stroke-opacity="0.85"/>`
      )

    default:
      return renderEyes(0, _tint)
  }
}

// ─── Accessories ──────────────────────────────────────────────────────────────

function renderAccessory(kind: Accessory, tint: string): string {
  switch (kind) {
    case 'none':
      return ''

    case 'glasses':
      return (
        // Left lens
        `<rect x="26" y="36" width="18" height="14" rx="5" fill="none" stroke="${tint}" stroke-width="1.8" stroke-opacity="0.85"/>` +
        // Right lens
        `<rect x="56" y="36" width="18" height="14" rx="5" fill="none" stroke="${tint}" stroke-width="1.8" stroke-opacity="0.85"/>` +
        // Bridge
        `<line x1="44" y1="43" x2="56" y2="43" stroke="${tint}" stroke-width="1.8" stroke-opacity="0.85"/>` +
        // Left arm
        `<line x1="26" y1="42" x2="18" y2="39" stroke="${tint}" stroke-width="1.8" stroke-linecap="round" stroke-opacity="0.85"/>` +
        // Right arm
        `<line x1="74" y1="42" x2="82" y2="39" stroke="${tint}" stroke-width="1.8" stroke-linecap="round" stroke-opacity="0.85"/>`
      )

    case 'hat':
      return (
        // Wide brim rests on ghost head top
        `<rect x="18" y="13" width="64" height="6" rx="2" fill="${tint}" fill-opacity="0.9"/>` +
        // Tall crown
        `<rect x="33" y="1" width="34" height="14" rx="3" fill="${tint}" fill-opacity="0.85"/>` +
        // Hat band
        `<rect x="33" y="10" width="34" height="4" rx="0" fill="rgba(255,255,255,0.18)"/>`
      )

    case 'bowtie':
      return (
        // Left wing
        `<polygon points="39,60 50,65 39,70" fill="${tint}" fill-opacity="0.85"/>` +
        // Right wing
        `<polygon points="61,60 50,65 61,70" fill="${tint}" fill-opacity="0.85"/>` +
        // Center knot
        `<circle cx="50" cy="65" r="3.5" fill="${tint}" fill-opacity="0.95"/>`
      )

    case 'headphones':
      return (
        // Arc over head
        `<path d="M20,42 C20,22 80,22 80,42" fill="none" stroke="${tint}" stroke-width="3" stroke-linecap="round" stroke-opacity="0.85"/>` +
        // Left ear cup
        `<rect x="14" y="40" width="12" height="16" rx="5" fill="${tint}" fill-opacity="0.85"/>` +
        // Right ear cup
        `<rect x="74" y="40" width="12" height="16" rx="5" fill="${tint}" fill-opacity="0.85"/>` +
        // Left cup highlight
        `<ellipse cx="20" cy="48" rx="3.5" ry="4" fill="rgba(255,255,255,0.22)"/>` +
        // Right cup highlight
        `<ellipse cx="80" cy="48" rx="3.5" ry="4" fill="rgba(255,255,255,0.22)"/>`
      )

    case 'crown':
      return (
        // Crown body with 3 points
        `<path d="M26,19 L26,9 L38,16 L50,5 L62,16 L74,9 L74,19 Z" fill="${tint}" fill-opacity="0.9"/>` +
        // Gem at left point
        `<circle cx="26" cy="9" r="2.5" fill="rgba(255,255,255,0.85)"/>` +
        // Gem at center point
        `<circle cx="50" cy="5" r="2.5" fill="rgba(255,255,255,0.85)"/>` +
        // Gem at right point
        `<circle cx="74" cy="9" r="2.5" fill="rgba(255,255,255,0.85)"/>` +
        // Crown band
        `<rect x="26" y="17" width="48" height="3" fill="${tint}" fill-opacity="0.7"/>`
      )

    default:
      return ''
  }
}

// ─── Main generator ───────────────────────────────────────────────────────────

/**
 * Generate a Boo avatar SVG string.
 * @returns Raw SVG markup, suitable for innerHTML or data: URL.
 */
export function generateBooAvatar(params: BooAvatarParams): string {
  const { seed } = params
  const h = fnv1a(seed)
  const rng = seededRng(h)

  const tint = params.tint ?? deriveColor(h)
  const eyeShape: EyeShape = params.eyeShape ?? ((Math.abs(h) % 5) as EyeShape)
  const acc: Accessory = params.accessory ?? 'none'

  // Per-seed variation — makes each Boo subtly unique
  const armR = (4.5 + rng() * 1.5).toFixed(1)
  const antTipXL = (rng() * 4 - 2).toFixed(1)
  const antTipYL = (rng() * 3 - 1.5).toFixed(1)
  const antTipXR = (rng() * 4 - 2).toFixed(1)
  const antTipYR = (rng() * 3 - 1.5).toFixed(1)
  const highlightOpacity = (0.1 + rng() * 0.06).toFixed(3)

  // Unique gradient ID — prevents conflicts when multiple Boos are inlined in the same document
  const gid = `boo-${(h >>> 0).toString(16).padStart(8, '0')}`

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 92" width="100" height="92" aria-hidden="true">
  <defs>
    <radialGradient id="${gid}" cx="38%" cy="28%" r="65%">
      <stop offset="0%" stop-color="#ffffff" stop-opacity="${highlightOpacity}"/>
      <stop offset="100%" stop-color="#ffffff" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <!-- Antennae (behind body) -->
  <path d="M38,20 C36,12 ${30 + Number(antTipXL)},${5 + Number(antTipYL)} ${24 + Number(antTipXL)},3" fill="none" stroke="${tint}" stroke-width="1.8" stroke-linecap="round" stroke-opacity="0.6"/>
  <path d="M62,20 C64,12 ${70 + Number(antTipXR)},${5 + Number(antTipYR)} ${76 + Number(antTipXR)},3" fill="none" stroke="${tint}" stroke-width="1.8" stroke-linecap="round" stroke-opacity="0.6"/>
  <!-- Arm bumps (behind body) -->
  <circle cx="10" cy="48" r="${armR}" fill="${tint}" fill-opacity="0.75"/>
  <circle cx="90" cy="48" r="${armR}" fill="${tint}" fill-opacity="0.75"/>
  <!-- Ghost body (solid fill) -->
  <path d="${GHOST_BODY}" fill="${tint}" stroke="none"/>
  <!-- Depth: highlight overlay -->
  <path d="${GHOST_BODY}" fill="url(#${gid})" stroke="none"/>
  <!-- Depth: body shine -->
  <ellipse cx="36" cy="28" rx="10" ry="7" fill="rgba(255,255,255,0.07)" transform="rotate(-15,36,28)"/>
  <!-- Depth: bottom shadow -->
  <ellipse cx="50" cy="76" rx="18" ry="3.5" fill="rgba(0,0,0,0.06)"/>
  <!-- Eyes -->
  ${renderEyes(eyeShape, tint)}
  <!-- Accessory -->
  ${renderAccessory(acc, tint)}</svg>`
}

/**
 * Convert a string to a data: URL for use in <img> src.
 */
export function booAvatarToDataUrl(svg: string): string {
  const encoded = encodeURIComponent(svg)
  return `data:image/svg+xml,${encoded}`
}
