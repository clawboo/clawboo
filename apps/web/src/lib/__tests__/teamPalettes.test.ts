import { describe, it, expect } from 'vitest'
import { oklch } from 'culori'
import { TINTS, resolveBooTint } from '@clawboo/ui'

import {
  generateTeamColors,
  collectionAnchorColor,
  hueRotationFromSeed,
  PALETTE_RECIPES,
  COLLECTION_IDS,
  DEFAULT_COLLECTION_ID,
  type CollectionId,
} from '../teamPalettes'
import { resolveTeamBooColor, pickBooColor } from '../resolveTeamBooColor'

const HEX = /^#[0-9a-f]{6}$/i

function parse(hex: string): { l: number; c: number; h: number } {
  const o = oklch(hex)
  if (!o) throw new Error(`unparseable hex: ${hex}`)
  return { l: o.l, c: o.c, h: o.h ?? 0 }
}

function oklabDistance(a: { l: number; c: number; h: number }, b: typeof a): number {
  const ah = (a.h * Math.PI) / 180
  const bh = (b.h * Math.PI) / 180
  const da = a.c * Math.cos(ah) - b.c * Math.cos(bh)
  const db = a.c * Math.sin(ah) - b.c * Math.sin(bh)
  const dl = a.l - b.l
  return Math.sqrt(dl * dl + da * da + db * db)
}

describe('recipe config', () => {
  it('has the collections and a vivid (Classic) default', () => {
    expect(COLLECTION_IDS).toHaveLength(8)
    expect(DEFAULT_COLLECTION_ID).toBe('classic')
    expect(COLLECTION_IDS[0]).toBe(DEFAULT_COLLECTION_ID) // default leads the picker
    expect(COLLECTION_IDS).toContain('vivid-pop')
    expect(COLLECTION_IDS).toContain('monochrome-accent')
    expect(COLLECTION_IDS).toContain('classic')
    // The default renders a lively, high-chroma palette (not muted).
    const defaultAvgChroma = avg(
      generateTeamColors(DEFAULT_COLLECTION_ID, 8, 'dark').map((h) => parse(h).c),
    )
    expect(defaultAvgChroma).toBeGreaterThan(0.1)
  })
})

describe('generateTeamColors — shape & gamut', () => {
  it('returns [] for non-positive counts', () => {
    expect(generateTeamColors('dusty-pastel-pro', 0, 'light')).toEqual([])
    expect(generateTeamColors('dusty-pastel-pro', -3, 'dark')).toEqual([])
  })

  it('returns N valid in-gamut hex colors for every collection and N', () => {
    for (const id of COLLECTION_IDS) {
      for (const n of [1, 8, 12, 20]) {
        for (const theme of ['light', 'dark'] as const) {
          const out = generateTeamColors(id, n, theme)
          expect(out).toHaveLength(n)
          for (const hex of out) expect(hex).toMatch(HEX)
        }
      }
    }
  })

  it('produces no exact duplicate colors through N=20', () => {
    for (const id of COLLECTION_IDS) {
      if (PALETTE_RECIPES[id].fixedColors) continue // fixed lists cycle by design
      const out = generateTeamColors(id, 20, 'dark')
      expect(new Set(out).size).toBe(out.length)
    }
  })
})

describe('generateTeamColors — hue spacing', () => {
  it('spaces hues evenly around the wheel (saturated collection)', () => {
    // sharp-saas has high chroma, so hue survives gamut mapping intact.
    const n = 8
    const hues = generateTeamColors('sharp-saas', n, 'light').map((h) => parse(h).h)
    const step = 360 / n
    for (let i = 0; i < n; i++) {
      const expected = (PALETTE_RECIPES['sharp-saas'].hueOffset + i * step) % 360
      const diff = Math.min(Math.abs(hues[i] - expected), 360 - Math.abs(hues[i] - expected))
      expect(diff).toBeLessThan(3)
    }
  })
})

