import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  schema: './src/schema.ts',
  out: './drizzle',
  dialect: 'sqlite',
  dbCredentials: {
    // Used by drizzle-kit studio/push only — runtime path is set by createDb()
    url: './dev.db',
  },
})
