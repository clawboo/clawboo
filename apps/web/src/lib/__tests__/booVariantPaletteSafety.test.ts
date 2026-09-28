import { describe, expect, it } from 'vitest'
import { loadBooVariant } from '@clawboo/ui'
import type { BooSurface, BooVariantId } from '@clawboo/ui'

import { COLLECTION_IDS, generateTeamColors, hueRotationFromSeed } from '@/lib/teamPalettes'

/*
 * Every colour a team can hand an avatar must be drawable.
 *
 * The variants carry legibility guards: Claude's chevron eyes are locked dark, so a deep body
 * loses the face, and Hermes's hem carries the silhouette against a dark page. Those guards refuse
 * a colour by throwing. The palettes are generated rather than chosen from a list, and about one
 * generated colour in twenty lands in the refused range, so before the renderers resolved the tint
 * first this threw inside the React render pass and took out whichever subtree held the avatar.
 *
 * This walks the whole space the product can actually produce: every collection, both themes, a
 * spread of team sizes, and several team seeds, since the seed rotates the hues.
 */
const VARIANTS: BooVariantId[] = ['codex', 'claude', 'hermes']
const SURFACES: BooSurface[] = ['light', 'dark']
const COUNTS = [1, 2, 3, 5, 8, 12]
/* The fourth argument is a hue rotation in degrees, which a team derives from its id, so the sweep
   has to cover rotations rather than pass seeds straight through. */
const ROTATIONS = ['', 'team-a', 'team-b', 'e7f3a1'].map(hueRotationFromSeed).concat([90, 180, 270])

describe('every generated team colour is drawable by every variant', () => {
  it.each(VARIANTS)(
    '%s draws every palette colour on both surfaces',
    async (variantId) => {
      const failures: string[] = []
      let drawn = 0

      for (const surface of SURFACES) {
        const renderer = await loadBooVariant(variantId, surface)
        for (const collection of COLLECTION_IDS) {
          for (const theme of ['light', 'dark'] as const) {
            for (const count of COUNTS) {
              for (const rotation of ROTATIONS) {
                for (const colour of generateTeamColors(collection, count, theme, rotation)) {
                  try {
                    const svg = renderer.render(colour)
                    if (!svg.startsWith('<svg')) failures.push(`${colour} produced no svg`)
                    drawn++
                  } catch (error) {
                    failures.push(`${colour} (${collection}/${theme}/${surface}): ${String(error)}`)
                  }
                }
              }
            }
          }
        }
      }

      expect(drawn).toBeGreaterThan(1000)
      expect(failures.slice(0, 5)).toEqual([])
    },
    120_000,
  )
})
