// Provisioning for a Hermes home dir. With a STABLE per-identity home the
// runtime's native state — sessions, MEMORY.md, state.db (FTS5 recall), and
// self-created skills/ — persists and COMPOUNDS across runs, which is the whole
// point of driving Hermes as a preserved runtime (the preserved-runtime adapter
// model: drive one-shot, never lobotomize).
//
// INVARIANTS:
// - clawboo NEVER writes into the user's real ~/.hermes (read/copy-from only).
// - Inside a clawboo-owned home, clawboo performs exactly THREE writes:
//   `mcp.json` (clawboo-owned, refreshed every run), a ONE-TIME `config.yaml`
//   seed copy (never overwritten, never written back), and a FRESHNESS-GATED
//   `auth.json` seed copy (the ChatGPT-subscription OAuth — see seedHermesAuth).
//   Everything else in the home belongs to Hermes itself.

import { chmod, copyFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { hasUsableHermesCodexAuth, userHermesAuthPath } from './hermesAuth'

export function userHermesConfigPath(): string {
  return path.join(os.homedir(), '.hermes', 'config.yaml')
}

export interface ProvisionedHermesHome {
  home: string
  /** True when this provision created the dir. A fresh home cannot hold any
   *  prior session, so `--resume` is skipped for this run. */
  created: boolean
  /** True when config.yaml was seed-copied from the user's ~/.hermes this run. */
  seededConfig: boolean
  /** True when auth.json was seed-copied from the user's ~/.hermes this run. */
  seededAuth: boolean
}

/**
 * Seed the user's `hermes login` auth store into the managed home. Copy-only —
 * NEVER writes back to `~/.hermes`. Mirrors `seedCodexAuth` (codexDriver.ts):
 * for a persistent managed home this is a FRESHNESS DECISION — hermes refreshes
 * (and on terminal failure quarantines) tokens inside the managed home's own
 * auth.json, so the user's copy only replaces it when the user's file is NEWER
 * (a re-login) or the managed one is missing/unusable. A blind re-copy would
 * replay an already-consumed refresh token. Rotation hazard, documented: every
 * home seeded from one login is another rotator on that grant family — the
 * surfaced auth path is a FRESH `hermes auth add openai-codex` (never
 * the codex-CLI import) precisely to keep lineages narrow. Best-effort: never
 * throws. Exported for tests.
 */
export async function seedHermesAuth(home: string): Promise<boolean> {
  try {
    const src = userHermesAuthPath()
    if (!existsSync(src)) return false
    const dst = path.join(home, 'auth.json')
    if (existsSync(dst) && hasUsableHermesCodexAuth(dst)) {
      const [srcStat, dstStat] = await Promise.all([stat(src), stat(dst)])
      if (srcStat.mtimeMs <= dstStat.mtimeMs) return false // managed token is as fresh or fresher
    }
    await copyFile(src, dst)
    await chmod(dst, 0o600).catch(() => undefined) // owner-only (no-op on Windows)
    return true
  } catch {
    return false // best-effort — auth seeding is not fatal to provisioning
  }
}

export async function provisionHermesHome(
  home: string,
  opts: { mcpJson?: string | null } = {},
): Promise<ProvisionedHermesHome> {
  const created = !existsSync(home)
  await mkdir(home, { recursive: true, mode: 0o700 })

  // Seed config.yaml from the user's real ~/.hermes — copy-if-absent (so a user
  // who configures Hermes AFTER first provision is picked up on the next run),
  // NEVER overwrite, NEVER write back. `.env` is NOT seeded: provider keys ride
  // the spawned process env (the credential vault is the source of truth) and
  // copying credentials would multiply secret surfaces on disk.
  let seededConfig = false
  const seedTarget = path.join(home, 'config.yaml')
  if (!existsSync(seedTarget) && existsSync(userHermesConfigPath())) {
    try {
      await copyFile(userHermesConfigPath(), seedTarget)
      await chmod(seedTarget, 0o600).catch(() => undefined) // owner-only (no-op on Windows)
      seededConfig = true
    } catch {
      // Seeding is best-effort; Hermes falls back to its built-in defaults.
    }
  }

  // Seed the ChatGPT-subscription auth (freshness-gated; see seedHermesAuth).
  // A managed home outside ~/.hermes is its OWN hermes root (no global-auth
  // fallback), so without this copy the user's `hermes login` is invisible to
  // spawned runs and an `openai-codex` pick would fail auth.
  const seededAuth = await seedHermesAuth(home)

  // mcp.json is clawboo-OWNED: refreshed every run (the server port can change
  // across restarts) and removed when there is no MCP base URL so a stale
  // attach config never lingers.
  const mcpPath = path.join(home, 'mcp.json')
  if (opts.mcpJson) await writeFile(mcpPath, opts.mcpJson, { encoding: 'utf8', mode: 0o600 })
  else await rm(mcpPath, { force: true })

  return { home, created, seededConfig, seededAuth }
}

/**
 * Read the configured provider from `<home>/config.yaml`. Per the Hermes CLI,
 * the persistent provider lives under the `model:` block's `provider:` key — a
 * block-scoped line scan (no YAML dep) so the top-level `providers:` map (the
 * user-defined provider definitions) can never false-positive.
 */
export async function detectProvider(home: string): Promise<string | null> {
  let body: string
  try {
    body = await readFile(path.join(home, 'config.yaml'), 'utf8')
  } catch {
    return null
  }
  let inModelBlock = false
  for (const line of body.split('\n')) {
    if (/^\S/.test(line)) {
      inModelBlock = /^model\s*:/.test(line)
      continue
    }
    if (!inModelBlock) continue
    const m = /^\s+provider\s*:\s*['"]?([A-Za-z0-9._-]+)['"]?\s*(?:#.*)?$/.exec(line)
    if (m?.[1]) return m[1]
  }
  return null
}
