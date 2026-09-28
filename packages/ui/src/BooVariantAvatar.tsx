import { memo, useEffect, useMemo, useState } from 'react'
import { BOO_VARIANTS, loadBooVariant } from '@clawboo/boo-avatar'
import type { BooSurface, BooVariantId, BooVariantRenderer } from '@clawboo/boo-avatar'

// ─── BooVariantAvatar props ───────────────────────────────────────────────────

export interface BooVariantAvatarProps {
  variantId: BooVariantId
  /**
   * The colour to paint the variant in. `null` or `undefined` keeps the variant's own locked
   * colour, which is its default rather than a fallback.
   */
  tint?: string | null
  /** Which locked file to draw. Only Hermes ships two; the others use one for both surfaces. */
  surface?: BooSurface
  /** Width in pixels. Height follows the variant's own aspect. @default 40 */
  size?: number
  className?: string
}

// ─── Renderer loading ─────────────────────────────────────────────────────────

/**
 * Renderers already resolved in this session, shared by every instance so a second avatar of the
 * same variant paints on its first frame instead of flashing a placeholder. `loadBooVariant`
 * caches the chunk promise; this caches the awaited result, which is what a synchronous first
 * render needs.
 */
const resolvedVariants = new Map<string, BooVariantRenderer>()

const cacheKey = (variantId: BooVariantId, surface: BooSurface): string => `${variantId}:${surface}`

type Resolved = { key: string; renderer: BooVariantRenderer }

/**
 * Load the renderer for a variant and surface, returning `null` until it arrives.
 *
 * While a NEW surface of the same variant loads, the renderer we already have keeps drawing: a
 * theme flip must not collapse the avatar to an empty box, and for a variant with one file for
 * both surfaces it is the same drawing anyway. A different variant does fall back to `null`,
 * because drawing the old runtime's mascot would be wrong rather than merely stale.
 */
function useBooVariantRenderer(
  variantId: BooVariantId,
  surface: BooSurface,
): BooVariantRenderer | null {
  const key = cacheKey(variantId, surface)
  const [resolved, setResolved] = useState<Resolved | null>(() => {
    const hit = resolvedVariants.get(key)
    return hit ? { key, renderer: hit } : null
  })

  useEffect(() => {
    if (resolved?.key === key) return
    const hit = resolvedVariants.get(key)
    if (hit) {
      setResolved({ key, renderer: hit })
      return
    }
    let live = true
    loadBooVariant(variantId, surface)
      .then((renderer) => {
        resolvedVariants.set(key, renderer)
        if (live) setResolved({ key, renderer })
      })
      .catch(() => {
        // A failed chunk fetch leaves the placeholder in place. `loadBooVariant` drops the
        // rejected promise from its own cache, so a later mount retries rather than replaying
        // the error for the rest of the session.
      })
    return () => {
      live = false
    }
  }, [key, variantId, surface, resolved])

  if (!resolved) return null
  return resolved.key === key || resolved.renderer.meta.id === variantId ? resolved.renderer : null
}

/**
 * Rewrite the root `<svg>` element's width and height.
 *
 * Each variant carries its own viewBox in its own units (Codex 118, Hermes 113.638 with decimals),
 * so the attributes are matched inside the opening tag rather than against the fixed
 * `width="100" height="92"` string the generated mascot always emits.
 */
function withSize(svg: string, w: number, h: number): string {
  return svg.replace(/<svg\b[^>]*>/, (tag) =>
    tag.replace(/\swidth="[^"]*"/, ` width="${w}"`).replace(/\sheight="[^"]*"/, ` height="${h}"`),
  )
}

// ─── BooVariantAvatar ─────────────────────────────────────────────────────────
// Renders one runtime's locked brand artwork as an inline SVG, lazily: the four locked files are
// 188KB raw, so they arrive through `loadBooVariant`'s dynamic import rather than in the bundle.
// The wrapper span is sized before the artwork lands, so nothing shifts when it does.

export const BooVariantAvatar = memo(function BooVariantAvatar({
  variantId,
  tint,
  surface = 'light',
  size = 40,
  className,
}: BooVariantAvatarProps) {
  const renderer = useBooVariantRenderer(variantId, surface)
  const w = size
  // The aspect comes from the renderer once it is here, and from the registry's metadata before
  // then, so the placeholder reserves the same box the artwork will fill.
  const aspect = renderer?.meta.aspect ?? BOO_VARIANTS[variantId].aspect
  const h = Math.round(size * aspect)

  const svg = useMemo(
    () => (renderer ? withSize(renderer.render(tint), w, h) : null),
    [renderer, tint, w, h],
  )

  return (
    <span
      className={className}
      aria-hidden="true"
      data-boo-variant={variantId}
      style={{ display: 'inline-flex', width: w, height: h, flexShrink: 0 }}
      {...(svg ? { dangerouslySetInnerHTML: { __html: svg } } : {})}
    />
  )
})
