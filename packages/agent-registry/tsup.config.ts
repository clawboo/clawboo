import { defineConfig } from 'tsup'

export default defineConfig({
  // Pure, browser-safe barrel: the AgentSource trait + neutral record types + the
  // registry multiplexer. Zero runtime deps so the SPA can import the record types
  // to type REST responses, and the server can import the trait for its impl.
  entry: { index: 'src/index.ts' },
  format: ['cjs', 'esm'],
  dts: true,
  clean: true,
  sourcemap: true,
})
