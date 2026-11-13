// Single source of truth for the non-OpenClaw runtimes: id set, install command,
// auth model, health binary, and docs. Consumed by the runtime registry (health
// + adapter wiring), the install/connect/status REST handlers, and surfaced
// (without secrets) to the UI via GET /api/runtimes. Pure data + helpers — no
// driver/SDK imports, so importing this never pulls a runtime dependency into the
// server boot graph.

import { NATIVE_PROVIDER_ENV_VARS } from '@clawboo/adapter-native'

export type NonOpenClawRuntimeId =
  'claude-code' | 'codex' | 'hermes' | 'clawboo-native' | 'clawboo-mock'

/**
 * The runtimes a normal install offers. `clawboo-mock` is deliberately ABSENT:
 * it is a fault-injection harness, and `enabledRuntimeIds()` adds it only behind
 * an env flag. Keeping it out of this list is what stops it appearing in the UI,
 * in `GET /api/runtimes`, and in anything that enumerates real runtimes.
 */
export const NON_OPENCLAW_RUNTIME_IDS: readonly NonOpenClawRuntimeId[] = [
  'claude-code',
  'codex',
  'hermes',
  'clawboo-native',
]

/** Set `CLAWBOO_ENABLE_MOCK_RUNTIME=1` to expose the fault-injecting runtime. */
export const MOCK_RUNTIME_ENV = 'CLAWBOO_ENABLE_MOCK_RUNTIME'

/** True only when the operator explicitly opted in. */
export function mockRuntimeEnabled(): boolean {
  return process.env[MOCK_RUNTIME_ENV] === '1'
}

export type RuntimeAuthKind = 'api-key' | 'oauth' | 'none'

