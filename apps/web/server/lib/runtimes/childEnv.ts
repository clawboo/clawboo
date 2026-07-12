// Environment for a SEMI-TRUSTED spawned subprocess — a runtime CLI (Codex / Hermes),
// the Claude Agent SDK child, AND the deterministic verify gate (which runs a model/
// worktree-authored VERIFY_CMD, see verification/deterministicGate.ts). Each executes
// UNTRUSTED, model-directed content that can read its own process env and exfiltrate it
// (one `env` command), so we scrub secrets before the child inherits them. Two families:
//
//   1. clawboo's OWN server secrets — MUST never be inherited:
//      - GATEWAY_AUTH_TOKEN    — the OpenClaw gateway bearer (written to ~/.openclaw/.env)
//      - STUDIO_ACCESS_TOKEN   — the dashboard access-gate credential (the only auth for a
//                                non-loopback bind)
//      - CLAWBOO_SECRETS_MASTER_KEY — the vault master key
//      - BETTER_AUTH_*         — any future server-auth secret in that family
//
//   2. the OPERATOR's third-party shell secrets — the cloud/CI/registry credentials a
//      developer routinely exports (GITHUB_TOKEN, NPM_TOKEN, STRIPE_SECRET_KEY, AWS keys,
//      DATABASE_URL, …). A prompt-injected task shouldn't be able to dump these.
//
// We DENYLIST BY EXACT NAME, never a broad `*KEY*`/`*TOKEN*` regex: the provider auth a
// runtime legitimately uses is either granted EXPLICITLY by the caller (apiKeyEnv, merged
// on top below) OR read from the AMBIENT env (Codex reads OPENAI_API_KEY; Hermes reads its
// configured provider's key e.g. GEMINI_API_KEY / MISTRAL_API_KEY; Claude Code reads
// ANTHROPIC_AUTH_TOKEN). A name heuristic would strip exactly those and silently break a
// runtime — which is why the denylist enumerates only well-known operator secrets that NO
// clawboo runtime authenticates with, plus PATH / HOME / PYTHONUSERBASE / proxy / AWS_REGION
// (infra config, not secrets) always survive.
//
// This is BEST-EFFORT by name, NOT a sandbox: the child still runs un-sandboxed and can read
// on-disk credentials (~/.aws/credentials, ~/.config/gh/hosts.yml, project .env files). It
// closes the single most trivial vector (the `env` dump) and the env-only secrets — CI-
// injected session tokens that never touch disk and so are reachable no other way.

const CLAWBOO_SECRET_ENV_KEYS = new Set([
  'GATEWAY_AUTH_TOKEN',
  'STUDIO_ACCESS_TOKEN',
  'CLAWBOO_SECRETS_MASTER_KEY',
])

// Well-known THIRD-PARTY operator credentials that no clawboo runtime uses for auth.
// Exact-match, UPPERCASE-normalized. Add a name here only if you are certain no runtime
// (Codex / Hermes / Claude Code / native / the verify gate) authenticates with it.
const THIRD_PARTY_SECRET_ENV_KEYS = new Set([
  // Version control
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'GH_ENTERPRISE_TOKEN',
  'GITHUB_PAT',
  'GITLAB_TOKEN',
  'GITLAB_PERSONAL_ACCESS_TOKEN',
  'BITBUCKET_TOKEN',
  // Package registries
  'NPM_TOKEN',
  'NODE_AUTH_TOKEN',
  'PYPI_TOKEN',
  'TWINE_PASSWORD',
  'CARGO_REGISTRY_TOKEN',
  // Cloud / platform (non-LLM)
  'DIGITALOCEAN_TOKEN',
  'DIGITALOCEAN_ACCESS_TOKEN',
  'DO_API_TOKEN',
  'VERCEL_TOKEN',
  'NETLIFY_AUTH_TOKEN',
  'CLOUDFLARE_API_TOKEN',
  'CLOUDFLARE_API_KEY',
  'CF_API_TOKEN',
  'HEROKU_API_KEY',
  'FLY_API_TOKEN',
  'RAILWAY_TOKEN',
  // Payments / comms
  'STRIPE_SECRET_KEY',
  'STRIPE_API_KEY',
  'TWILIO_AUTH_TOKEN',
  'SENDGRID_API_KEY',
  'MAILGUN_API_KEY',
  'SLACK_TOKEN',
  'SLACK_BOT_TOKEN',
  'SLACK_APP_TOKEN',
  // Databases
  'DATABASE_URL',
  'DATABASE_PASSWORD',
  'PGPASSWORD',
  'MYSQL_PWD',
  'MONGODB_URI',
  'REDIS_URL',
  // Secret managers
  'VAULT_TOKEN',
  'OP_SERVICE_ACCOUNT_TOKEN',
  'DOPPLER_TOKEN',
  // Error tracking / CI
  'SENTRY_AUTH_TOKEN',
  'CODECOV_TOKEN',
  'TURBO_TOKEN',
  'CIRCLE_TOKEN',
  // Container registries
  'DOCKERHUB_TOKEN',
  'DOCKER_PASSWORD',
])

// AWS access keys are BOTH a headline operator secret AND the auth for a Claude Code
// "Amazon Bedrock" run. Strip them by default; keep them ONLY when the operator has
// explicitly enabled that backend (CLAUDE_CODE_USE_BEDROCK is truthy) — the signal a
// runtime genuinely needs them. AWS_REGION / AWS_DEFAULT_REGION / AWS_PROFILE are config,
// not secrets, and are never in this set, so a Bedrock run keeps its region either way.
const AWS_CRED_ENV_KEYS = new Set([
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
])

function isTruthyFlag(v: string | undefined): boolean {
  if (v === undefined) return false
  const s = v.trim().toLowerCase()
  return s !== '' && s !== '0' && s !== 'false'
}

function isScrubbedSecret(key: string, opts: { keepAwsCreds: boolean }): boolean {
  const upper = key.toUpperCase()
  if (CLAWBOO_SECRET_ENV_KEYS.has(upper)) return true
  if (upper.startsWith('BETTER_AUTH')) return true
  if (THIRD_PARTY_SECRET_ENV_KEYS.has(upper)) return true
  if (!opts.keepAwsCreds && AWS_CRED_ENV_KEYS.has(upper)) return true
  return false
}

/**
 * Build a child-process env from the server env minus clawboo's own server secrets AND a
 * curated set of the operator's third-party shell secrets, then merge the caller's explicit
 * grant (provider keys / isolated HOME) on top — so a granted key is always restored even if
 * a same-named key was scrubbed. Infra config (PATH/HOME/PYTHONUSERBASE/proxy/AWS_REGION) and
 * the ambient provider-auth the CLIs read (OPENAI_API_KEY / GEMINI_API_KEY / …) are preserved.
 */
export function buildChildEnv(extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  // Keep AWS creds only when the operator explicitly runs Claude Code against Bedrock.
  const keepAwsCreds = isTruthyFlag(process.env['CLAUDE_CODE_USE_BEDROCK'])
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue
    if (isScrubbedSecret(key, { keepAwsCreds })) continue
    env[key] = value
  }
  for (const [key, value] of Object.entries(extra)) {
    if (value !== undefined) env[key] = value
  }
  return env
}
