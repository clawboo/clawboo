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
        background: [
          // Primary brand wash — top-left, large soft blob
          `radial-gradient(ellipse 70% 55% at 30% 35%, color-mix(in oklab, var(--atmosphere-1) calc(var(--atmosphere-intensity) * ${100 * intensityScale}%), transparent) 0%, transparent 65%)`,
          // Mint accent — bottom-right
          `radial-gradient(ellipse 55% 45% at 75% 70%, color-mix(in oklab, var(--atmosphere-2) calc(var(--atmosphere-intensity) * ${70 * intensityScale}%), transparent) 0%, transparent 60%)`,
          // Amber warmth — top-right small accent
          `radial-gradient(ellipse 40% 35% at 80% 20%, color-mix(in oklab, var(--atmosphere-3) calc(var(--atmosphere-intensity) * ${55 * intensityScale}%), transparent) 0%, transparent 55%)`,
        ].join(', '),
      }}
    />
  )
}
