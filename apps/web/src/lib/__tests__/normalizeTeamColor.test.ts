import { describe, it, expect } from 'vitest'

import { normalizeTeamColor } from '../normalizeTeamColor'
import { TEAM_ACCENT_PRESETS } from '@/features/teams/TeamAccentPicker'

const HEX6 = /^#[0-9a-fA-F]{6}$/

describe('TEAM_ACCENT_PRESETS — hex invariant (regression guard)', () => {
  // team.color is string-concatenated with a hex-alpha suffix (`${color}22`)
  // across the app. A CSS var preset would produce an invalid color → opaque
  // black in SVG halos. This test fails loudly if a non-hex preset is ever
  // reintroduced.
  it('every accent preset is a 6-digit hex (never a CSS var / rgb / named)', () => {
    for (const preset of TEAM_ACCENT_PRESETS) {
      expect(preset, `preset "${preset}" must be 6-digit hex`).toMatch(HEX6)
    }
  })
})

describe('normalizeTeamColor', () => {
  it('maps legacy CSS-var team colors to hex', () => {
    expect(normalizeTeamColor('var(--primary)')).toBe('#e94560')
    expect(normalizeTeamColor('var(--mint)')).toBe('#34d399')
    expect(normalizeTeamColor('var(--amber)')).toBe('#fbbf24')
  })

  it('maps each legacy var to a value matching a hex accent preset', () => {
    // The mapping targets must themselves be valid hex (and align with presets).
    for (const v of ['var(--primary)', 'var(--mint)', 'var(--amber)']) {
      expect(normalizeTeamColor(v)).toMatch(HEX6)
    }
    expect(normalizeTeamColor('var(--primary)')).toBe(TEAM_ACCENT_PRESETS[0])
    expect(normalizeTeamColor('var(--mint)')).toBe(TEAM_ACCENT_PRESETS[1])
    expect(normalizeTeamColor('var(--amber)')).toBe(TEAM_ACCENT_PRESETS[2])
  })

  it('passes through hex colors untouched', () => {
    expect(normalizeTeamColor('#60A5FA')).toBe('#60A5FA')
    expect(normalizeTeamColor('  #38BDF8  ')).toBe('#38BDF8') // trims
  })

  it('falls back to a hex for missing colors', () => {
    expect(normalizeTeamColor(null)).toMatch(HEX6)
    expect(normalizeTeamColor(undefined)).toMatch(HEX6)
    expect(normalizeTeamColor('')).toMatch(HEX6)
  })

  it('passes through unknown non-var strings unchanged', () => {
    expect(normalizeTeamColor('#abc')).toBe('#abc')
  })
})