describe('generateTeamColors — lightness stagger & theme bands', () => {
  it('alternates even Boos lighter and odd Boos darker', () => {
    const cols = generateTeamColors('executive-jewel', 8, 'light').map((h) => parse(h).l)
    const evenMean = avg(cols.filter((_, i) => i % 2 === 0))
    const oddMean = avg(cols.filter((_, i) => i % 2 === 1))
    expect(evenMean).toBeGreaterThan(oddMean)
    // The swing tracks the recipe stagger (±0.05 → ~0.1 between bands).
    expect(evenMean - oddMean).toBeGreaterThan(0.06)
  })

  it('uses a lighter band on dark backgrounds than on light', () => {
    for (const id of COLLECTION_IDS) {
      if (PALETTE_RECIPES[id].fixedColors) continue // fixed lists are theme-independent
      const lightMean = avg(generateTeamColors(id, 8, 'light').map((h) => parse(h).l))
      const darkMean = avg(generateTeamColors(id, 8, 'dark').map((h) => parse(h).l))
      expect(darkMean).toBeGreaterThan(lightMean)
    }
  })

  it('changes output between light and dark themes', () => {
    const light = generateTeamColors('coastal-mist', 8, 'light')
    const dark = generateTeamColors('coastal-mist', 8, 'dark')
    expect(light).not.toEqual(dark)
  })
})

describe('generateTeamColors — monochrome accent', () => {
  it('keeps most slots near-grayscale with one or two color pops', () => {
    const chromas = generateTeamColors('monochrome-accent', 8, 'dark').map((h) => parse(h).c)
    const grays = chromas.filter((c) => c < 0.03)
    const pops = chromas.filter((c) => c > 0.04)
    expect(grays.length).toBeGreaterThanOrEqual(5)
    expect(pops.length).toBeGreaterThanOrEqual(1)
    expect(pops.length).toBeLessThanOrEqual(2)
  })
})

describe('generateTeamColors — min perceptual distance', () => {
  it('keeps wheel-adjacent Boos apart, including the odd-N wrap pair', () => {
    const n = 9 // odd: indices 0 and n-1 are both even → same staggered L
    const pts = generateTeamColors('dusty-pastel-pro', n, 'light').map(parse)
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n
      expect(oklabDistance(pts[i], pts[j])).toBeGreaterThan(0.035)
    }
  })
})

describe('collectionAnchorColor', () => {
  it('returns a stable in-gamut hex per collection', () => {
    for (const id of COLLECTION_IDS) {
      const a = collectionAnchorColor(id)
      expect(a).toMatch(HEX)
      expect(collectionAnchorColor(id)).toBe(a) // deterministic
    }
  })
})

describe('resolveTeamBooColor', () => {
  const agents = [
    { id: 'a', teamId: 't' },
    { id: 'b', teamId: 't' },
    { id: 'z', teamId: null },
    { id: 'solo', teamId: null },
  ]
  const teams = [{ id: 't', colorCollectionId: 'sharp-saas' as CollectionId }]

  it('maps team members to distinct palette slots', () => {
    const ca = resolveTeamBooColor({
      agentId: 'a',
      agents,
      teams,
      booZeroAgentId: 'z',
      theme: 'light',
    })
    const cb = resolveTeamBooColor({
      agentId: 'b',
      agents,
      teams,
      booZeroAgentId: 'z',
      theme: 'light',
    })
    expect(ca).toMatch(HEX)
    expect(cb).toMatch(HEX)
    expect(ca).not.toBe(cb)
    // 'a' < 'b' by stable sort, palette of 2 members excluding Boo Zero 'z',
    // rotated by the team id seed ('t').
    const palette = generateTeamColors('sharp-saas', 2, 'light', hueRotationFromSeed('t'))
    expect(ca).toBe(palette[0])
    expect(cb).toBe(palette[1])
  })

  it('returns undefined for Boo Zero (keeps reserved red)', () => {
    expect(
      resolveTeamBooColor({ agentId: 'z', agents, teams, booZeroAgentId: 'z', theme: 'dark' }),
    ).toBeUndefined()
  })

  it('returns undefined for teamless / unknown agents', () => {
    expect(
      resolveTeamBooColor({ agentId: 'solo', agents, teams, booZeroAgentId: 'z', theme: 'dark' }),
    ).toBeUndefined()
    expect(
      resolveTeamBooColor({ agentId: 'ghost', agents, teams, booZeroAgentId: 'z', theme: 'dark' }),
    ).toBeUndefined()
  })

  it('falls back to the default collection (Classic → legacy hash) when none set', () => {
    const teamsNull = [{ id: 't', colorCollectionId: null }]
    const got = resolveTeamBooColor({
      agentId: 'a',
      agents,
      teams: teamsNull,
      booZeroAgentId: 'z',
      theme: 'light',
    })
    // Default is Classic, which reproduces the original per-agent hash tint.
    expect(got).toBe(resolveBooTint('a', false))
  })
})

