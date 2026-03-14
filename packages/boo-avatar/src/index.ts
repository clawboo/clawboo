/**
 * Clawboo Procedural Avatar Generator (V3 — OpenClaw-matched)
 *
 * Generates a unique ghost-lobster SVG avatar per agent seed.
 * Uses FNV-1a hash + xorshift32 PRNG for deterministic output.
 *
 * ViewBox: 0 0 100 92 — matches BooNode (60x55) and FleetSidebar (36x33) sizing.
 */

// ─── Types ───────────────────────────────────────────────────────

export type EyeShape = 0 | 1 | 2 | 3 | 4

export type Accessory = 'none' | 'glasses' | 'hat' | 'headphones' | 'crown'

export interface BooAvatarParams {
  seed: string
  tint?: string
  eyeShape?: EyeShape
  accessory?: Accessory
  /** When true, forces OpenClaw Red tint (index 0). Other agents skip index 0. */
  isBooZero?: boolean
}

// ─── Constants ───────────────────────────────────────────────────

const TINTS = [
  '#ff4d4d', // OpenClaw red (default)
  '#34D399', // mint
  '#FBBF24', // amber
  '#60A5FA', // blue
  '#A78BFA', // purple
  '#F472B6', // pink
  '#38BDF8', // sky
  '#FB923C', // orange
  '#A3E635', // lime
  '#FB7185', // rose
] as const

// ─── Hash & PRNG ─────────────────────────────────────────────────

