// Rebuild the connector brand marks from simple-icons.
//
// WHY THIS EXISTS. brandMarks.ts carried a "GENERATED from simple-icons" header
// and no generator, so the thirteen paths in it could not be reproduced, checked
// against a newer simple-icons, or extended without hand-copying SVG. That is
// the shape a file rots in.
//
// EXTRACTED, NOT DEPENDED ON. simple-icons unpacks to 16 MB. The app ships only
// the paths it uses, so the dependency stays here at build time and never
// reaches a bundle. The paths are CC0-1.0 and carry no attribution burden; the
// logos remain their owners' trademarks and appear only to identify the service
// a connector talks to.
//
// MATCHING IS DELIBERATELY CONSERVATIVE. A wrong logo is worse than no logo: it
// tells the reader a server is official when it is one developer's weekend
// project. So a mark is attached only when the connector's own name resolves to
// a simple-icons title, and ALIASES below records every case where a human
// decided the two names mean the same thing.

import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import * as simpleIcons from 'simple-icons'

import { COMMUNITY_SNAPSHOT } from '../packages/connector-catalog/src/generated/community'
import { searchConnectors } from '../packages/connector-catalog/src/catalog'

const OUT = path.join(process.cwd(), 'apps/web/src/features/connectors/brandMarks.ts')

interface SimpleIcon {
  title: string
  slug: string
  hex: string
  path: string
}

/**
 * Connector slug to simple-icons slug, where the names do not match on their own.
 *
 * Every line here is a judgement that two names denote the same service. They
 * are listed rather than inferred because a fuzzy matcher that is right 95% of
 * the time puts the wrong logo on one card in twenty, and nobody reviews a
 * generated file closely enough to catch it.
 */
const ALIASES: Readonly<Record<string, string>> = {
  'chrome-devtools': 'googlechrome',
  'sentry-local': 'sentry',
  'stripe-local': 'stripe',
  // clawboo's slug and simple-icons' slug are independent namespaces, and for
  // these the punctuation simply differs. Written out rather than solved with a
  // strip-the-hyphens rule, because such a rule also matches things that are
  // not the same product.
  'google-calendar': 'googlecalendar',
  'google-drive': 'googledrive',
  'google-docs': 'googledocs',
  'google-sheets': 'googlesheets',
  'google-bigquery': 'googlebigquery',
  'google-analytics': 'googleanalytics',
  'whatsapp-business': 'whatsapp',
  'x-twitter': 'x',
}

/**
 * Connectors that must never take a brand mark.
 *
 * A capability is not a brand. `filesystem` and `memory` would otherwise match
 * unrelated companies that happen to own those words, which is exactly the
 * confident-and-wrong failure this file is built to avoid.
 */
const NEVER = new Set([
  'composio',
  'memory',
  'filesystem',
  'exa',
  'sequential-thinking',
  'context7',
  'local-mcp',
])

/** Words an MCP server name carries that are never part of a brand. */
const NOISE =
  /\b(mcp|server|servers|local|remote|official|api|tool|tools|connector|client|for|the)\b/gi

const icons: SimpleIcon[] = Object.values(simpleIcons as Record<string, unknown>).filter(
  (i): i is SimpleIcon =>
    typeof i === 'object' && i !== null && 'slug' in i && 'path' in i && 'title' in i,
)
const bySlug = new Map(icons.map((i) => [i.slug, i]))
const byTitle = new Map(icons.map((i) => [normalise(i.title), i]))

function normalise(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '')
}

