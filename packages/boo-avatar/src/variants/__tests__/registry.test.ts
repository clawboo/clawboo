import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { BOO_VARIANTS, loadBooVariant, variantIdForRuntime } from '../registry'
import type { BooVariantId } from '../types'

const variantsDir = join(dirname(fileURLToPath(import.meta.url)), '..')

describe('variantIdForRuntime', () => {
  it('maps the three runtimes that have brand artwork', () => {
    expect(variantIdForRuntime('codex')).toBe('codex')
    expect(variantIdForRuntime('claude-code')).toBe('claude')
    expect(variantIdForRuntime('hermes')).toBe('hermes')
  })

  it('leaves every other runtime on the generated mascot', () => {
    for (const runtime of ['openclaw', 'clawboo-native', 'human', 'claude', 'gpt', 'codex-cli']) {
      expect(variantIdForRuntime(runtime)).toBeNull()
    }
  })

  it('treats a missing runtime as no variant', () => {
    expect(variantIdForRuntime(null)).toBeNull()
    expect(variantIdForRuntime(undefined)).toBeNull()
    expect(variantIdForRuntime('')).toBeNull()
  })

  it('tolerates the casing and padding a stored runtime string can arrive with', () => {
    expect(variantIdForRuntime(' Codex ')).toBe('codex')
    expect(variantIdForRuntime('CLAUDE-CODE')).toBe('claude')
  })
})

describe('BOO_VARIANTS', () => {
  it('describes each variant without loading its artwork', () => {
    expect(Object.keys(BOO_VARIANTS)).toEqual(['codex', 'claude', 'hermes'])
    expect(BOO_VARIANTS.codex).toEqual({
      id: 'codex',
      label: 'Codex Boo',
      originalLabel: 'Codex blue',
      originalColour: '#7B95FC',
      aspect: 1,
    })
    expect(BOO_VARIANTS.claude.originalColour).toBe('#EA7857')
    // Hermes is drawn in ink, so its original is the absence of a hue rather than a hex.
    expect(BOO_VARIANTS.hermes.originalColour).toBeNull()
    expect(BOO_VARIANTS.hermes.originalLabel).toBe('Black and white')
  })

  it('gives each variant the aspect of its own viewBox', () => {
    expect(BOO_VARIANTS.codex.aspect).toBeCloseTo(1, 10)
    expect(BOO_VARIANTS.claude.aspect).toBeCloseTo(0.92, 10)
    expect(BOO_VARIANTS.hermes.aspect).toBeCloseTo(1, 10)
  })

  it('never reaches an artwork module, which would put 188KB in the package entry', () => {
    const source = readFileSync(join(variantsDir, 'registry.ts'), 'utf8')
    const staticImports = [...source.matchAll(/^import[\s\S]*?from '([^']+)'$/gm)].map((m) => m[1])
    expect(staticImports).toEqual(['./meta', './types'])
    // The variant modules are reached only through `import()`, which is what makes them chunks.
    expect(source).not.toMatch(/^import .*?['"]\.\/artwork/m)
  })
})

describe('loadBooVariant', () => {
  it('caches the load so one chunk is fetched once per surface', () => {
    expect(loadBooVariant('codex')).toBe(loadBooVariant('codex'))
    expect(loadBooVariant('hermes', 'light')).toBe(loadBooVariant('hermes', 'light'))
    // Hermes's two files are separate chunks, so its surfaces must not share a cache entry.
    expect(loadBooVariant('hermes', 'light')).not.toBe(loadBooVariant('hermes', 'dark'))
  })

  it('ignores surface for the variants that ship one file', () => {
    expect(loadBooVariant('codex', 'dark')).toBe(loadBooVariant('codex', 'light'))
    expect(loadBooVariant('claude', 'dark')).toBe(loadBooVariant('claude', 'light'))
  })

  it('returns a renderer whose meta is the registry entry', async () => {
    for (const id of Object.keys(BOO_VARIANTS) as BooVariantId[]) {
      const renderer = await loadBooVariant(id)
      expect(renderer.meta).toBe(BOO_VARIANTS[id])
      expect(typeof renderer.render).toBe('function')
    }
  })

  it('draws Hermes differently on each surface', async () => {
    const light = await loadBooVariant('hermes', 'light')
    const dark = await loadBooVariant('hermes', 'dark')
    expect(light.render()).not.toBe(dark.render())
    // Only the dark file carries the halo stroke that lights the mark's edge on a dark page.
    expect(dark.render()).toContain('stroke="#FFFFFF"')
    expect(light.render()).not.toContain('stroke="#FFFFFF"')
  })

  it('rejects an id it has no chunk for', async () => {
    await expect(loadBooVariant('openclaw' as BooVariantId)).rejects.toThrow(
      'unknown Boo variant "openclaw"',
    )
  })
})
