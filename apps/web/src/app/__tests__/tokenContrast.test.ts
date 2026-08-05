// WCAG contrast guard for the design tokens in `../globals.css`.
//
// Why a token test and not an axe sweep: the jsdom vitest project loads no CSS
// (globals.css is never imported into tests) and jsdom has no layout, so
// axe-core's `color-contrast` rule can only ever return `incomplete` — and
// jest-axe's `toHaveNoViolations` ignores `incomplete` entirely. (jest-axe also
// disables every `cat.color` rule at import time for exactly this reason.) An
// axe-based contrast check in this harness is structurally incapable of failing.
// Parsing the token blocks and doing the WCAG math is the only guard with teeth.
//
// The test reads `:root` (light) and `.dark` (dark) straight out of globals.css,
// so it cannot drift from the shipped values.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const CSS = readFileSync(fileURLToPath(new URL('../globals.css', import.meta.url)), 'utf8')

// ── parsing ──────────────────────────────────────────────────────────────────

/** Extract the body of a top-level rule by its line-anchored selector. */
function ruleBody(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const opener = CSS.match(new RegExp(`^${escaped}\\s*\\{`, 'm'))
  if (!opener || opener.index === undefined) {
    throw new Error(`globals.css: no top-level \`${selector}\` block`)
  }
  const open = CSS.indexOf('{', opener.index)
  let depth = 0
  for (let i = open; i < CSS.length; i += 1) {
    if (CSS[i] === '{') depth += 1
    else if (CSS[i] === '}') {
      depth -= 1
      if (depth === 0) return CSS.slice(open + 1, i)
    }
  }
  throw new Error(`globals.css: unbalanced braces in \`${selector}\``)
}

/**
 * Strip `/* … *\/` comments before scanning for declarations.
 *
 * Load-bearing, not tidiness. The declaration regex below is a plain
 * `--name: value;` scan, and later matches overwrite earlier ones — so a COMMENT
 * that happens to contain `--some-token:` (e.g. prose like "same split as
 * `--primary-solid`: white on …") parses as a declaration whose value runs to the
 * next semicolon, silently replacing the real one. That failure mode is worse
 * than a crash: the guard would go on measuring a colour the app never renders.
 */
function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '')
}

function customProps(body: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const m of stripComments(body).matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/gi)) {
    out[m[1] as string] = (m[2] as string).trim()
  }
  return out
}

const THEMES = {
  light: customProps(ruleBody(':root')),
  dark: customProps(ruleBody('.dark')),
} as const

type Theme = keyof typeof THEMES
type Rgb = readonly [number, number, number]

/** Resolve one level of `var(--x)` indirection, then parse to opaque sRGB. */
function rgb(theme: Theme, token: string): Rgb {
  const vars = THEMES[theme]
  let raw = vars[token]
  if (raw === undefined) throw new Error(`[${theme}] token \`${token}\` is not defined`)

  const varRef = raw.match(/^var\(\s*(--[a-z0-9-]+)\s*\)$/i)
  if (varRef) {
    const next = vars[varRef[1] as string]
    if (next === undefined) throw new Error(`[${theme}] \`${token}\` → undefined \`${varRef[1]}\``)
    raw = next
  }

  const short = raw.match(/^#([0-9a-f]{3})$/i)
  if (short) {
    const h = short[1] as string
    return [...h].map((c) => parseInt(c + c, 16)) as unknown as Rgb
  }

  const long = raw.match(/^#([0-9a-f]{6})$/i)
  if (long) {
    const h = long[1] as string
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as unknown as Rgb
  }

  // `rgb(R G B)` / `rgb(R, G, B)`. Alpha forms are rejected on purpose: a
  // translucent token has no single contrast ratio, so it must not be asserted.
  const fn = raw.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)\s*\)$/i)
  if (fn) return [Number(fn[1]), Number(fn[2]), Number(fn[3])] as unknown as Rgb

  throw new Error(`[${theme}] \`${token}\`: unsupported / translucent colour "${raw}"`)
}

// ── WCAG 2.x math (https://www.w3.org/TR/WCAG21/#dfn-relative-luminance) ─────

