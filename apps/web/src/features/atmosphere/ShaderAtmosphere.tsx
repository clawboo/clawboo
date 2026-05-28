/**
 * ShaderAtmosphere — the public entry point for the Welcome / Onboarding backdrop.
 *
 * Three independent gates each fall back to the zero-WebGL StaticAtmosphere:
 *   1. User opted out via the Maintenance toggle (localStorage)
 *   2. OS reports prefers-reduced-motion
 *   3. (Render-only — does not affect mount/unmount) WebGL chunk still loading: Suspense fallback paints the static layer
 *
 * When mounted, the IntersectionObserver + document.visibilitychange handlers
 * pause the WebGL canvas chunk by un-rendering it (set to null) — three.js
 * stops rAF when there's no canvas in the DOM. Re-mounting on tab focus is
 * cheap because the JS chunk is already cached.
 *
 * Brand-faithful per Phase 15 plan: colors pulled from the theme-aware
 * --atmosphere-{1,2,3} tokens via useTheme(), so the shader follows light/dark
 * automatically.
 */
import { Suspense, lazy, useRef } from 'react'
import { useTheme } from '@/features/theme/useTheme'
import { StaticAtmosphere } from './StaticAtmosphere'
import {
  useAtmospherePreference,
  useElementVisible,
  useReducedMotion,
} from './useAtmospherePreference'

const ShaderAtmosphereInner = lazy(() => import('./ShaderAtmosphereInner'))

// Brand-faithful palette per the approved Phase 15 plan. Kept in sync with
// the --atmosphere-{1,2,3} tokens in globals.css. If you adjust globals.css,
// update these too — the shader takes hex strings, not CSS vars.
const PALETTE = {
  light: { color1: '#dc2a48', color2: '#059669', color3: '#d97706' },
  dark: { color1: '#e94560', color2: '#34d399', color3: '#fbbf24' },
} as const

export interface ShaderAtmosphereProps {
  variant?: 'hero' | 'subtle'
}

export function ShaderAtmosphere({ variant = 'hero' }: ShaderAtmosphereProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const preference = useAtmospherePreference()
  const reduced = useReducedMotion()
  const visible = useElementVisible(containerRef)
  const { resolvedTheme } = useTheme()

  const skipShader = preference === 'off' || reduced

  return (
    <div
      ref={containerRef}
      aria-hidden
      className="pointer-events-none absolute inset-0 overflow-hidden"
    >
      {/* StaticAtmosphere always renders as a low-cost base layer. The shader
          fades in over it (when allowed), so the surface is never blank during
          chunk load / off-screen pause / opt-out. */}
      <StaticAtmosphere variant={variant} />
      {!skipShader && visible && (
        <Suspense fallback={null}>
          <ShaderAtmosphereInner
            color1={PALETTE[resolvedTheme].color1}
            color2={PALETTE[resolvedTheme].color2}
            color3={PALETTE[resolvedTheme].color3}
            variant={variant}
          />
        </Suspense>
      )}
      {/* Soft scrim — anchors foreground legibility against the moving shader.
          Uses the page-background color so it blends with the surrounding UI
          and never feels like a separate panel. Subtle radial fade in the
          centre lets the atmosphere breathe through behind the hero content. */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background: `radial-gradient(ellipse 60% 50% at 50% 50%, rgb(var(--canvas-rgb) / ${
            variant === 'subtle' ? 0.25 : 0.45
          }) 0%, rgb(var(--canvas-rgb) / 0) 70%)`,
        }}
      />
    </div>
  )
}
