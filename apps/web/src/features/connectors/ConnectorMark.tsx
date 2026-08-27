// The logo on a connector.
//
// THREE TIERS, because a directory of 419 entries cannot ship 419 logos and
// pretending otherwise produces a grid of broken images. Most registry servers
// are one developer's project and have no logo to show; that is a fact about
// the registry, not a gap to paper over.
//
//   1. A real brand mark, for the services people recognise by their logo.
//      Generated from simple-icons by scripts/generate-brand-marks.ts, and
//      matched conservatively: a wrong logo says a server is official when it
//      is not, which is worse than showing no logo at all.
//   2. A category glyph, for a connector that is a capability rather than a
//      brand: a filesystem has no logo, and inventing one would be worse than
//      showing what it does.
//   3. A monogram, for the rest, tinted deterministically from the slug so the
//      same server is the same colour every time.
//
// NOTHING IS FETCHED. The obvious shortcut is a favicon service keyed on the
// vendor's domain, which is one third-party request per card and leaks the
// catalogue the operator is browsing. Local-first means the shelf renders with
// the network off.

import { memo } from 'react'
import {
  Boxes,
  BookOpen,
  Brain,
  FolderTree,
  ListTree,
  MousePointerClick,
  Search,
  Waypoints,
  type LucideIcon,
} from 'lucide-react'

import { BRAND_MARKS, COMMUNITY_BRAND_MARKS, type BrandMarkData } from './brandMarks'

/**
 * Every mark, curated first.
 *
 * ONE LOOKUP so a slug resolves the same way wherever it is drawn. The two maps
 * stay separate in the generated file because they are regenerated from
 * different catalogues, not because the renderer cares which one won.
 */
function markFor(slug: string): BrandMarkData | undefined {
  return BRAND_MARKS[slug] ?? COMMUNITY_BRAND_MARKS[slug]
}

/**
 * Whether this connector draws a real logo rather than a glyph or a monogram.
 *
 * Exported because ordering a list by it is the closest thing to a popularity
 * signal the registry offers: it publishes no downloads, no stars, nothing. A
 * mark exists only where the server's name resolved to a known brand, so "has a
 * mark" reads as "names something you have heard of".
 */
export function hasBrandMark(slug: string): boolean {
  return markFor(slug) !== undefined
}

const ALL_MARKS: readonly (readonly [string, BrandMarkData])[] = [
  ...Object.entries(BRAND_MARKS),
  ...Object.entries(COMMUNITY_BRAND_MARKS),
]

/** Connectors that are a capability, not a brand. */
const CATEGORY_GLYPHS: Readonly<Record<string, LucideIcon>> = {
  playwright: MousePointerClick,
  context7: BookOpen,
  filesystem: FolderTree,
  exa: Search,
  memory: Brain,
  'sequential-thinking': ListTree,
  // A broker has no logo of its own worth borrowing, and simple-icons carries
  // none. Routing through a hub is what it does, so that is what it draws.
  composio: Waypoints,
}

/** A stable hue per slug, so an unchecked server keeps its colour between visits. */
function hueFor(slug: string): number {
  let h = 0
  for (let i = 0; i < slug.length; i += 1) h = (h * 31 + slug.charCodeAt(i)) % 360
  return h
}

function initials(name: string): string {
  const words = name
    .replace(/[^\p{L}\p{N} ]/gu, ' ')
    .trim()
    .split(/\s+/)
  if (words.length === 0 || !words[0]) return '?'
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase()
  return (words[0][0]! + words[1]![0]!).toUpperCase()
}

/** The custom property holding this slug's theme-correct brand colour. */
function cssVarFor(slug: string): string {
  return `--cm-${slug.replace(/[^a-z0-9]/g, '-')}`
}

/**
 * One stylesheet for every brand colour.
 *
 * A VARIABLE PER MARK rather than a style tag per card: the light and dark
 * values differ, the app has three theme states (explicit light, explicit dark,
 * and the unstamped default that follows the OS), and none of that can be
 * expressed in an inline style.
 *
 * MOUNTED BY EVERY SURFACE THAT DRAWS A MARK, not once globally. It used to
 * hang off the connectors panel alone, which is a lazy route, so every mark on
 * the graph canvas resolved `fill` to an undefined variable and drew black on a
 * transparent tile. Two copies are harmless: the declarations are identical, so
 * whichever wins the cascade sets the same value.
 */
export function ConnectorMarkStyles(): React.ReactElement {
  const light = ALL_MARKS.map(([slug, m]) => `${cssVarFor(slug)}:${m.hex};`).join('')
  const dark = ALL_MARKS.map(([slug, m]) => `${cssVarFor(slug)}:${m.darkHex};`).join('')
  // `.dark` ON <html>, which is what ThemeProvider actually sets. The obvious
  // guess is a `prefers-color-scheme` query plus a `data-theme` stamp, and both
  // are wrong here: the app resolves System itself and expresses the answer as
  // one class, so a media query would fight an explicit Light choice on a dark
  // OS and a `data-theme` selector would never match anything at all, leaving
  // every near-black mark near-black on the dark ground.
  //
  // The monogram's lightness rides along, because tier 3 has the same problem
  // tier 1 does: a 42% lightness letterform is legible on paper and nearly
  // invisible on the dark ground, and an inline style cannot branch on the
  // theme any more than a brand colour can.
  return <style>{`:root{${light}--cm-mono-l:42%;}.dark{${dark}--cm-mono-l:74%;}`}</style>
}

export interface ConnectorMarkProps {
  slug: string
  displayName: string
  /** Tile edge in px. 28 in rows, 40 in the detail header. */
  size?: number
  className?: string
}

export const ConnectorMark = memo(function ConnectorMark({
  slug,
  displayName,
  size = 28,
  className = '',
}: ConnectorMarkProps) {
  const brand = markFor(slug)
  const Glyph = CATEGORY_GLYPHS[slug]
  const tile = `flex shrink-0 items-center justify-center overflow-hidden rounded-[9px] ${className}`
  const box = { width: size, height: size }

  if (brand) {
    const v = `var(${cssVarFor(slug)})`
    return (
      <span
        className={tile}
        style={{ ...box, background: `color-mix(in srgb, ${v} 13%, transparent)` }}
      >
        <svg
          viewBox="0 0 24 24"
          width={Math.round(size * 0.58)}
          height={Math.round(size * 0.58)}
          fill={v}
          role="img"
          aria-label={`${brand.title} logo`}
        >
          <path d={brand.d} />
        </svg>
      </span>
    )
  }

  if (Glyph) {
    return (
      <span className={`${tile} bg-foreground/[0.055] text-foreground/55`} style={box} aria-hidden>
        <Glyph size={Math.round(size * 0.54)} strokeWidth={1.9} />
      </span>
    )
  }

  const hue = hueFor(slug)
  return (
    <span
      className={`${tile} font-semibold`}
      style={{
        ...box,
        fontSize: Math.round(size * 0.36),
        background: `hsl(${hue} 62% 52% / 0.14)`,
        color: `hsl(${hue} 48% var(--cm-mono-l, 42%))`,
      }}
      aria-hidden
    >
      {initials(displayName)}
    </span>
  )
})

/** A neutral stand-in for a connector with no identity yet (an add-your-own row). */
export const GenericMark = memo(function GenericMark({ size = 28 }: { size?: number }) {
  return (
    <span
      className="flex shrink-0 items-center justify-center rounded-[9px] bg-foreground/[0.055] text-foreground/45"
      style={{ width: size, height: size }}
      aria-hidden
    >
      <Boxes size={Math.round(size * 0.54)} strokeWidth={1.9} />
    </span>
  )
})