function relativeLuminance([r, g, b]: Rgb): number {
  const lin = (c: number): number => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

function contrastRatio(a: Rgb, b: Rgb): number {
  const la = relativeLuminance(a)
  const lb = relativeLuminance(b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

// ── the contract ─────────────────────────────────────────────────────────────

/**
 * The surfaces arbitrary text is actually painted on. `--input` is excluded: it
 * only ever holds `text-foreground`.
 *
 * `--muted` is deliberately NOT here. It is not a general text surface: `bg-muted`
 * has exactly one consumer in the app (the avatar-count badge at
 * AgentListColumn.tsx:407) and it carries `text-foreground/75` and nothing else.
 * Asserting the full colour ramp against it manufactured five failures for
 * pairings that do not exist — `--primary`, `--secondary` and `--amber` are never
 * rendered on it. The one real pairing is asserted directly below instead.
 */
const SURFACES = ['--background', '--surface', '--card', '--popover', '--surface-raised'] as const

/** 1.4.3 Contrast (Minimum) — normal-size body text. */
const AA_TEXT: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['--foreground', SURFACES],
  ['--card-foreground', ['--card']],
  ['--popover-foreground', ['--popover']],
  // The single real `bg-muted` pairing — see the SURFACES note.
  ['--foreground', ['--muted']],
  ['--secondary', SURFACES],
  ['--muted-foreground', SURFACES],
  ['--destructive', SURFACES],
  // `--primary` is text at ~54 sites (`text-primary` / `text-accent`), not just fill.
  ['--primary', SURFACES],
]

/**
 * Label-on-fill pairs (button chrome).
 *
 * The fill is `--primary-solid` / `--destructive-solid`, NOT `--primary` /
 * `--destructive`. In dark mode those are deliberately different values: the
 * plain token is the lighter TEXT/accent red (it has to clear the dark surfaces
 * in AA_TEXT above), and a white label on that lighter red is only 3.83:1. The
 * `-solid` tokens are the deeper fills that actually sit under a button label.
 * Asserting against the wrong one here would silently pass while every real CTA
 * failed.
 */
const AA_ON_COLOR: ReadonlyArray<readonly [string, string]> = [
  ['--primary-foreground', '--primary-solid'],
  ['--destructive-foreground', '--destructive-solid'],
]

/** 1.4.11 Non-text Contrast — status colours used on badges, icons, pills and
 *  large numerals, never as body copy. `--blue` is excluded: it has ZERO
 *  consumers and its dark value measures 1.42:1, so asserting it would only
 *  freeze a dead token in place. */
const UI_NON_TEXT: ReadonlyArray<readonly [string, readonly string[]]> = [
  // The solid button fills as SHAPES against the page — the button has to be
  // discernible from its background even before its label is read.
  ['--primary-solid', SURFACES],
  ['--destructive-solid', SURFACES],
  ['--mint', SURFACES],
  ['--amber', SURFACES],
  ['--violet', SURFACES],
  ['--category-data', SURFACES],
  ['--category-code', SURFACES],
  ['--category-web', SURFACES],
  ['--category-other', SURFACES],
]

const AA_MIN = 4.5
const UI_MIN = 3.0

/**
 * Pairs knowingly below their tier. Each entry ratchets: the measured ratio may
 * never drop below the recorded floor, so debt can shrink but never grow.
 *
 * EMPTY, and it should stay that way. Every entry that used to live here was
 * either a real failure (fixed in globals.css — the two brand nudges and the two
 * dark-mode button labels) or an artefact of asserting `--muted` as a general
 * text surface, which it is not. Adding an entry back means shipping text below
 * AA, so it needs an explicit reviewer decision and a written rationale.
 */
const KNOWN_DEBT: Record<string, { floor: number; why: string }> = {}

const EPSILON = 0.005

function check(theme: Theme, fg: string, bg: string, min: number, failures: string[]): void {
  const key = `${theme} ${fg} on ${bg}`
  const ratio = contrastRatio(rgb(theme, fg), rgb(theme, bg))
  const debt = KNOWN_DEBT[key]
  const required = debt ? debt.floor - EPSILON : min
  if (ratio + EPSILON < required) {
    failures.push(
      debt
        ? `${key} = ${ratio.toFixed(2)}:1 — REGRESSED below its recorded floor of ${debt.floor.toFixed(2)}:1. ${debt.why}`
        : `${key} = ${ratio.toFixed(2)}:1 — needs >= ${min.toFixed(1)}:1. ` +
            `Fix the token in globals.css, or add "${key}" to KNOWN_DEBT with a written rationale.`,
    )
  }
}

describe.each(['light', 'dark'] as const)('design tokens — %s theme', (theme) => {
  it('meets WCAG AA (4.5:1) for every text-token / surface pair', () => {
    const failures: string[] = []
    for (const [fg, bgs] of AA_TEXT) for (const bg of bgs) check(theme, fg, bg, AA_MIN, failures)
    for (const [fg, bg] of AA_ON_COLOR) check(theme, fg, bg, AA_MIN, failures)
    expect(failures).toEqual([])
  })

  it('meets WCAG non-text contrast (3:1) for every status-colour / surface pair', () => {
    const failures: string[] = []
    for (const [fg, bgs] of UI_NON_TEXT)
      for (const bg of bgs) check(theme, fg, bg, UI_MIN, failures)
    expect(failures).toEqual([])
  })
})

describe('contrast debt', () => {
  it('does not grow without review', () => {
    expect(Object.keys(KNOWN_DEBT)).toHaveLength(0)
  })

  // Regression guard for a parser bug that made this whole file lie: prose in a
  // CSS comment containing `--token:` was scanned as a declaration and, being
  // later in the block, overwrote the real value. The suite still passed — it was
  // just measuring a colour the app never renders. These assertions pin the
  // parsed values to what globals.css actually declares.
  it('parses the real declarations, not prose from comments', () => {
    for (const theme of ['light', 'dark'] as const) {
      for (const token of [
        '--primary',
        '--primary-solid',
        '--destructive',
        '--destructive-solid',
      ]) {
        // A corrupted parse yields prose, which `rgb()` rejects outright.
        expect(() => rgb(theme, token)).not.toThrow()
      }
    }
    // Dark splits the fill from the text red; light has no conflict and aliases.
    expect(rgb('dark', '--primary-solid')).not.toEqual(rgb('dark', '--primary'))
    expect(rgb('dark', '--destructive-solid')).not.toEqual(rgb('dark', '--destructive'))
    expect(rgb('light', '--primary-solid')).toEqual(rgb('light', '--primary'))
    expect(rgb('light', '--destructive-solid')).toEqual(rgb('light', '--destructive'))
  })

  it('keeps --muted-foreground distinct from --secondary in both themes', () => {
    // They used to be byte-identical (#64748b / #6b7280) and both sub-AA in
    // dark. `--muted-foreground` is now the AA-safe micro-type token; silently
    // re-aliasing it to --secondary would undo the fix without failing anything
    // else, because --secondary carries a documented debt entry.
    for (const theme of ['light', 'dark'] as const) {
      expect(rgb(theme, '--muted-foreground')).not.toEqual(rgb(theme, '--secondary'))
    }
  })
})
