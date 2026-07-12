// Environment for a SEMI-TRUSTED spawned subprocess — a runtime CLI (Codex / Hermes),
// the Claude Agent SDK child, AND the deterministic verify gate (which runs a model/
// worktree-authored VERIFY_CMD, see verification/deterministicGate.ts). Each executes
// UNTRUSTED, model-directed content that can read its own process env and exfiltrate
// it, so clawboo's OWN server secrets must never be inherited:
//   - GATEWAY_AUTH_TOKEN    — the OpenClaw gateway bearer (written to ~/.openclaw/.env)
//   - STUDIO_ACCESS_TOKEN   — the dashboard access-gate credential (the only auth for a
//                             non-loopback bind)
//   - CLAWBOO_SECRETS_MASTER_KEY — the vault master key
//   - BETTER_AUTH_*         — any future server-auth secret in that family
//
// We DENYLIST clawboo's own secrets rather than allowlisting "what the runtime needs":
// the provider keys a runtime legitimately uses are granted EXPLICITLY by the caller
// (apiKeyEnv) and merged on top, and a broad credential-name heuristic would strip the
// provider-auth / PATH / HOME / PYTHONUSERBASE / proxy env the heterogeneous CLI runtimes
// genuinely depend on. So this closes the named leak deterministically without risking a
// silent break of a runtime.

const CLAWBOO_SECRET_ENV_KEYS = new Set([
  'GATEWAY_AUTH_TOKEN',
  'STUDIO_ACCESS_TOKEN',
  'CLAWBOO_SECRETS_MASTER_KEY',
])

function isClawbooServerSecret(key: string): boolean {
  return CLAWBOO_SECRET_ENV_KEYS.has(key) || key.toUpperCase().startsWith('BETTER_AUTH')
}

/**
 * Build a child-process env from the server env minus clawboo's own secrets, then
 * merge the caller's explicit grant (provider keys / isolated HOME) on top — so a
 * granted key is restored even if a same-named key was scrubbed.
 */
export function buildChildEnv(extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue
    if (isClawbooServerSecret(key)) continue
    env[key] = value
  }
  for (const [key, value] of Object.entries(extra)) {
    if (value !== undefined) env[key] = value
  }
  return env
}
