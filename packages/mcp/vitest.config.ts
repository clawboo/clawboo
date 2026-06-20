import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    globals: true,
    // The contract test boots MCP servers over an in-memory transport + opens
    // an in-memory SQLite DB — fast, but give a little headroom.
    testTimeout: 20_000,
  },
})
