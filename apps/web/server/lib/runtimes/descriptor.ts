// Single source of truth for the non-OpenClaw runtimes: id set, install command,
// auth model, health binary, and docs. Consumed by the runtime registry (health
// + adapter wiring), the install/connect/status REST handlers, and surfaced
// (without secrets) to the UI via GET /api/runtimes. Pure data + helpers — no
// driver/SDK imports, so importing this never pulls a runtime dependency into the
// server boot graph.

import { NATIVE_PROVIDER_ENV_VARS } from '@clawboo/adapter-native'

export type NonOpenClawRuntimeId = 'claude-code' | 'codex' | 'hermes' | 'clawboo-native'

export const NON_OPENCLAW_RUNTIME_IDS: readonly NonOpenClawRuntimeId[] = [
  'claude-code',
  'codex',
  'hermes',
  'clawboo-native',
]

export type RuntimeAuthKind = 'api-key' | 'oauth' | 'none'

export interface RuntimeDescriptor {
  id: NonOpenClawRuntimeId
  /** Friendly display name. */
  name: string
  /** CLI binary whose presence `resolveRuntimeBin` probes for health.
   *  null = no binary (a built-in, in-process runtime). */
  healthBin: string | null
  /** How the CLI is installed. null = nothing to install (built-in). */
  packageManager: 'npm' | 'pip' | null
  /** Package to install (`npm install -g <pkg>` / `pip|pipx install <pkg>`). */
  pkg: string | null
  /** For a `pip` runtime: the minimum Python 3 MINOR version the package needs
   *  (e.g. 11 for `>=3.11`). The installer resolves a matching interpreter,
   *  preferring version-specific binaries over the bare `python3` (which on a
   *  fresh macOS is the Xcode Command Line Tools Python 3.9 — too old). */
  pythonMinMinor?: number
  /** Human-readable install command (UI + error remediation). */
  installCommand: string | null
  /** Ships inside the clawboo server — always installed, never installable. */
  builtIn: boolean
  /** How the runtime authenticates. */
  authKind: RuntimeAuthKind
  /** Env var the connect endpoint writes to the vault (null for oauth). */
  envVar: string | null
  /** Additional env vars that ALSO satisfy the credential check (a runtime
   *  that can route across providers is connected if any of them resolves). */
  altEnvVars?: string[]
  /** Public product docs. */
  docsUrl: string
  /** Whether the runtime can be authenticated head-less with an API key. */
  headlessAuth: boolean
}

