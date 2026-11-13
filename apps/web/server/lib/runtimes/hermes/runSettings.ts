// What one Hermes run asks the gateway for: its input, and the provider and
// model it is pinned to. Pure apart from reading the profile's config.yaml and
// the ChatGPT sign-in files. The precedence is the one Hermes runs have always
// had in Clawboo:
//   1. a provider picked for the agent (with its model), when its key or sign-in
//      is there; a pick whose key is missing is dropped with its model;
//   2. a provider named in the profile's own config.yaml (`model.provider`): no
//      provider or model is sent, Hermes uses the config;
//   3. otherwise the provider of the first connected key: OpenRouter, then
//      Anthropic, then OpenAI, then the ChatGPT sign-in; with a cheap default
//      model for each (none for the ChatGPT plan, which picks its own).

import { buildAttachConfig, MCP_SERVER_NAMES, type AttachScope } from '@clawboo/mcp'
import type { StartOpts } from '@clawboo/executor'

import { isAgentUserMode } from '../../agentUser/config'
import {
  hasUsableHermesCodexAuth,
  hasUsableHermesCodexAuthIn,
  userHermesAuthPath,
} from '../hermesAuth'
import { detectProvider, type HermesMcpServers } from '../hermesHome'
import type { RuntimeRunContext } from '../types'

/** Default model per derived provider, used only when no model was given and the
 *  profile's config names no provider: OpenRouter refuses a request with no model,
 *  and a coding-runtime team member has none. */
const DERIVED_PROVIDER_MODEL: Record<string, string> = {
  openrouter: 'openai/gpt-4o-mini',
  anthropic: 'claude-haiku-4-5',
  'openai-api': 'gpt-4o-mini',
}

/** The vault variable that makes a picked provider usable. A provider not listed
 *  (a keyless one) counts as usable. */
const PICK_PROVIDER_ENV: Record<string, string> = {
  openrouter: 'OPENROUTER_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  'openai-api': 'OPENAI_API_KEY',
}

/** Why a Hermes subscription run with agents on their own OS user has no credential. */
export const HERMES_AGENT_SIGN_IN_MESSAGE =
  'Sign in to Hermes for the agents from the Runtimes page (agents run as their own user, ' +
  'so your own Hermes login is not shared with them), or add an API key for a Hermes provider.'

export interface HermesRunSettings {
  /** The run's input: the context block, then the message. */
  input: string
  /** The model to send, or undefined to leave it to the profile's config. */
  model: string | undefined
  /** The provider to send, or null to leave it to the profile's config or Hermes. */
  provider: string | null
}

export async function resolveHermesRunSettings(
  opts: StartOpts,
  ctx: RuntimeRunContext,
  profileDir: string,
): Promise<HermesRunSettings> {
  const input = opts.context ? `${opts.context}\n\n${opts.message}` : opts.message
  const explicitModel = ctx.model ?? opts.model ?? undefined
  const requested = ctx.providerHint ?? null
  // The profile is agent space, so its sign-in is read through the agent-space
  // file verbs. With agents on their own OS user the person's own login is never
  // shared with them, so only the profile's counts (seeded from the agent user's
  // own sign-in). Read once, on first need.
  const agentMode = isAgentUserMode()
  let usable: boolean | null = null
  const codexUsable = async (): Promise<boolean> => {
    usable ??=
      (await hasUsableHermesCodexAuthIn(profileDir)) ||
      (!agentMode && hasUsableHermesCodexAuth(userHermesAuthPath()))
    return usable
  }
  const keyed = (name: string): boolean => Boolean(ctx.apiKeyEnv?.[name])
  const pickUsable =
    requested !== null &&
    (requested === 'openai-codex'
      ? await codexUsable()
      : PICK_PROVIDER_ENV[requested] === undefined || keyed(PICK_PROVIDER_ENV[requested]!))
  const picked = pickUsable ? requested : null
  // A dropped pick also drops its provider-specific model.
  const model0 = requested !== null && !pickUsable ? undefined : explicitModel
  const configured = await detectProvider(profileDir)
  const provider = picked
    ? picked
    : configured
      ? null
      : keyed('OPENROUTER_API_KEY')
        ? 'openrouter'
        : keyed('ANTHROPIC_API_KEY')
          ? 'anthropic'
          : keyed('OPENAI_API_KEY')
            ? 'openai-api'
            : (await codexUsable())
              ? 'openai-codex'
              : null
  // With agents on their own OS user, a run that needs the subscription and has
  // neither the agents' own sign-in nor a provider key fails here, saying why,
  // rather than on Hermes's own missing-credential error.
  if (agentMode && !(await codexUsable())) {
    const anyKey =
      Object.keys(ctx.apiKeyEnv ?? {}).length > 0 ||
      Object.values(PICK_PROVIDER_ENV).some((name) => Boolean(process.env[name]))
    const wantsSubscription =
      requested === 'openai-codex' || configured === 'openai-codex' || (!provider && !configured)
    if (!anyKey && wantsSubscription) throw new Error(HERMES_AGENT_SIGN_IN_MESSAGE)
  }
  const model =
    model0 ?? (provider && (picked || !configured) ? DERIVED_PROVIDER_MODEL[provider] : undefined)
  return { input, model, provider }
}

/** Clawboo's MCP servers for one run, each URL carrying the run's own signed
 *  scope. Used for a throwaway profile, which lives for one run. */
export function hermesRunMcpServers(baseUrl: string, scope?: AttachScope): HermesMcpServers {
  const servers: HermesMcpServers = {}
  for (const server of MCP_SERVER_NAMES) {
    const cfg = buildAttachConfig({
      runtime: 'openclaw',
      server,
      transport: 'http',
      httpBaseUrl: baseUrl,
      scope,
    })
    servers[`clawboo-${server}`] = { url: (cfg.structured as { url: string }).url }
  }
  return servers
}

/**
 * Clawboo's MCP servers for an agent's own profile. The gateway connects to them
 * once and keeps the connections across runs, so the URL cannot carry a run:
 * it names the agent and asks Clawboo to bind each call to that agent's run in
 * progress (`live`), signed so it cannot be pointed at another agent.
 */
export function hermesAgentMcpServers(
  baseUrl: string,
  agentId: string,
  attachSecret: string | null | undefined,
): HermesMcpServers {
  return hermesRunMcpServers(baseUrl, { agentId, live: true, attachSecret: attachSecret ?? null })
}
