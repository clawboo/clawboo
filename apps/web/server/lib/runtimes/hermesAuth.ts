// Hermes can run on a ChatGPT subscription via its native `openai-codex` OAuth
// provider (`hermes auth add openai-codex`, a device-code flow). The
// tokens live in the user's real Hermes home (`~/.hermes/auth.json`) — NOT in
// config.yaml — and clawboo drives hermes in a MANAGED per-agent HERMES_HOME.
// A managed home outside `~/.hermes` is its OWN hermes "root" (verified against
// hermes 0.15.2's `get_default_hermes_root`), so hermes's global-auth fallback
// never reaches the user's real auth store from a spawned run: the login is
// invisible unless we (a) DETECT it and (b) SEED it into the run's home
// (`seedHermesAuth` in hermesHome.ts). This module owns detection:
//   - `hasUsableHermesCodexAuth(path)` — parse-validated shape check against the
//     store hermes itself writes/reads. Boolean only; token VALUES never leave
//     this function (never logged, never returned, never in a response).
//   - `userHermesHome()` / `userHermesAuthPath()` — where the user's login lives.
// Never writes to the user's ~/.hermes; read/copy only. clawboo never automates
// the OAuth exchange — the user runs `hermes login` in their own terminal.
//
// The usable-shape rule mirrors hermes's OWN readers — a login can land in
// EITHER of two auth.json locations, both accepted by hermes at run time:
//   1. `providers["openai-codex"].tokens` with non-empty `access_token` AND
//      `refresh_token` (the interactive `hermes model` path writes this;
//      hermes_cli/auth.py's `codex_auth_*` validation).
//   2. `credential_pool["openai-codex"]` — a list of PooledCredential entries
//      (`agent/credential_pool.py`) with a non-empty `access_token` (or
//      `refresh_token`). **`hermes auth add openai-codex` — the surfaced
//      command — writes ONLY the pool**, and hermes runtime resolution falls
//      back to it, so pool-only auth is fully usable.
// Anything else fails CLOSED (the subscription option simply doesn't offer itself).

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { agentReadFile } from '../agentUser/agentFs'
import { isAgentUserMode } from '../agentUser/config'
import { agentHomeDir } from '../agentUser/state'

/** The user's real Hermes home (where `hermes login` stored auth.json). Honours
 *  an explicit HERMES_HOME, else the conventional `~/.hermes`. */
export function userHermesHome(): string {
  const env = process.env['HERMES_HOME']?.trim()
  return env && env.length > 0 ? env : path.join(os.homedir(), '.hermes')
}

/** Path to the user's Hermes auth store. */
export function userHermesAuthPath(): string {
  return path.join(userHermesHome(), 'auth.json')
}

/**
 * With agents on their own OS user: that user's own Hermes home, `~/.hermes` in
 * its home folder. The in-app sign-in runs as the agent user, so its login lands
 * here, apart from the person's own. Null with the setting off. Throws when the
 * agent host is not running.
 */
export function agentHermesHome(): string | null {
  return isAgentUserMode() ? path.join(agentHomeDir(), '.hermes') : null
}

/**
 * True when the given hermes auth store carries a USABLE `openai-codex` OAuth
 * credential — the same shape hermes's own reader enforces. Parse-validated,
 * never throws, and token values never escape (boolean out only).
 */
export function hasUsableHermesCodexAuth(authPath: string): boolean {
  try {
    return usableHermesCodexAuthBody(fs.readFileSync(authPath, 'utf8'))
  } catch {
    return false
  }
}

/**
 * The same check of the `auth.json` in a managed Hermes home. That home is agent
 * space (the runtime rotates the token in it), so it is read through the
 * agent-space file verbs: bounded, never through a link, and by the agent host
 * when agents run as their own OS user. Never throws.
 */
export async function hasUsableHermesCodexAuthIn(home: string): Promise<boolean> {
  try {
    const raw = await agentReadFile(path.join(home, 'auth.json'))
    return raw !== null && usableHermesCodexAuthBody(raw.toString('utf8'))
  } catch {
    return false
  }
}

/** The usable-shape rule (see the file header), over a store's text. Never throws. */
function usableHermesCodexAuthBody(raw: string): boolean {
  try {
    const parsed = JSON.parse(raw) as {
      providers?: Record<string, { tokens?: { access_token?: unknown; refresh_token?: unknown } }>
      credential_pool?: Record<string, unknown>
    }
    // Shape 1: the providers store (the `hermes model` interactive path).
    const tokens = parsed.providers?.['openai-codex']?.tokens
    if (tokens && typeof tokens === 'object') {
      const access = tokens.access_token
      const refresh = tokens.refresh_token
      if (
        typeof access === 'string' &&
        access.trim().length > 0 &&
        typeof refresh === 'string' &&
        refresh.trim().length > 0
      ) {
        return true
      }
    }
    // Shape 2: the credential pool (the `hermes auth add` path).
    const pool = parsed.credential_pool?.['openai-codex']
    if (Array.isArray(pool)) {
      for (const entry of pool) {
        if (!entry || typeof entry !== 'object') continue
        const e = entry as { access_token?: unknown; refresh_token?: unknown }
        if (
          (typeof e.access_token === 'string' && e.access_token.trim().length > 0) ||
          (typeof e.refresh_token === 'string' && e.refresh_token.trim().length > 0)
        ) {
          return true
        }
      }
    }
    return false
  } catch {
    return false
  }
}

/** True when the user's REAL hermes home holds a usable `openai-codex` login —
 *  the "hermes can run on the subscription" signal for status/UI. Always false
 *  with agents on their own OS user: the person's own login is never shared with
 *  the agents then, so only the agent user's own counts (see
 *  `agentHermesCodexAuthSeen`). */
export function isHermesCodexAuthPresent(): boolean {
  if (isAgentUserMode()) return false
  return hasUsableHermesCodexAuth(userHermesAuthPath())
}

/** The last answer of `refreshAgentHermesCodexAuth`, for synchronous status
 *  readers (the Runtimes card). Only ever true with agents on their own OS user. */
let agentHermesAuthSeen = false

export function agentHermesCodexAuthSeen(): boolean {
  return isAgentUserMode() && agentHermesAuthSeen
}

/** Ask the agent host whether the agent user has its own Hermes sign-in, and
 *  remember the answer for `agentHermesCodexAuthSeen`. */
export async function refreshAgentHermesCodexAuth(): Promise<boolean> {
  agentHermesAuthSeen = isAgentUserMode() ? await isAgentHermesCodexAuthPresent() : false
  return agentHermesAuthSeen
}

/** With agents on their own OS user: does that user hold a usable `openai-codex`
 *  login of its own? False with the setting off, or when the agent host is not
 *  running. */
export async function isAgentHermesCodexAuthPresent(): Promise<boolean> {
  try {
    const home = agentHermesHome()
    return home ? await hasUsableHermesCodexAuthIn(home) : false
  } catch {
    return false
  }
}
