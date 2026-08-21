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

// ─── Escape arbitration ──────────────────────────────────────────────────────
// Every overlay dismisses through `features/shared/useDismissableLayer`, which
// keeps ONE document listener and hands Escape to the topmost open layer. A
// capture-phase keydown listener re-opens issue #95: capture runs before the
// stack AND before every React `onKeyDown` (React delegates to #root, below
// document), so a dropdown and the dialog hosting it both act on one Escape and
// the dialog discards a half-filled form. `stopPropagation()` cannot prevent it
// — it does not suppress a sibling on the same target in the same phase.
//
// Scoped to the keydown/keyup pair and to capture only: bubble-phase listeners
// are fine (they run after the stack and are shielded by it), and non-keyboard
// capture listeners are a different concern.
const CAPTURE_KEY_LISTENER =
  "CallExpression[callee.property.name='addEventListener'][arguments.0.value=/^key(down|up)$/][arguments.2.value=true]"
const CAPTURE_KEY_LISTENER_OBJ =
  "CallExpression[callee.property.name='addEventListener'][arguments.0.value=/^key(down|up)$/] > ObjectExpression:nth-child(3) > Property[key.name='capture'][value.value=true]"
const CAPTURE_KEY_LISTENER_MESSAGE =
  'No capture-phase key listeners in the SPA. Capture runs before both the dismissable-layer stack and every React onKeyDown, so two overlays act on one Escape (issue #95). Register the overlay with useDismissableLayer() instead; if you truly need a raw listener, use the bubble phase.'

// Root-absolute API URLs in the SPA. clawboo can be mounted under a URL path
// prefix (CLAWBOO_BASE_PATH), so a hardcoded `/api/...` request bypasses the
// prefix and 404s at the origin root. The failure is invisible on a default
// install, where the prefix is empty and the two spellings coincide, which is
// exactly why it needs a lint rule rather than review attention.
//
// Both the string and template-literal forms, for `fetch` and `EventSource`.
const ROOT_ABSOLUTE_API_FETCH =
  "CallExpression[callee.name='fetch'] > Literal.arguments:first-child[value=/^\\/api\\//]"
const ROOT_ABSOLUTE_API_FETCH_TEMPLATE =
  "CallExpression[callee.name='fetch'] > TemplateLiteral.arguments:first-child > TemplateElement:first-child[value.raw=/^\\/api\\//]"
const ROOT_ABSOLUTE_API_EVENTSOURCE =
  "NewExpression[callee.name='EventSource'] > Literal.arguments:first-child[value=/^\\/api\\//]"
const ROOT_ABSOLUTE_API_EVENTSOURCE_TEMPLATE =
  "NewExpression[callee.name='EventSource'] > TemplateLiteral.arguments:first-child > TemplateElement:first-child[value.raw=/^\\/api\\//]"
// Root-absolute STATIC asset refs in JSX (`src="/logo.svg"`). Vite rewrites the
// ones in index.html and in CSS, but a string literal in a component is emitted
// verbatim, so it escapes the mount and 404s at the origin root. A relative ref
// resolves against the `<base href>` the server injects, which is correct at the
// root and under a prefix.
const ROOT_ABSOLUTE_ASSET_JSX =
  'JSXAttribute[name.name=/^(src|href|poster)$/] > Literal[value=/^\\/[^/].*\\.(svg|png|jpe?g|gif|webp|avif|ico|woff2?|mp4|webm)$/]'
const ROOT_ABSOLUTE_ASSET_MESSAGE =
  'Use a RELATIVE asset path (e.g. "logo.svg", not "/logo.svg"). clawboo can be served under a path prefix (CLAWBOO_BASE_PATH); a root-absolute reference escapes the mount and 404s. Relative paths resolve against the <base href> the server injects, which is correct at the root too.'

const ROOT_ABSOLUTE_API_MESSAGE =
  "Use apiFetch()/apiUrl() from '@clawboo/control-client' instead of a root-absolute '/api/...' URL. clawboo can be served under a path prefix (CLAWBOO_BASE_PATH), and a hardcoded root path skips it and 404s. Both helpers are identity at the root, so the default install is unchanged."

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
  // ESM scripts in any scripts/ directory (e.g. `scripts/test-clean-install.mjs`,
  // `docs/scripts/check-frontmatter.mjs`) — same story but ESM-shaped. `.mjs` is
  // implicitly sourceType: module.
  {
    files: ['**/scripts/**/*.{mjs,js}'],
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
  // NOTE: flat config REPLACES a rule's options rather than merging them, so
  // every `no-restricted-syntax` selector that applies to apps/web/src has to
  // live in this one array — a second config object for the same files would
  // silently win and drop these.
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
        { selector: CAPTURE_KEY_LISTENER, message: CAPTURE_KEY_LISTENER_MESSAGE },
        { selector: CAPTURE_KEY_LISTENER_OBJ, message: CAPTURE_KEY_LISTENER_MESSAGE },
        { selector: ROOT_ABSOLUTE_API_FETCH, message: ROOT_ABSOLUTE_API_MESSAGE },
        { selector: ROOT_ABSOLUTE_API_FETCH_TEMPLATE, message: ROOT_ABSOLUTE_API_MESSAGE },
        { selector: ROOT_ABSOLUTE_API_EVENTSOURCE, message: ROOT_ABSOLUTE_API_MESSAGE },
        { selector: ROOT_ABSOLUTE_API_EVENTSOURCE_TEMPLATE, message: ROOT_ABSOLUTE_API_MESSAGE },
        { selector: ROOT_ABSOLUTE_ASSET_JSX, message: ROOT_ABSOLUTE_ASSET_MESSAGE },
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
