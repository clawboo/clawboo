/**
 * apps/cli/src/version.ts
 *
 * The CLI's own version, in its own module so both `index.ts` (the intro line,
 * Commander's `--version`) and `lifecycle.ts` (the `CLAWBOO_VERSION` it hands
 * every server it spawns) can read it without importing each other.
 */

declare const __CLI_VERSION__: string

/**
 * Compiled in by tsup's `define` from `apps/cli/package.json`. The fallback
 * fires when the define is absent — running the TypeScript directly under tsx
 * or vitest — which is exactly the "dev checkout" signal `versionCheck.ts`
 * keys off.
 */
export const VERSION = typeof __CLI_VERSION__ !== 'undefined' ? __CLI_VERSION__ : '0.0.0-dev'
