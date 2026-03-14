import { describe, it, expect } from 'vitest'
import { generateBooAvatar, booAvatarToDataUrl } from '../index'
import type { EyeShape, Accessory } from '../index'

describe('generateBooAvatar', () => {
  it('returns a string starting with <svg', () => {
    const svg = generateBooAvatar({ seed: 'test-agent' })
    expect(svg.trimStart().startsWith('<svg')).toBe(true)
  })

  it('same seed always produces identical output (deterministic)', () => {
    const a = generateBooAvatar({ seed: 'determinism-check' })
    const b = generateBooAvatar({ seed: 'determinism-check' })
    expect(a).toBe(b)
  })

  it('different seeds produce different output', () => {
    const a = generateBooAvatar({ seed: 'agent-alpha' })
    const b = generateBooAvatar({ seed: 'agent-beta' })
    expect(a).not.toBe(b)
  })

  it('all 5 eyeShape values (0-4) produce valid SVG', () => {
    for (let i = 0; i <= 4; i++) {
      const svg = generateBooAvatar({ seed: 'eye-test', eyeShape: i as EyeShape })
      expect(svg).toContain('<svg')
      expect(svg).toContain('</svg>')
    }
  })

  it('all 5 accessories produce valid SVG', () => {
    const accessories: Accessory[] = ['none', 'glasses', 'hat', 'headphones', 'crown']
    for (const acc of accessories) {
      const svg = generateBooAvatar({ seed: 'acc-test', accessory: acc })
      expect(svg).toContain('<svg')
      expect(svg).toContain('</svg>')
    }
  })

  it('special characters in seed do not throw', () => {
    expect(() => generateBooAvatar({ seed: '' })).not.toThrow()
    expect(() => generateBooAvatar({ seed: '🤖💀🎃' })).not.toThrow()
    expect(() => generateBooAvatar({ seed: '<script>alert("xss")</script>' })).not.toThrow()
    expect(() => generateBooAvatar({ seed: '   ' })).not.toThrow()
    expect(() => generateBooAvatar({ seed: 'a'.repeat(10000) })).not.toThrow()
  })

  it('output contains viewBox attribute', () => {
    const svg = generateBooAvatar({ seed: 'viewbox-test' })
    expect(svg).toContain('viewBox="0 0 100 92"')
  })

  it('respects custom tint color', () => {
    const svg = generateBooAvatar({ seed: 'tint-test', tint: '#FF00FF' })
    expect(svg).toContain('#FF00FF')
  })

  it('contains unique gradient ID based on seed', () => {
    const svg = generateBooAvatar({ seed: 'gradient-test' })
    expect(svg).toMatch(/id="boo-body-[0-9a-f]{8}"/)
  })

  // V3-specific tests

  it('uses cyan pupils for OpenClaw red tint', () => {
    const svg = generateBooAvatar({ seed: 'cyan-pupil-test', tint: '#ff4d4d', eyeShape: 0 })
    expect(svg).toContain('#00e5cc')
  })

  it('uses white pupils for non-red tints', () => {
    const svg = generateBooAvatar({ seed: 'white-pupil-test', tint: '#34D399', eyeShape: 0 })
    expect(svg).toContain('#ffffff')
  })

  it('contains claw paths with gradient fill', () => {
    const svg = generateBooAvatar({ seed: 'claw-test' })
    // Body + 2 claws = at least 3 paths with gradient fill
    const gradientFillCount = (svg.match(/fill="url\(#boo-body-/g) || []).length
    expect(gradientFillCount).toBeGreaterThanOrEqual(3)
  })

  it('contains antenna Q-curve control points', () => {
    const svg = generateBooAvatar({ seed: 'antenna-test' })
    expect(svg).toContain('Q30,8')
    expect(svg).toContain('Q70,8')
  })

  it('includes aria-hidden attribute', () => {
    const svg = generateBooAvatar({ seed: 'aria-test' })
    expect(svg).toContain('aria-hidden="true"')
  })
})

describe('isBooZero tint reservation', () => {
  it('isBooZero=true forces OpenClaw red tint (#ff4d4d)', () => {
    const svg = generateBooAvatar({ seed: 'boo-zero-test', isBooZero: true })
    // OpenClaw red should appear in the gradient stop
    expect(svg).toContain('#ff4d4d')
  })

  it('isBooZero=false never produces OpenClaw red for any seed', () => {
    // Test 50 random seeds — none should get the reserved red tint
    for (let i = 0; i < 50; i++) {
      const svg = generateBooAvatar({ seed: `non-zero-agent-${i}`, isBooZero: false })
      // The gradient stop should NOT contain the reserved red
      expect(svg).not.toContain('stop-color="#ff4d4d"')
    }
  })

  it('explicit tint overrides isBooZero', () => {
    const svg = generateBooAvatar({ seed: 'override-test', isBooZero: true, tint: '#34D399' })
    // Explicit tint should win over isBooZero
    expect(svg).toContain('#34D399')
    expect(svg).not.toContain('stop-color="#ff4d4d"')
  })
})

describe('booAvatarToDataUrl', () => {
  it('converts seed to a base64 data URL', () => {
    const url = booAvatarToDataUrl({ seed: 'data-url-test' })
    expect(url.startsWith('data:image/svg+xml;base64,')).toBe(true)
  })
})