describe('classic — legacy-faithful collection', () => {
  it('returns the exact original tints (minus Boo-Zero red), theme-independent', () => {
    const expected = [...TINTS].slice(1) // 9 assignable tints; index 0 (red) reserved
    const light = generateTeamColors('classic', expected.length, 'light')
    const dark = generateTeamColors('classic', expected.length, 'dark')
    expect(light).toEqual(expected)
    expect(light).toEqual(dark) // pixel-identical regardless of theme
  })

  it('cycles the fixed list when the team exceeds its length', () => {
    const out = generateTeamColors('classic', 11, 'light')
    expect(out).toHaveLength(11)
    expect(out[9]).toBe(out[0]) // 9-color list wraps at index 9
  })

  it('anchor color is the first fixed tint', () => {
    expect(collectionAnchorColor('classic')).toBe([...TINTS][1])
  })

  it('pickBooColor reproduces the original per-agent hash assignment', () => {
    for (const agentId of ['alpha', 'bravo', 'charlie', 'x123', 'agent-99']) {
      // Slot/theme are irrelevant for classic — it mirrors resolveBooTint(agentId).
      expect(pickBooColor('classic', ['alpha', 'bravo'], agentId, 'light')).toBe(
        resolveBooTint(agentId, false),
      )
      expect(pickBooColor('classic', [], agentId, 'dark')).toBe(resolveBooTint(agentId, false))
    }
  })
})

describe('per-team hue rotation', () => {
  it('hueRotationFromSeed is deterministic and in 0–359', () => {
    expect(hueRotationFromSeed('team-A')).toBe(hueRotationFromSeed('team-A'))
    for (const s of ['', 'a', 'team-A', 'f66b9297-763c-4a50-9489-b75d7d95584c']) {
      const r = hueRotationFromSeed(s)
      expect(r).toBeGreaterThanOrEqual(0)
      expect(r).toBeLessThan(360)
    }
    expect(hueRotationFromSeed('')).toBe(0)
  })

  it('gives two teams on the SAME collection + count different colors', () => {
    const teamA = generateTeamColors('sharp-saas', 4, 'dark', hueRotationFromSeed('team-A'))
    const teamB = generateTeamColors('sharp-saas', 4, 'dark', hueRotationFromSeed('team-B'))
    expect(teamA).not.toEqual(teamB)
  })

  it('keeps the same chroma/lightness character across the rotation', () => {
    // Rotation shifts hue only — the palette still reads as its collection.
    const base = generateTeamColors('vivid-pop', 6, 'dark', 0).map((h) => parse(h).c)
    const rot = generateTeamColors('vivid-pop', 6, 'dark', hueRotationFromSeed('xyz')).map(
      (h) => parse(h).c,
    )
    expect(avg(rot)).toBeCloseTo(avg(base), 1)
  })

  it('default (no rotation) is unchanged — backward compatible', () => {
    expect(generateTeamColors('vivid-pop', 5, 'light')).toEqual(
      generateTeamColors('vivid-pop', 5, 'light', 0),
    )
  })

  it('classic ignores the seed (stays pixel-exact across teams)', () => {
    const a = generateTeamColors('classic', 5, 'light', hueRotationFromSeed('team-A'))
    const b = generateTeamColors('classic', 5, 'light', hueRotationFromSeed('team-B'))
    expect(a).toEqual(b)
  })
})

function avg(xs: number[]): number {
  return xs.reduce((s, x) => s + x, 0) / xs.length
}
