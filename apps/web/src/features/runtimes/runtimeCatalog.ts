// Client-side catalog of the non-OpenClaw runtimes — the single source of
// display copy + auth shape so the connection card, the Runtimes panel, and
// the onboarding step never diverge. Mirrors the server descriptor
// (apps/web/server/lib/runtimes/descriptor.ts); the LIVE install/auth status
// comes from GET /api/runtimes at runtime.

export type RuntimeId = 'claude-code' | 'codex' | 'hermes' | 'clawboo-native'
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
  /** Human-readable install command (shown before the live status arrives).
   *  Absent for built-in runtimes — there is nothing to install. */
  installCommand?: string
  /** Ships inside the clawboo server — always installed. */
  builtIn?: boolean
  docsUrl: string
  /** Capability hint shown as chips until live caps arrive from the server. */
  capabilityHint: { streaming: boolean; mcp: boolean; worktrees: boolean; resume: boolean }
}

export const RUNTIME_CATALOG: Record<RuntimeId, RuntimeCatalogEntry> = {
  'clawboo-native': {
    id: 'clawboo-native',
    name: 'Clawboo Native',
    blurb:
      'Built-in conversational runtime. Talks to Anthropic, OpenAI, OpenRouter, or Ollama directly — paste a key and go.',
    authKind: 'api-key',
    envVar: 'ANTHROPIC_API_KEY',
    keyPlaceholder: 'sk-ant-…',
    builtIn: true,
    docsUrl: 'https://github.com/clawboo/clawboo',
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
    blurb: 'Open-source agent runtime over OpenRouter. Paste an OpenRouter key.',
    authKind: 'api-key',
    envVar: 'OPENROUTER_API_KEY',
    keyPlaceholder: 'sk-or-…',
    installCommand: 'pipx install hermes-agent',
    docsUrl: 'https://pypi.org/project/hermes-agent/',
    capabilityHint: { streaming: false, mcp: true, worktrees: true, resume: true },
  },
}

export const RUNTIME_ORDER: RuntimeId[] = ['clawboo-native', 'claude-code', 'codex', 'hermes']
