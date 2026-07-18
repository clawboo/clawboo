// Client-side catalog of the non-OpenClaw runtimes — the single source of
// display copy + auth shape so the connection card, the Runtimes panel, and
// the onboarding step never diverge. Mirrors the server descriptor
// (apps/web/server/lib/runtimes/descriptor.ts); the LIVE install/auth status
// comes from GET /api/runtimes at runtime.

// The connectable-runtime id union is owned by @clawboo/control-client (the shared
// client) so the runtimes REST wrappers and this display catalog share ONE
// definition. Imported for local use here + re-exported so existing
// `import type { RuntimeId } from '.../runtimeCatalog'` sites are unchanged.
import type { RuntimeId } from '@clawboo/control-client'
export type { RuntimeId }
export type RuntimeAuthKind = 'api-key' | 'oauth' | 'none'

export interface RuntimeCatalogEntry {
  id: RuntimeId
  name: string
  /** One-line description (DM Sans). */
  blurb: string
  authKind: RuntimeAuthKind
  /** Env var the connect endpoint writes (display only; never the value). */
  envVar?: string
  /** Placeholder for the API-key input. */
  keyPlaceholder?: string
  /** Terminal command shown for oauth runtimes (codex). */
  loginCommand?: string
  /** ALTERNATIVE terminal auth for an api-key runtime (hermes: a ChatGPT-
   *  subscription login instead of a key). Surfaced as a QUIET optional
   *  affordance under the key input, and ONLY once Codex is a detected fact
   *  (the subscription is set up on the Providers surfaces first); the
   *  existing Re-check picks up the resulting on-disk auth. */
  altLoginCommand?: string
  /** Human-readable install command (shown before the live status arrives).
   *  Absent for built-in runtimes — there is nothing to install. */
  installCommand?: string
  /** Ships inside the clawboo server — always installed. */
  builtIn?: boolean
  docsUrl: string
  /** Console URL where the user can mint an API key (api-key runtimes only;
   *  absent for oauth runtimes like Codex). Shown as a "Get a key ↗" link. */
  keyUrl?: string
  /** Capability hint shown as chips until live caps arrive from the server. */
  capabilityHint: { streaming: boolean; mcp: boolean; worktrees: boolean; resume: boolean }
}

export const RUNTIME_CATALOG: Record<RuntimeId, RuntimeCatalogEntry> = {
  'clawboo-native': {
    id: 'clawboo-native',
    name: 'Clawboo Native',
    blurb:
      'Built-in conversational runtime. Talks to Anthropic, OpenAI, OpenRouter, or Ollama directly. Paste a key and go.',
    authKind: 'api-key',
    envVar: 'ANTHROPIC_API_KEY',
    keyPlaceholder: 'sk-ant-…',
    builtIn: true,
    docsUrl: 'https://github.com/clawboo/clawboo',
    keyUrl: 'https://console.anthropic.com/settings/keys',
    capabilityHint: { streaming: true, mcp: true, worktrees: true, resume: true },
  },
  'claude-code': {
    id: 'claude-code',
    name: 'Claude Code',
    blurb:
      "Anthropic's coding agent (Claude Agent SDK). Paste an API key, or use your logged-in CLI.",
    authKind: 'api-key',
    envVar: 'ANTHROPIC_API_KEY',
    keyPlaceholder: 'sk-ant-…',
    installCommand: 'npm install -g @anthropic-ai/claude-code',
    docsUrl: 'https://docs.claude.com/en/docs/claude-code/overview',
    keyUrl: 'https://console.anthropic.com/settings/keys',
    capabilityHint: { streaming: true, mcp: true, worktrees: true, resume: true },
  },
  codex: {
    id: 'codex',
    name: 'Codex',
    blurb: "OpenAI's coding agent CLI. Sign in once with `codex login` in your terminal.",
    authKind: 'oauth',
    loginCommand: 'codex login',
    installCommand: 'npm install -g @openai/codex',
    docsUrl: 'https://developers.openai.com/codex/cli',
    capabilityHint: { streaming: true, mcp: true, worktrees: true, resume: true },
  },
  hermes: {
    id: 'hermes',
    name: 'Hermes',
    blurb:
      'Open-source agent runtime over OpenRouter. Paste an OpenRouter key, or sign in with ChatGPT.',
    authKind: 'api-key',
    envVar: 'OPENROUTER_API_KEY',
    keyPlaceholder: 'sk-or-…',
    // Hermes's native `openai-codex` provider runs on a ChatGPT subscription —
    // a fresh device-code login in the user's terminal (never the codex-CLI
    // import: separate grant lineages avoid refresh-token conflicts).
    altLoginCommand: 'hermes auth add openai-codex',
    installCommand: "pipx install 'hermes-agent[anthropic]'",
    docsUrl: 'https://pypi.org/project/hermes-agent/',
    keyUrl: 'https://openrouter.ai/keys',
    capabilityHint: { streaming: false, mcp: true, worktrees: true, resume: true },
  },
}

// Display order for the runtime list. OpenClaw (not a RuntimeId) is rendered
// FIRST by RuntimeConnectList; the built-in native runtime sits LAST (it is
// always connected, so there is nothing to do there). Codex precedes Claude Code.
export const RUNTIME_ORDER: RuntimeId[] = ['codex', 'claude-code', 'hermes', 'clawboo-native']

/**
 * Console URLs where a user can mint an API key, keyed by the lowercase
 * provider slug the native runtime + connect endpoints use. Drives the
 * "Get a key ↗" affordance next to the ConfigureNativeStep provider pills.
 * Keyless providers (e.g. ollama) have no entry.
 */
export const PROVIDER_KEY_URLS: Record<string, string> = {
  anthropic: 'https://console.anthropic.com/settings/keys',
  openai: 'https://platform.openai.com/api-keys',
  openrouter: 'https://openrouter.ai/keys',
}

/** The "get a key" console URL for a provider slug, or undefined if keyless. */
export function getKeyUrl(provider: string): string | undefined {
  return PROVIDER_KEY_URLS[provider]
}
