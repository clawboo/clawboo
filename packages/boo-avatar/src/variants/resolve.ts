/**
 * Turning a requested tint into one the variant can actually draw.
 *
 * A variant refuses a tint that would cost it a locked mark: Claude's chevron eyes are locked dark,
 * so a deep body loses the face, and Hermes's hem carries the silhouette against a dark page. The
 * team palettes are generated rather than picked from a list, so roughly one colour in twenty lands
 * there. Those refusals are correct, but they must never reach React: the avatar renders during the
 * render pass, so a throw takes out the subtree that holds it.
 *
 * So the renderer resolves first. The requested colour is used when it passes, otherwise the
 * nearest shade of the same hue that passes, and only if the whole hue is unusable does the Boo
 * fall back to its own locked colour.
 */
import { nearestLegible } from './colour'

const HEX6 = /^#[0-9A-Fa-f]{6}$/

export interface TintResolution {
  /** The colour to draw with, or null to draw the locked artwork. */
  tint: string | null
  /** How the answer was reached, for tests and for anyone debugging a surprising Boo. */
  reason: 'locked' | 'exact' | 'adjusted' | 'unusable' | 'malformed'
}

export function resolveTint(
  requested: string | null | undefined,
  legible: (hex: string) => boolean,
): TintResolution {
  if (requested == null) return { tint: null, reason: 'locked' }
  if (!HEX6.test(requested)) return { tint: null, reason: 'malformed' }
  if (legible(requested)) return { tint: requested, reason: 'exact' }
  const near = nearestLegible(requested, legible)
  return near ? { tint: near, reason: 'adjusted' } : { tint: null, reason: 'unusable' }
}
