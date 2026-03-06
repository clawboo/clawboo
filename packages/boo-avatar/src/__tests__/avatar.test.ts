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

  it('all 6 accessories produce valid SVG', () => {
    const accessories: Accessory[] = ['none', 'glasses', 'hat', 'bowtie', 'headphones', 'crown']
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
    expect(svg).toMatch(/id="boo-[0-9a-f]{8}"/)
  })
})

describe('booAvatarToDataUrl', () => {
  it('converts SVG to a data URL', () => {
    const svg = generateBooAvatar({ seed: 'data-url-test' })
    const url = booAvatarToDataUrl(svg)
    expect(url.startsWith('data:image/svg+xml,')).toBe(true)
  })
})