export const RUNTIME_DESCRIPTORS: Record<NonOpenClawRuntimeId, RuntimeDescriptor> = {
  'claude-code': {
    id: 'claude-code',
    name: 'Claude Code',
    healthBin: 'claude',
    packageManager: 'npm',
    // Pinned to the current MAJOR (latest patch/minor within it) so a future
    // major-version-incompatible or compromised publish is never auto-installed,
    // mirroring the OpenClaw `@^2026.5` discipline. Bump deliberately on review.
    pkg: '@anthropic-ai/claude-code@2',
    installCommand: 'npm install -g @anthropic-ai/claude-code@2',
    builtIn: false,
    authKind: 'api-key',
    envVar: 'ANTHROPIC_API_KEY',
    docsUrl: 'https://docs.claude.com/en/docs/claude-code/overview',
    headlessAuth: true,
  },
  codex: {
    id: 'codex',
    name: 'Codex',
    healthBin: 'codex',
    packageManager: 'npm',
    // Pinned to the current 0.x major (blocks an auto-install of a future 1.0).
    pkg: '@openai/codex@0',
    installCommand: 'npm install -g @openai/codex@0',
    builtIn: false,
    // Codex authenticates via an interactive ChatGPT OAuth (`codex login`) — it
    // cannot be connected head-less with a pasted API key on current versions.
    authKind: 'oauth',
    envVar: null,
    docsUrl: 'https://developers.openai.com/codex/cli',
    headlessAuth: false,
  },
  hermes: {
    id: 'hermes',
    name: 'Hermes',
    healthBin: 'hermes',
    packageManager: 'pip',
    // Pinned below the next major (blocks an auto-install of a future 1.0); the
    // installer passes this as a single argv element (no shell), so `<1` is safe.
    // The `[anthropic]` extra bundles the Anthropic provider SDK — OpenAI +
    // OpenRouter ship with hermes core, but the Anthropic provider needs this
    // extra, so a REUSED Anthropic key (the native default) routes without a
    // separate install. Confirmed against the installed CLI (`--provider
    // anthropic` errors "the 'anthropic' package is required" without it).
    pkg: 'hermes-agent[anthropic]<1',
    // hermes-agent requires Python >=3.11,<3.14. A fresh macOS `python3` is the
    // Xcode CLT Python 3.9, which requires-python excludes → pip reports
    // "(from versions: none)". The installer resolves a 3.11+ interpreter first.
    pythonMinMinor: 11,
    installCommand: "pipx install 'hermes-agent[anthropic]<1'",
    builtIn: false,
    authKind: 'api-key',
    envVar: 'OPENROUTER_API_KEY',
    // Hermes routes across providers (config.yaml `model.provider` / `--provider`),
    // so a native-onboarded Anthropic or OpenAI key ALSO makes it usable — any of
    // these satisfies the credential check, mirroring the native runtime. The
    // driver maps whichever key is present to the matching `--provider` flag.
    altEnvVars: ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY'],
    docsUrl: 'https://pypi.org/project/hermes-agent/',
    headlessAuth: true,
  },
  'clawboo-native': {
    id: 'clawboo-native',
    name: 'Clawboo Native',
    // In-process conversational harness — ships inside the server. No binary,
    // no package manager, nothing to install; connect = paste a provider key.
    healthBin: null,
    packageManager: null,
    pkg: null,
    installCommand: null,
    builtIn: true,
    authKind: 'api-key',
    envVar: 'ANTHROPIC_API_KEY',
    // Routable across providers — a key for ANY supported provider (OpenAI,
    // OpenRouter, Google, xAI, Groq, Mistral, Together, Cerebras, Moonshot) makes
    // it usable, so any of them satisfies the credential check. Kept in lock-step
    // with the adapter's NATIVE_PROVIDER_ENV_VARS (minus the primary envVar).
    altEnvVars: NATIVE_PROVIDER_ENV_VARS.filter((v) => v !== 'ANTHROPIC_API_KEY'),
    docsUrl: 'https://github.com/clawboo/clawboo',
    headlessAuth: true,
  },
}

export function getDescriptor(id: NonOpenClawRuntimeId): RuntimeDescriptor {
  return RUNTIME_DESCRIPTORS[id]
}

export function isRuntimeId(id: string): id is NonOpenClawRuntimeId {
  return (NON_OPENCLAW_RUNTIME_IDS as readonly string[]).includes(id)
}

/** The runtime's connection state, derived without exposing any secret value. */
export type RuntimeConnectionState =
  | 'not-installed'
  | 'needs-auth'
  | 'needs-login'
  | 'ready'
  | 'unknown'

export function deriveConnectionState(
  d: RuntimeDescriptor,
  installed: boolean,
  hasCredential: boolean,
  /** For oauth runtimes (codex): whether the user is already logged in (detected
   *  from `codex login status`). When true the runtime is 'ready' — clawboo
   *  reuses the existing terminal login instead of prompting to log in again. */
  oauthLoggedIn = false,
): RuntimeConnectionState {
  if (!installed) return 'not-installed'
  if (d.authKind === 'none') return 'ready'
  if (d.authKind === 'oauth') return oauthLoggedIn ? 'ready' : 'needs-login'
  // api-key
  return hasCredential ? 'ready' : 'needs-auth'
}
