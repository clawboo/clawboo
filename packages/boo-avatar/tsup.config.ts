import { defineConfig } from 'tsup'

export default defineConfig({
  // FIVE ENTRY POINTS, and the split is load bearing rather than tidy. `index` is the generator
  // plus the variant registry, which every surface imports statically. The four variant entries
  // carry the locked brand artwork, 188KB raw with Hermes 178KB of it, and are reached only through
  // `loadBooVariant`'s `await import()`. Bundling them together would put every runtime's mascot,
  // both Hermes surfaces included, into the first paint of every install.
  entry: {
    index: 'src/index.ts',
    'variants/codex': 'src/variants/codex.ts',
    'variants/claude': 'src/variants/claude.ts',
    'variants/hermes-light': 'src/variants/hermes-light.ts',
    'variants/hermes-dark': 'src/variants/hermes-dark.ts',
  },
  format: ['cjs', 'esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  // Code splitting is what keeps the artwork out of `index`: the registry's dynamic imports resolve
  // to the variant entry chunks instead of being inlined into the entry that reaches them.
  splitting: true,
})
