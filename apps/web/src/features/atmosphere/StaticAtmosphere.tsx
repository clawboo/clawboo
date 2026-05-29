/**
 * StaticAtmosphere — pure CSS multi-radial gradient backdrop.
 *
 * Used as:
 *  - Suspense fallback while ShaderAtmosphere's WebGL chunk lazy-loads
 *  - The actual render when prefers-reduced-motion is on
 *  - The actual render when the user opted out via the Maintenance toggle
 *  - The render on browsers without WebGL support
 *
 * Zero JS animation, zero WebGL. Reads --atmosphere-{1,2,3} + --atmosphere-intensity
 * tokens from globals.css so it stays brand-faithful in both themes.
 */
export function StaticAtmosphere({ variant = 'hero' }: { variant?: 'hero' | 'subtle' }) {
  const intensityScale = variant === 'subtle' ? 0.5 : 1

  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-0"
      style={{
        // Three brand-colored radial blobs, repositioned to wrap the canvas
        // edges. Premium-SaaS reference (Linear / Vercel / Stripe) — the
        // atmosphere should reach every corner. Previous tuning centered the
        // blobs too far inward (e.g. red at 30% 35% with a 70% × 55% ellipse
        // fading at 65% never reached the top-left corner), leaving visible
        // dark voids around the perimeter. The new positions pull each blob
        // toward its nearest corner and enlarge the ellipses so the fades
        // overlap at the centre while still covering the edges.
        background: [
          // Primary brand wash — anchored toward top-left, tall + wide so it
          // bleeds down into the bottom-left as well (no blob has bottom-left
          // duty otherwise).
          `radial-gradient(ellipse 90% 75% at 18% 28%, color-mix(in oklab, var(--atmosphere-1) calc(var(--atmosphere-intensity) * ${100 * intensityScale}%), transparent) 0%, transparent 75%)`,
          // Mint accent — anchored to bottom-right corner.
          `radial-gradient(ellipse 70% 60% at 82% 78%, color-mix(in oklab, var(--atmosphere-2) calc(var(--atmosphere-intensity) * ${75 * intensityScale}%), transparent) 0%, transparent 70%)`,
          // Amber warmth — anchored to top-right corner. Enlarged from the
          // previous 40% × 35% so the gradient actually reaches the corner
          // pixel before fading to transparent.
          `radial-gradient(ellipse 60% 50% at 84% 14%, color-mix(in oklab, var(--atmosphere-3) calc(var(--atmosphere-intensity) * ${60 * intensityScale}%), transparent) 0%, transparent 65%)`,
          // Full-bleed base wash (bottommost layer) — a diagonal red→amber→mint
          // band that NEVER fades to transparent within the viewport, so every
          // pixel carries brand colour at ANY aspect ratio. Without it, the
          // radial accents above fade to transparent at the extreme edges and
          // the bare page background shows through — invisible on light theme
          // (light page bg) but a clear dark band on dark theme (#0a0e1a).
          // The accents layer on top for the organic variation; this just
          // guarantees there's never a bare-background gap.
          `linear-gradient(120deg, color-mix(in oklab, var(--atmosphere-1) calc(var(--atmosphere-intensity) * ${72 * intensityScale}%), transparent) 0%, color-mix(in oklab, var(--atmosphere-3) calc(var(--atmosphere-intensity) * ${52 * intensityScale}%), transparent) 50%, color-mix(in oklab, var(--atmosphere-2) calc(var(--atmosphere-intensity) * ${72 * intensityScale}%), transparent) 100%)`,
        ].join(', '),
      }}
    />
  )
}
