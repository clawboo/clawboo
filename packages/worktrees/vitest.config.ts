import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    globals: true,
    // Worktree tests spawn real `git` against temp repos; give them headroom.
    testTimeout: 30_000,
  },
})
