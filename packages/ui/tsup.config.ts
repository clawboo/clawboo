import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['cjs', 'esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  // React is provided by the consuming app — never bundle it
  external: ['react', 'react/jsx-runtime'],
  esbuildOptions(opts) {
    opts.jsx = 'automatic'
  },
})
