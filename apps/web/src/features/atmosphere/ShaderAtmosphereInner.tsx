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
    <div className="pointer-events-none absolute inset-0">
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
          // Camera: slight 3D tilt, zoomed wide so blobs read as atmosphere.
          cAzimuthAngle={180}
          cPolarAngle={80}
          cDistance={4.4}
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
          rotationX={50}
          rotationY={0}
          rotationZ={-60}
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