function fnv1a(str: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

function createRng(seed: number): () => number {
  let s = seed || 1
  return () => {
    s ^= s << 13
    s ^= s >> 17
    s ^= s << 5
    return (s >>> 0) / 0xffffffff
  }
}

// ─── Color helpers ───────────────────────────────────────────────

function darkenHex(hex: string, factor: number): string {
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  const dr = Math.round(r * factor)
  const dg = Math.round(g * factor)
  const db = Math.round(b * factor)
  return `#${dr.toString(16).padStart(2, '0')}${dg.toString(16).padStart(2, '0')}${db.toString(16).padStart(2, '0')}`
}

// ─── Eye renderers ───────────────────────────────────────────────

function renderEyes(
  shape: EyeShape,
  lx: number,
  ly: number,
  rx: number,
  ry: number,
  pupilColor: string,
  pupilOffsetX: number,
  pupilOffsetY: number,
): string {
  switch (shape) {
    case 0: // OpenClaw-style: small dark circles with colored pupils
      return (
        `<circle cx="${lx}" cy="${ly}" r="5" fill="#050810"/>` +
        `<circle cx="${lx + 1 + pupilOffsetX * 0.5}" cy="${ly - 1 + pupilOffsetY * 0.5}" r="2" fill="${pupilColor}"/>` +
        `<circle cx="${rx}" cy="${ry}" r="5" fill="#050810"/>` +
        `<circle cx="${rx + 1 + pupilOffsetX * 0.5}" cy="${ry - 1 + pupilOffsetY * 0.5}" r="2" fill="${pupilColor}"/>`
      )
    case 1: // Surprised (round, slightly larger)
      return (
        `<circle cx="${lx}" cy="${ly}" r="6" fill="#050810"/>` +
        `<circle cx="${lx + pupilOffsetX * 0.5}" cy="${ly + pupilOffsetY * 0.5}" r="2.5" fill="${pupilColor}"/>` +
        `<circle cx="${rx}" cy="${ry}" r="6" fill="#050810"/>` +
        `<circle cx="${rx + pupilOffsetX * 0.5}" cy="${ry + pupilOffsetY * 0.5}" r="2.5" fill="${pupilColor}"/>`
      )
    case 2: // Dot (small beady)
      return (
        `<circle cx="${lx}" cy="${ly}" r="3.5" fill="#050810"/>` +
        `<circle cx="${lx + pupilOffsetX * 0.3}" cy="${ly + pupilOffsetY * 0.3}" r="1.2" fill="${pupilColor}"/>` +
        `<circle cx="${rx}" cy="${ry}" r="3.5" fill="#050810"/>` +
        `<circle cx="${rx + pupilOffsetX * 0.3}" cy="${ry + pupilOffsetY * 0.3}" r="1.2" fill="${pupilColor}"/>`
      )
    case 3: // Sleepy arc
      return (
        `<path d="M${lx - 5},${ly + 1} Q${lx},${ly - 6} ${lx + 5},${ly + 1}" fill="none" stroke="#050810" stroke-width="2.5" stroke-linecap="round"/>` +
        `<path d="M${rx - 5},${ry + 1} Q${rx},${ry - 6} ${rx + 5},${ry + 1}" fill="none" stroke="#050810" stroke-width="2.5" stroke-linecap="round"/>`
      )
    case 4: // X (dizzy)
      return (
        `<path d="M${lx - 3.5},${ly - 3.5} L${lx + 3.5},${ly + 3.5} M${lx + 3.5},${ly - 3.5} L${lx - 3.5},${ly + 3.5}" stroke="#050810" stroke-width="2.5" stroke-linecap="round"/>` +
        `<path d="M${rx - 3.5},${ry - 3.5} L${rx + 3.5},${ry + 3.5} M${rx + 3.5},${ry - 3.5} L${rx - 3.5},${ry + 3.5}" stroke="#050810" stroke-width="2.5" stroke-linecap="round"/>`
      )
    default:
      return renderEyes(0, lx, ly, rx, ry, pupilColor, pupilOffsetX, pupilOffsetY)
  }
}

// ─── Accessory renderers ─────────────────────────────────────────

function renderAccessory(acc: Accessory, tint: string): string {
  switch (acc) {
    case 'glasses':
      return (
        `<circle cx="38" cy="36" r="8" fill="none" stroke="rgba(255,255,255,0.3)" stroke-width="1.8"/>` +
        `<circle cx="62" cy="36" r="8" fill="none" stroke="rgba(255,255,255,0.3)" stroke-width="1.8"/>` +
        `<path d="M46,36 L54,36" stroke="rgba(255,255,255,0.3)" stroke-width="1.5"/>`
      )
    case 'hat': {
      const dark = darkenHex(tint, 0.6)
      return (
        `<rect x="30" y="6" width="40" height="8" rx="2" fill="${dark}"/>` +
        `<rect x="38" y="-2" width="24" height="10" rx="3" fill="${dark}"/>`
      )
    }
    case 'headphones':
      return (
        `<path d="M16,30 C16,16 84,16 84,30" fill="none" stroke="rgba(255,255,255,0.25)" stroke-width="3"/>` +
        `<rect x="10" y="26" width="8" height="14" rx="4" fill="rgba(255,255,255,0.2)"/>` +
        `<rect x="82" y="26" width="8" height="14" rx="4" fill="rgba(255,255,255,0.2)"/>`
      )
    case 'crown':
      return (
        `<path d="M40,14 L40,10 L44,5 L47,10 L50,3 L53,10 L56,5 L60,10 L60,14 Z" fill="#FBBF24" fill-opacity="0.75"/>` +
        `<circle cx="44" cy="5" r="1.2" fill="#FDE68A"/>` +
        `<circle cx="50" cy="3" r="1.2" fill="#FDE68A"/>` +
        `<circle cx="56" cy="5" r="1.2" fill="#FDE68A"/>`
      )
    default:
      return ''
  }
}

// ─── Main generator ──────────────────────────────────────────────

export function generateBooAvatar(params: BooAvatarParams): string {
  const { seed } = params
  const h = fnv1a(seed)
  const rng = createRng(h)

  // Unique gradient IDs to prevent SVG collisions
  const uid = (h >>> 0).toString(16).padStart(8, '0')
  const gidBody = `boo-body-${uid}`

  // Resolve tint — Boo Zero always gets OpenClaw Red; others skip index 0
  const tint =
    params.tint ?? (params.isBooZero ? TINTS[0] : TINTS[1 + (Math.abs(h) % (TINTS.length - 1))])
  const tintDark = darkenHex(tint, 0.6)

  // Per-seed variations
  const clawScale = (0.9 + rng() * 0.15).toFixed(2)
  const antennaTipLX = (24 + rng() * 4).toFixed(1)
  const antennaTipRX = (72 + rng() * 4).toFixed(1)
  const antennaTipLY = (9 + rng() * 3).toFixed(1)
  const antennaTipRY = (9 + rng() * 3).toFixed(1)
  const pupilOffsetX = (rng() - 0.5) * 1.2
  const pupilOffsetY = (rng() - 0.5) * 0.8
  const bodyOpacity = (0.96 + rng() * 0.04).toFixed(2)

  // Resolve eye shape
  const eyeShape: EyeShape = params.eyeShape ?? ((Math.abs(h >> 8) % 5) as EyeShape)

  // Resolve accessory
  const accList: Accessory[] = ['none', 'glasses', 'hat', 'headphones', 'crown']
  const accessory: Accessory = params.accessory ?? accList[Math.abs(h >> 16) % accList.length]

  // Pupil color — cyan for OpenClaw red, white for all other tints
  const pupilColor = tint === '#ff4d4d' ? '#00e5cc' : '#ffffff'

  // ── Build SVG ──

  const defs =
    `<defs>` +
    `<linearGradient id="${gidBody}" x1="0%" y1="0%" x2="100%" y2="100%">` +
    `<stop offset="0%" stop-color="${tint}"/>` +
    `<stop offset="100%" stop-color="${tintDark}"/>` +
    `</linearGradient>` +
    `</defs>`

  // Antennae (OpenClaw-style: Q-curves, rendered ON TOP of body)
  const antennae =
    `<path d="M38,17 Q30,8 ${antennaTipLX},${antennaTipLY}" fill="none" stroke="${tint}" stroke-width="2.5" stroke-linecap="round"/>` +
    `<path d="M62,17 Q70,8 ${antennaTipRX},${antennaTipRY}" fill="none" stroke="${tint}" stroke-width="2.5" stroke-linecap="round"/>`

  // Ghost body — 3 bumps (OpenClaw-matched silhouette)
  const bodyPath = `M50,12 C30,12 16,30 16,48 C16,58 18,66 22,72 C24,76 26,78 29,78 C32,78 33,75 35,73.5 C37,72 39,71.5 41,71.5 C43,71.5 45,72 46,73.5 C48,75 50,78 52,78 C55,78 56,75 58,73.5 C60,72 62,71.5 64,71.5 C66,71.5 67,72 68,73.5 C70,75 72,78 75,78 C78,78 80,74 82,66 C84,58 84,48 84,48 C84,30 70,12 50,12 Z`

  const body = `<path d="${bodyPath}" fill="url(#${gidBody})" opacity="${bodyOpacity}"/>`

  // Claws (OpenClaw pincer shape, tucked into body, scaled per seed)
  const cs = parseFloat(clawScale)
  const clawLX = (20 - (1 - cs) * 3).toFixed(1)
  const clawRX = (80 + (1 - cs) * 3).toFixed(1)
  const claws =
    `<path d="M${clawLX},40 C${7 * cs},36 ${3 * cs},43 ${7 * cs},51 C${11 * cs},59 ${clawLX},55 ${Number(clawLX) + 4},47 C${Number(clawLX) + 6},42 ${Number(clawLX) + 4},40 ${clawLX},40Z" fill="url(#${gidBody})"/>` +
    `<path d="M${clawRX},40 C${100 - 7 * cs},36 ${100 - 3 * cs},43 ${100 - 7 * cs},51 C${100 - 11 * cs},59 ${clawRX},55 ${Number(clawRX) - 4},47 C${Number(clawRX) - 6},42 ${Number(clawRX) - 4},40 ${clawRX},40Z" fill="url(#${gidBody})"/>`

  // Eyes (positions: 38,36 and 62,36)
  const eyes = renderEyes(eyeShape, 38, 36, 62, 36, pupilColor, pupilOffsetX, pupilOffsetY)

  // Accessory
  const acc = renderAccessory(accessory, tint)

  // Render order: body → claws → antennae (on top) → eyes → accessory
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 92" width="100" height="92" aria-hidden="true">${defs}${body}${claws}${antennae}${eyes}${acc}</svg>`
}

// ─── Data URL helper ─────────────────────────────────────────────

export function booAvatarToDataUrl(params: BooAvatarParams): string {
  const svg = generateBooAvatar(params)
  return `data:image/svg+xml;base64,${btoa(svg)}`
}
