// BooVariantAvatar: the lazy renderer for a runtime's locked brand artwork.
//
// These tests drive the REAL chunk load, so they assert against the locked artwork itself rather
// than a stub: that the placeholder reserves the box before it lands, that the root svg is resized
// to the caller's size and the variant's own aspect, and that a tint repaints it while `null`
// leaves the locked drawing alone.
//
// Assertions read the DOM directly rather than through jest-dom matchers, so this package needs no
// vitest setup file.

import { cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { BOO_VARIANTS, BooVariantAvatar } from '../index'

afterEach(() => cleanup())

const host = (container: HTMLElement) =>
  container.querySelector<HTMLElement>('[data-boo-variant]') as HTMLElement

const svgOf = async (container: HTMLElement): Promise<SVGSVGElement> => {
  await waitFor(() => expect(container.querySelector('svg')).not.toBeNull())
  return container.querySelector('svg') as SVGSVGElement
}

describe('BooVariantAvatar', () => {
  it('reserves the final box before the artwork arrives, so nothing shifts', () => {
    const { container } = render(<BooVariantAvatar variantId="claude" size={64} />)
    const span = host(container)

    // Claude's viewBox is 100x92, so 64 wide is 59 tall (rounded) both before and after the load.
    expect(span.style.width).toBe('64px')
    expect(span.style.height).toBe(`${Math.round(64 * BOO_VARIANTS.claude.aspect)}px`)
    expect(container.querySelector('svg')).toBeNull()
  })

  it('renders the locked artwork inline, resized to the requested size', async () => {
    const { container } = render(<BooVariantAvatar variantId="codex" size={40} />)
    const svg = await svgOf(container)

    // Codex's own viewBox, untouched: the size lives on width/height, never on the viewBox.
    expect(svg.getAttribute('viewBox')).toBe('-9 -20 118 118')
    expect(svg.getAttribute('width')).toBe('40')
    expect(svg.getAttribute('height')).toBe('40')
    expect(host(container).getAttribute('aria-hidden')).toBe('true')
  })

  it('keeps its own colour for a null tint and repaints for a real one', async () => {
    const own = render(<BooVariantAvatar variantId="codex" tint={null} />)
    const ownSvg = (await svgOf(own.container)).outerHTML
    cleanup()

    const teal = render(<BooVariantAvatar variantId="codex" tint="#34D399" />)
    const teamSvg = (await svgOf(teal.container)).outerHTML

    expect(ownSvg).toContain(BOO_VARIANTS.codex.originalColour as string)
    expect(teamSvg).not.toBe(ownSvg)
  })

  it('draws a different Hermes file per surface', async () => {
    const light = render(<BooVariantAvatar variantId="hermes" surface="light" />)
    const lightSvg = (await svgOf(light.container)).outerHTML
    cleanup()

    const dark = render(<BooVariantAvatar variantId="hermes" surface="dark" />)
    const darkSvg = (await svgOf(dark.container)).outerHTML

    expect(darkSvg).not.toBe(lightSvg)
  })
})
