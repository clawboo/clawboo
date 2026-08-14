import { defineConfig } from 'vitest/config'

// jsdom rather than the house `node` env, because this package's public surface
// is a React component — a smoke test that skipped <BooAvatar/> would skip the
// only thing @clawboo/ui actually ships.
//
// `.test.tsx` ONLY, deliberately: the ROOT vitest.config.ts globs
// `packages/*/src/**/*.test.ts` in a bare node env for ad-hoc runs, so a
// `.test.ts` here would be collected twice and blow up in that node pass.
//
// No `setupFiles` (assertions read the DOM directly instead of going through
// jest-dom matchers) and no plugins — vite's esbuild transform picks up
// `jsx: "react-jsx"` from this package's tsconfig, so the automatic runtime
// works without @vitejs/plugin-react.
export default defineConfig({
  test: {
    include: ['src/**/*.test.tsx'],
    environment: 'jsdom',
    globals: true,
  },
})