export interface RuntimeDescriptor {
  id: NonOpenClawRuntimeId
  /** Friendly display name. */
  name: string
  /** CLI binary whose presence `resolveRuntimeBin` probes for health.
   *  null = no CLI to probe: a built-in, in-process runtime, or one whose runs
   *  start an SDK's own binary (`sdkBinary`). */
  healthBin: string | null
  /** A runtime whose runs load an SDK and start that SDK's own platform binary:
   *  it is installed exactly when both are there, whatever CLI is on PATH. */
  sdkBinary?: 'claude-agent-sdk'
  /** How the runtime is installed. null = nothing to install (built-in).
   *  `release`: a pinned release Clawboo downloads and installs itself (Hermes). */
  packageManager: 'npm' | 'release' | null
  /** What is installed. An npm runtime installs this package into a folder of its
   *  own under Clawboo's runtimes folder (`npmRuntimeInstall.ts`), never with
   *  `npm install -g`; a release runtime names it as `owner/repo@tag`. */
  pkg: string | null
  /** For an npm runtime: the package's commands to put in the runtimes folder's
   *  `bin/` (each runs on the Node that installed it). Empty for a library. */
  npmBins?: readonly string[]
  /** Human-readable install command, for a person installing it by hand (UI +
   *  error remediation). Null when only Clawboo's own install will do. */
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
    // A run loads the Claude Agent SDK and the SDK starts its own `claude` from
    // a per-platform package; a `claude` CLI on PATH is never used. So the SDK
    // is what makes Claude Code installed, and what Install fetches.
    healthBin: null,
    sdkBinary: 'claude-agent-sdk',
    packageManager: 'npm',
    // Pinned to the SDK's current 0.3 line (latest patch within it), the one the
    // driver is built against, so a future 0.4 or a compromised publish is never
    // auto-installed. Bump deliberately on review, together with apps/web.
    pkg: '@anthropic-ai/claude-agent-sdk@0.3',
    // A library, so no commands: runs import it from Clawboo's runtimes folder.
    npmBins: [],
    // Installed by hand it has to sit next to Clawboo, which only a global
    // Clawboo allows, so Install in Clawboo is the way it is offered.
    installCommand: null,
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
    npmBins: ['codex'],
    // By hand: a global Codex on PATH is still found when Clawboo has none.
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
    // Installed from its GitHub release, pinned (lib/runtimes/hermes/release.ts),
    // into Clawboo's runtimes folder with the uv and Python 3.14 that release
    // pins for itself: PyPI's hermes-agent lags the releases. Clawboo then runs
    // Hermes's own gateway and drives every Hermes agent through it.
    packageManager: 'release',
    pkg: 'NousResearch/hermes-agent@v0.23.1',
    installCommand: null,
    builtIn: false,
    authKind: 'api-key',
    envVar: 'OPENROUTER_API_KEY',
    // Hermes routes across providers (config.yaml `model.provider`, or the
    // provider a run asks for), so a native-onboarded Anthropic or OpenAI key
    // ALSO makes it usable: any of these satisfies the credential check,
    // mirroring the native runtime.
    altEnvVars: ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY'],
    docsUrl: 'https://hermes-agent.nousresearch.com/docs',
    headlessAuth: true,
  },
  'clawboo-mock': {
    id: 'clawboo-mock',
    name: 'Mock (fault injection)',
    // A test harness that ships with the server and executes nothing: every
    // event it emits is synthesized. Present so coordination failures (silence,
    // a crash, an unresolved tool call, a slow start) can be reproduced through
    // the REAL drain and executor paths instead of only against a unit double.
    healthBin: null,
    packageManager: null,
    pkg: null,
    installCommand: null,
    builtIn: true,
    authKind: 'none',
    envVar: null,
    docsUrl: 'https://github.com/clawboo/clawboo',
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

/** Every vault slot a runtime reads: its primary key, then its alternatives. */
export function runtimeKeySlots(d: RuntimeDescriptor): string[] {
  return [d.envVar, ...(d.altEnvVars ?? [])].filter((v): v is string => Boolean(v))
}

export interface DisconnectPlan {
  /** Stored keys a full disconnect deletes: no other runtime reads them. */
  removes: string[]
  /** Stored keys it keeps, with the other runtimes (by name) that read each one. */
  keeps: { envVar: string; sharedWith: string[] }[]
}

/**
 * What a full Disconnect of `id` does to the vault. The vault holds one copy of
 * each provider key for every runtime, so a slot another runtime also reads stays
 * (this runtime just stops using it), and only a slot nobody else reads is
 * deleted. `deletes` is every such slot, stored or not; `plan` lists only the
 * slots that hold a key, which is what the confirm names.
 */
export function disconnectPlanFor(
  id: NonOpenClawRuntimeId,
  stored: (envVar: string) => boolean,
): { deletes: string[]; plan: DisconnectPlan } {
  const others = (Object.keys(RUNTIME_DESCRIPTORS) as NonOpenClawRuntimeId[])
    .filter((other) => other !== id && other !== 'clawboo-mock')
    .map((other) => RUNTIME_DESCRIPTORS[other])
  const deletes: string[] = []
  const plan: DisconnectPlan = { removes: [], keeps: [] }
  for (const envVar of runtimeKeySlots(RUNTIME_DESCRIPTORS[id])) {
    const sharedWith = others.filter((o) => runtimeKeySlots(o).includes(envVar)).map((o) => o.name)
    if (sharedWith.length === 0) deletes.push(envVar)
    if (!stored(envVar)) continue
    if (sharedWith.length === 0) plan.removes.push(envVar)
    else plan.keeps.push({ envVar, sharedWith })
  }
  return { deletes, plan }
}

export function isRuntimeId(id: string): id is NonOpenClawRuntimeId {
  return (NON_OPENCLAW_RUNTIME_IDS as readonly string[]).includes(id)
}

/**
 * May the host route a team run to this runtime?
 *
 * `isRuntimeId` is the STATIC list, which deliberately excludes the mock harness
 * so it never appears in the UI or in `GET /api/runtimes` unflagged. Gating
 * delivery on that list too meant the flag exposed the runtime everywhere EXCEPT
 * the orchestrated path, the one thing the harness exists to exercise. A team
 * turn to a mock agent failed with "not server-orchestrated yet" while the
 * executor path, which resolves through `adapterFactoryFor`, ran it fine.
 *
 * Same env flag, so a normal install is unchanged: without it this is exactly
 * `isRuntimeId`.
 */
export function isOrchestratableRuntimeId(id: string): id is NonOpenClawRuntimeId {
  return isRuntimeId(id) || (mockRuntimeEnabled() && id === 'clawboo-mock')
}

/** The runtime's connection state, derived without exposing any secret value. */
export type RuntimeConnectionState =
  'not-installed' | 'needs-auth' | 'needs-login' | 'ready' | 'unknown'

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
