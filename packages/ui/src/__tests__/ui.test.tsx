// The @clawboo/ui public surface: the class-merge helper every component in the
// app routes through, the design tokens, the boo-avatar re-exports (so a
// consumer never needs a direct @clawboo/boo-avatar dependency), and the one
// component this package actually ships.
//
// Assertions read the DOM directly rather than through jest-dom matchers, so
// this package needs no vitest setup file. Only @testing-library/react is
// imported — its @testing-library/dom peer resolves from RTL's own directory,
// not from here.

import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { BooAvatar, cn, resolveBooTint, TINTS, tokens } from '../index'

afterEach(() => cleanup())

describe('cn', () => {
  it('lets the later Tailwind class win a conflict (twMerge, not concatenation)', () => {
    expect(cn('px-2', 'px-4')).toBe('px-4')
    expect(cn('p-2 p-3')).toBe('p-3')
    expect(cn('text-red-500', 'text-blue-500')).toBe('text-blue-500')
  })

  it('keeps non-conflicting classes and preserves order', () => {
    expect(cn('flex', 'items-center', 'gap-2')).toBe('flex items-center gap-2')
  })

  it('drops falsy clsx inputs and flattens arrays / objects', () => {
    // The `cond && 'class'` idiom every component in the app uses.
    const classes = (collapsed: boolean) =>
      cn('text-sm', collapsed && 'hidden', undefined, null, 'font-bold')
    expect(classes(false)).toBe('text-sm font-bold')
    expect(classes(true)).toBe('text-sm hidden font-bold')
    expect(cn(['a', 'b'], { c: true, d: false })).toBe('a b c')
    expect(cn()).toBe('')
  })
})

describe('re-exports', () => {
  it('re-exports the boo-avatar tint surface unchanged', () => {
    expect(TINTS).toHaveLength(10)
    expect(TINTS[0]).toBe('#ff4d4d') // OpenClaw red, reserved for Boo Zero
  })

  it('resolveBooTint reserves index 0 for Boo Zero and is deterministic otherwise', () => {
    expect(resolveBooTint('any-seed', true)).toBe(TINTS[0])
    expect(resolveBooTint('agent-1')).toBe(resolveBooTint('agent-1'))
    // Every non-Boo-Zero agent skips the reserved red.
    for (const seed of ['agent-1', 'agent-2', 'research', 'ops']) {
      expect(TINTS.slice(1)).toContain(resolveBooTint(seed))
    }
  })

  it('exposes the design tokens', () => {
    expect(Object.keys(tokens)).toEqual(['colors', 'fonts'])
    expect(tokens.colors.accent).toBe('#E94560')
    expect(tokens.colors.background).toBe('#0A0E1A')
    expect(tokens.fonts.mono).toContain('Geist Mono')
  })
})

describe('BooAvatar', () => {
  it('renders an inline svg scaled to the 100:92 viewBox aspect', () => {
    const { container } = render(<BooAvatar seed="agent-1" size={64} />)
    const svg = container.querySelector('svg')
    expect(svg).not.toBeNull()
    expect(svg?.getAttribute('viewBox')).toBe('0 0 100 92')
    expect(svg?.getAttribute('width')).toBe('64')
    expect(svg?.getAttribute('height')).toBe('59') // Math.round(64 * 92/100)
  })

  it('defaults to size 40 and forwards className to the wrapper', () => {
    const { container } = render(<BooAvatar seed="agent-1" className="ring-1" />)
    const svg = container.querySelector('svg')
    expect(svg?.getAttribute('width')).toBe('40')
    expect(svg?.getAttribute('height')).toBe('37') // Math.round(40 * 0.92)
    expect(container.querySelector('span.ring-1')).not.toBeNull()
  })

  it('is deterministic for a seed and differs across seeds', () => {
    // Each mounted copy scopes its gradient id to itself, so compare the drawing without the scope.
    const drawing = (html: string) =>
      html.replace(/(boo-body-[0-9a-f]{8}-[0-9a-f]{6})-[A-Za-z0-9_-]+/g, '$1')
    const a = drawing(render(<BooAvatar seed="agent-1" />).container.innerHTML)
    cleanup()
    const b = drawing(render(<BooAvatar seed="agent-1" />).container.innerHTML)
    cleanup()
    const c = drawing(render(<BooAvatar seed="agent-2" />).container.innerHTML)
    expect(a).toBe(b)
    expect(a).not.toBe(c)
  })

  it('paints the reserved OpenClaw red for Boo Zero', () => {
    const { container } = render(<BooAvatar seed="anything" isBooZero />)
    expect(container.innerHTML).toContain(TINTS[0])
  })

  it('keeps its body when an earlier copy of the same Boo is hidden', () => {
    // A collapsed sidebar keeps its tiles mounted but hidden. url(#id) resolves to the first
    // matching id in the document, and a browser does not paint a gradient defined in a hidden
    // subtree, so a later copy resolving there drew no body.
    const { container } = render(
      <>
        <div style={{ display: 'none' }}>
          <BooAvatar seed="milo" size={36} />
        </div>
        <div data-testid="shown">
          <BooAvatar seed="milo" size={16} />
        </div>
      </>,
    )
    const shown = container.querySelector('[data-testid="shown"] svg') as SVGSVGElement
    const refs = [...shown.outerHTML.matchAll(/url\(#([^)]+)\)/g)].map((m) => m[1])
    expect(refs.length).toBeGreaterThan(0)
    for (const id of refs) expect(shown.contains(document.getElementById(id))).toBe(true)
  })
})
