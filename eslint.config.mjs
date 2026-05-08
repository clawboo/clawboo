import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import prettierConfig from 'eslint-config-prettier'

// Node.js globals needed by CommonJS scripts. Listed inline (vs. importing
// the `globals` package) to avoid adding a new dependency for one config
// override. Add entries here if a future script needs more (e.g.
// `globalThis`, `URL`, `URLSearchParams`).
const nodeGlobals = {
  require: 'readonly',
  module: 'readonly',
  exports: 'writable',
  __dirname: 'readonly',
  __filename: 'readonly',
  process: 'readonly',
  console: 'readonly',
  Buffer: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly',
  setImmediate: 'readonly',
  clearImmediate: 'readonly',
  global: 'readonly',
  globalThis: 'readonly',
}

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettierConfig,
  {
    ignores: ['**/dist/**', '**/.next/**', '**/node_modules/**'],
    rules: {
      // Allow _-prefixed params/vars in stubs and intentional no-ops
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
    },
  },
  // CommonJS scripts (e.g. `apps/web/scripts/dev-orchestrator.cjs`) — these
  // are Node-only files invoked by package.json scripts. Tell ESLint they
  // use CommonJS and have access to Node globals so the no-undef rule
  // doesn't flag `require` / `process` / `console`.
  {
    files: ['**/*.cjs'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: nodeGlobals,
    },
  },
)
