// The logo on a connector.
//
// THREE TIERS, because a directory of 400 entries cannot ship 400 logos and
// pretending otherwise produces a grid of broken images.
//
//   1. A real brand mark, for the services people recognise by their logo.
//   2. A category glyph, for a connector that is a capability rather than a
//      brand: a filesystem has no logo, and inventing one would be worse than
//      showing what it does.
//   3. A monogram, for the unchecked long tail, tinted deterministically from
//      the slug so the same server is the same colour every time.
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
  type LucideIcon,
} from 'lucide-react'

import { BRAND_MARKS } from './brandMarks'

/** Connectors that are a capability, not a brand. */
const CATEGORY_GLYPHS: Readonly<Record<string, LucideIcon>> = {
  playwright: MousePointerClick,
  context7: BookOpen,
  filesystem: FolderTree,
  exa: Search,
  memory: Brain,
  'sequential-thinking': ListTree,
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
 * One stylesheet for every brand colour, mounted once by the connectors surface.
 *
 * A VARIABLE PER MARK rather than a style tag per card: the light and dark
 * values differ, the app has three theme states (explicit light, explicit dark,
 * and the unstamped default that follows the OS), and none of that can be
 * expressed in an inline style. Rendered once, read by every mark.
 */
export function ConnectorMarkStyles(): React.ReactElement {
  const light = Object.entries(BRAND_MARKS)
    .map(([slug, m]) => `${cssVarFor(slug)}:${m.hex};`)
    .join('')
  const dark = Object.entries(BRAND_MARKS)
    .map(([slug, m]) => `${cssVarFor(slug)}:${m.darkHex};`)
    .join('')
  // `.dark` ON <html>, which is what ThemeProvider actually sets. The obvious
  // guess is a `prefers-color-scheme` query plus a `data-theme` stamp, and both
  // are wrong here: the app resolves System itself and expresses the answer as
  // one class, so a media query would fight an explicit Light choice on a dark
  // OS and a `data-theme` selector would never match anything at all — every
  // near-black mark would stay near-black on the dark ground.
  return <style>{`:root{${light}}.dark{${dark}}`}</style>
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
  const brand = BRAND_MARKS[slug]
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
        color: `hsl(${hue} 48% 42%)`,
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
