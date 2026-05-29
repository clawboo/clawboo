/**
 * ShaderAtmosphereInner — the heavy WebGL render. Default-exported so
 * `React.lazy(() => import('./ShaderAtmosphereInner'))` code-splits the
 * @shadergradient/react + @react-three/fiber + three.js stack into its own
 * chunk. Never import this file directly outside the lazy() call — always
 * go through ShaderAtmosphere.tsx so the gates run.
 */
import { ShaderGradientCanvas, ShaderGradient } from '@shadergradient/react'

export interface ShaderAtmosphereInnerProps {
  /** Hex colors pulled from the active theme by the parent component. */
  color1: string
  color2: string
  color3: string
  /** Hero = full WelcomeState. Subtle = onboarding hero / boo-zero chat backdrop. */
  variant: 'hero' | 'subtle'
}

export default function ShaderAtmosphereInner({
  color1,
  color2,
  color3,
  variant,
}: ShaderAtmosphereInnerProps) {
  const isSubtle = variant === 'subtle'

  // Atmospheric, not decorative. Premium-SaaS reference (Vercel/Linear/Stripe)
  // — the gradient should feel like "weather behind glass", never wash out the
  // foreground. Opacity, brightness, strength are all tuned LOW.
  return (
    // ShaderGradient is a 3D scene with a FINITE plane mesh (not a full-screen
    // fragment shader like Stripe/Linear use), so the plane's edge can always
    // be exposed at some aspect ratio — no camera tweak or percentage oversize
    // fully escapes that. The robust fix: render into a SQUARE canvas larger
    // than the viewport's biggest dimension, centered. A square of side ≥
    // max(viewportW, viewportH) always covers the viewport at ANY aspect, so
    // the plane (which fills its square canvas) overflows the visible area on
    // every side and its edge can never enter frame. `vmax` = 1% of the larger
    // viewport dimension; 140vmax = 1.4× the bigger side = generous margin at
    // any aspect (ultra-wide, ultra-tall, square — all covered). No edge in
    // view means no mask needed (the mask itself created a visible rounded
    // boundary at extreme aspect).
    <div
      className="pointer-events-none absolute"
      style={{
        top: '50%',
        left: '50%',
        transform: 'translate(-50%, -50%)',
        width: '140vmax',
        height: '140vmax',
      }}
    >
      <ShaderGradientCanvas
        style={{
          position: 'absolute',
          inset: 0,
          width: '100%',
          height: '100%',
          opacity: isSubtle ? 0.18 : 0.32,
        }}
        pixelDensity={1}
        pointerEvents="none"
      >
        <ShaderGradient
          control="props"
          animate="on"
          type="waterPlane"
          color1={color1}
          color2={color2}
          color3={color3}
          // Camera: looks STRAIGHT AT the plane (cPolarAngle 90) so the plane
          // faces the camera flat — there's no tilt that exposes a far "horizon"
          // edge. A finite tilted plane (the old rotationX:50 / cPolarAngle:80
          // setup) always leaves an empty band above its edge at some aspect
          // ratio: three.js fixes the vertical FOV and widens the horizontal
          // FOV as the window gets wider, so an ultra-wide/short viewport sees
          // PAST the plane's edges. A face-on, unrotated plane fills the frame
          // edge-to-edge at ANY aspect. cDistance pulled in a touch so the
          // plane more than covers the viewport.
          cAzimuthAngle={180}
          cPolarAngle={90}
          cDistance={3.6}
          cameraZoom={isSubtle ? 0.95 : 1}
          // Slow, gentle motion. uStrength controls deformation amount —
          // low values keep colour blobs from clashing into hard borders.
          uSpeed={0.08}
          uStrength={isSubtle ? 0.45 : 0.6}
          uDensity={0.8}
          uFrequency={4.0}
          uAmplitude={0}
          uTime={0.2}
          positionX={0}
          positionY={0}
          positionZ={0}
          // No tilt (rotationX) or in-plane rotation (rotationZ): a rotated
          // quad doesn't fill a rectangle (its corners cut in), and tilt
          // creates the horizon. Keeping it axis-aligned + face-on is what
          // makes the fill robust across every viewport aspect.
          rotationX={0}
          rotationY={0}
          rotationZ={0}
          lightType="3d"
          brightness={0.7}
          envPreset="city"
          grain="on"
          // Anti-flicker on prop changes (theme switch, variant change).
          enableTransition={false}
          reflection={0.05}
        />
      </ShaderGradientCanvas>
    </div>
  )
}
