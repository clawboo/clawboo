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
  // Web APIs that Node 18+ exposes globally — used by scripts/test-clean-install.mjs
  fetch: 'readonly',
  AbortController: 'readonly',
  URL: 'readonly',
  URLSearchParams: 'readonly',
}

// ─── Layer boundaries ────────────────────────────────────────────────────────
// `apps/web/server` (Express API, tsup-bundled for Node) and `apps/web/src` (the
// Vite browser SPA) are separate build targets, and packages must never depend
// on apps. Anything two layers share belongs in a `@clawboo/*` package — see
// `packages/model-catalog`, extracted for exactly this reason.
//
// The patterns are deliberately RELATIVE-ONLY. A broad `**/src/**` or
// `**/server/**` would also flag legitimate bare specifiers (`react-dom/server`
// is the obvious one), and a bare-specifier import is a different concern than
// crossing this repo's own layer boundary.
const SERVER_TO_SPA = ['../src/**', '**/../src/**', '../src', '**/../src', '@/*', '@/**']
const SPA_TO_SERVER = ['../server/**', '**/../server/**', '../server', '**/../server']
const PACKAGES_TO_APPS = ['../apps/**', '**/../apps/**']

// `no-restricted-imports` only visits static import/export declarations, so a
// dynamic `import('../../src/x')` slips past it. These selectors close that gap.
// (`require()` needs no selector — `@typescript-eslint/no-require-imports` from
// the recommended set already forbids it repo-wide.)
const DYNAMIC_IMPORT_INTO_SPA =
  'ImportExpression > Literal[value=/(^@[/])|([.][.][/](.*[/])?src([/]|$))/]'
const DYNAMIC_IMPORT_INTO_SERVER =
  'ImportExpression > Literal[value=/[.][.][/](.*[/])?server([/]|$)/]'

const SERVER_TO_SPA_MESSAGE =
  'apps/web/server must not import from apps/web/src. The server and the browser SPA are separate build targets — move anything they share into a @clawboo/* package (see packages/model-catalog).'
const SPA_TO_SERVER_MESSAGE =
  'apps/web/src must not import from apps/web/server. Server modules pull in node:* and native deps that would be dragged into the browser bundle — move anything they share into a @clawboo/* package (see packages/model-catalog).'
const PACKAGES_TO_APPS_MESSAGE =
  'packages/* must not import from apps/*. Dependencies flow one way: apps depend on packages, never the reverse.'

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettierConfig,
  // Global ignores. This MUST stay an object whose only key is `ignores` — flat
  // config treats `ignores` alongside any other key as a per-config-object
  // exclusion instead, which would leave build output linted by every other
  // config block.
  {
    ignores: ['**/dist/**', '**/.next/**', '**/node_modules/**'],
  },
  {
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
  // ESM scripts in scripts/ (e.g. `scripts/test-clean-install.mjs`) — same
  // story but ESM-shaped. `.mjs` is implicitly sourceType: module.
  {
    files: ['scripts/**/*.{mjs,js}'],
    languageOptions: {
      sourceType: 'module',
      globals: nodeGlobals,
    },
  },
  // Boundary: the Express server may not reach into the browser SPA.
  // NOTE: this only runs because `apps/web`'s lint script covers `server/` as
  // well as `src/`. `apps/web/server/lib/__tests__/importBoundary.test.ts`
  // asserts that, so narrowing the script back can't silently kill the rule.
  {
    files: ['apps/web/server/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [{ group: SERVER_TO_SPA, message: SERVER_TO_SPA_MESSAGE }] },
      ],
      'no-restricted-syntax': [
        'error',
        { selector: DYNAMIC_IMPORT_INTO_SPA, message: SERVER_TO_SPA_MESSAGE },
      ],
    },
  },
  // Boundary: the browser SPA may not reach into the Express server.
  {
    files: ['apps/web/src/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [{ group: SPA_TO_SERVER, message: SPA_TO_SERVER_MESSAGE }] },
      ],
      'no-restricted-syntax': [
        'error',
        { selector: DYNAMIC_IMPORT_INTO_SERVER, message: SPA_TO_SERVER_MESSAGE },
      ],
    },
  },
  // Boundary: packages are the shared layer — they may not depend on apps.
  {
    files: ['packages/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [{ group: PACKAGES_TO_APPS, message: PACKAGES_TO_APPS_MESSAGE }] },
      ],
    },
  },
)