/** Every name this connector might be known by, most specific first. */
function candidates(slug: string, displayName: string): string[] {
  const out = new Set<string>()
  out.add(normalise(displayName))
  out.add(normalise(displayName.replace(NOISE, ' ')))
  out.add(normalise(slug))
  out.add(normalise(slug.replace(/-(mcp|server|local)$/g, '')))
  const first = displayName.split(/[\s:\-(]/)[0]
  if (first && first.length > 2) out.add(normalise(first))
  return [...out].filter((c) => c.length > 2)
}

function findIcon(slug: string, displayName: string): SimpleIcon | null {
  if (NEVER.has(slug)) return null
  const alias = ALIASES[slug]
  if (alias) return bySlug.get(alias) ?? null
  for (const c of candidates(slug, displayName)) {
    const hit = bySlug.get(c) ?? byTitle.get(c)
    if (hit) return hit
  }
  return null
}

// ─── Dark-ground colour ──────────────────────────────────────────────────────

/**
 * Hand-tuned dark variants, preserved exactly.
 *
 * These thirteen shipped before this generator existed and were chosen by eye.
 * Recomputing them would change colours nobody asked to change, so the tuning
 * wins and the formula below only ever decides a mark that has no entry here.
 */
const DARK_OVERRIDES: Readonly<Record<string, string>> = {
  '#4285F4': '#6DA1F7',
  '#F24E1E': '#F57C58',
  '#181717': '#C7C7C7',
  '#5E6AD2': '#9AA1E3',
  '#000000': '#C7C7C7',
  '#362D59': '#A89ECE',
  '#003B57': '#00ADFF',
  '#635BFF': '#9D98FF',
}

/** Perceived brightness, 0 to 1, on the sRGB relative-luminance curve. */
function luminance(hex: string): number {
  const c = [1, 3, 5].map((i) => {
    const v = parseInt(hex.slice(i, i + 2), 16) / 255
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!
}

function toHsl(hex: string): [number, number, number] {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as [
    number,
    number,
    number,
  ]
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  if (max === min) return [0, 0, l]
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  const h =
    max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4
  return [h * 60, s, l]
}

function toHex(h: number, s: number, l: number): string {
  const f = (n: number): number => {
    const k = (n + h / 30) % 12
    const a = s * Math.min(l, 1 - l)
    return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))
  }
  const part = (n: number): string =>
    Math.round(f(n) * 255)
      .toString(16)
      .padStart(2, '0')
      .toUpperCase()
  return `#${part(0)}${part(8)}${part(4)}`
}

/**
 * The same hue, lifted until it reads on a dark ground.
 *
 * A brand colour is picked against a white page, so roughly a third of them
 * disappear on a dark one. Lifting lightness in HSL keeps the hue recognisable,
 * which a blanket "use white instead" does not. A colour with no hue to keep
 * (black, near-black) becomes the neutral the overrides already use.
 */
const DARK_FLOOR = 0.18

function darkVariant(hex: string): string {
  const override = DARK_OVERRIDES[hex.toUpperCase()]
  if (override) return override
  if (luminance(hex) >= DARK_FLOOR) return hex.toUpperCase()
  const [h, s, l] = toHsl(hex)
  if (s < 0.08) return '#C7C7C7'
  let lifted = l
  // Step rather than solve: luminance is not linear in lightness, and the loop
  // is over at most fifty iterations for a build-time script.
  while (lifted < 0.95) {
    lifted += 0.02
    const next = toHex(h, s, lifted)
    if (luminance(next) >= DARK_FLOOR) return next
  }
  return '#C7C7C7'
}

// ─── Emit ────────────────────────────────────────────────────────────────────

interface Mark {
  slug: string
  title: string
  hex: string
  darkHex: string
  d: string
}

function collect(): { curated: Mark[]; community: Mark[] } {
  const seen = new Set<string>()
  const build = (entries: readonly { slug: string; displayName: string }[]): Mark[] => {
    const out: Mark[] = []
    for (const e of entries) {
      if (seen.has(e.slug)) continue
      const icon = findIcon(e.slug, e.displayName)
      if (!icon) continue
      seen.add(e.slug)
      const hex = `#${icon.hex.toUpperCase()}`
      out.push({ slug: e.slug, title: icon.title, hex, darkHex: darkVariant(hex), d: icon.path })
    }
    return out.sort((a, b) => a.slug.localeCompare(b.slug))
  }
  return { curated: build(searchConnectors('')), community: build(COMMUNITY_SNAPSHOT) }
}

/**
 * A JS string literal for an arbitrary value.
 *
 * JSON.stringify RATHER THAN a hand-rolled quote escape. The obvious version,
 * `'${v.replace(/'/g, "\\'")}'`, escapes the quote and not the backslash, so a
 * value ending in one closes the literal it was supposed to stay inside. Every
 * value here happens to be quote-free and backslash-free today, which is
 * exactly the condition that makes the bug invisible until simple-icons ships a
 * title with an apostrophe in it.
 */
function literal(value: string): string {
  return JSON.stringify(value)
}

function render(marks: Mark[]): string {
  return marks
    .map((m) => {
      const key = /^[a-z][a-z0-9]*$/.test(m.slug) ? m.slug : literal(m.slug)
      return `  ${key}: {
    title: ${literal(m.title)},
    hex: ${literal(m.hex)},
    darkHex: ${literal(m.darkHex)},
    d: ${literal(m.d)},
  },`
    })
    .join('\n')
}

function main(): void {
  const { curated, community } = collect()
  const version = readSimpleIconsVersion()

  const file = `// GENERATED by scripts/generate-brand-marks.ts. Do not edit by hand.
//
// EXTRACTED RATHER THAN DEPENDED ON. simple-icons unpacks to 16 MB for the
// ${curated.length + community.length} marks used here, and the connectors shelf has to render instantly
// with the network off. The paths are public domain (CC0-1.0), so committing
// them carries no attribution burden; the logos themselves remain their owners'
// trademarks and appear only to identify the service a connector talks to.
//
// TWO COLOURS PER MARK, because a brand colour is chosen against a white page.
// GitHub's #181717 is invisible on a dark ground and Notion's #000000 is worse.
// \`darkHex\` is the same hue lifted until it clears a legibility threshold, so
// each mark stays recognisable on either ground instead of dissolving into it.
//
// TWO GROUPS, because they are read on different screens. The curated marks
// render on the graph canvas and in the picker, so they travel with the app.
// The community marks are only ever read inside the connectors shelf, which is
// already a lazy route, and there are more of them.
//
// Source: simple-icons ${version}

export interface BrandMarkData {
  /** The brand's own name, for alt text. */
  title: string
  /** The brand's official colour. Used as-is on a light ground. */
  hex: string
  /** The same hue, lifted to stay legible on a dark ground. */
  darkHex: string
  /** A single path, always on a 24x24 viewBox. */
  d: string
}

/** Marks for the connectors clawboo vouches for. */
export const BRAND_MARKS: Readonly<Record<string, BrandMarkData>> = Object.freeze({
${render(curated)}
})

/** Marks for registry entries that turned out to name a service people know. */
export const COMMUNITY_BRAND_MARKS: Readonly<Record<string, BrandMarkData>> = Object.freeze({
${render(community)}
})
`
  writeFileSync(OUT, file)
  process.stdout.write(
    `[brand-marks] ${curated.length} curated, ${community.length} community, ` +
      `${Math.round(file.length / 1024)} KB\n`,
  )
}

function readSimpleIconsVersion(): string {
  try {
    const pkg = JSON.parse(
      readFileSync(path.join(process.cwd(), 'node_modules/simple-icons/package.json'), 'utf8'),
    ) as { version?: string }
    return `v${pkg.version ?? '?'}`
  } catch {
    return 'unknown'
  }
}

main()
