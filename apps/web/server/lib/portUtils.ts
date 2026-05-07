// Port selection + runtime port file.
//
// Foolproof boot sequence:
//   1. Default port is 18790 (one above the OpenClaw Gateway's 18789, in the
//      18000-18999 range — uncommon for dev tooling, easy to remember).
//   2. If `CLAWBOO_API_PORT` env var is set we use that EXACT port (explicit
//      user choice — fail loudly if taken).
//   3. Otherwise scan upward from `CLAWBOO_API_PORT_START` (default 18790)
//      for the first free port, up to `MAX_PORT_ATTEMPTS` consecutive ports.
//   4. After a successful bind, the chosen port is written to a runtime
//      file (`<state-dir>/clawboo/api-port.txt`) so external tools (the
//      CLI, Vite proxy fallback, e2e fixtures) can discover it without
//      having to scan the network.
//
// This protects users from the canonical "port 3000 is already taken by
// some random Next.js app" failure mode.

import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

import { resolveStateDir } from '@clawboo/config'

/** First port to try when no explicit `CLAWBOO_API_PORT` is set. */
export const DEFAULT_API_PORT = 18790

/** Number of consecutive ports to scan starting from the default. */
export const MAX_PORT_ATTEMPTS = 20

/**
 * Path to the runtime "current port" file. Written by the server on
 * successful bind, read by the CLI / Vite proxy / e2e helpers. Lives
 * alongside the rest of the Clawboo state.
 */
export function getApiPortFilePath(): string {
  const stateDir = resolveStateDir(process.env)
  return path.join(stateDir, 'clawboo', 'api-port.txt')
}

/**
 * Returns true if the given TCP port can be bound on `0.0.0.0`. Uses an
 * ephemeral probe that immediately closes — no side effects. Resolves to
 * false on EADDRINUSE / EACCES / any other listen error.
 */
export function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.createServer()
    let settled = false
    const settle = (free: boolean) => {
      if (settled) return
      settled = true
      probe.removeAllListeners()
      // Best-effort close — already-failed probes don't need it.
      try {
        probe.close()
      } catch {
        /* ignore */
      }
      resolve(free)
    }
    probe.once('error', () => settle(false))
    probe.once('listening', () => settle(true))
    try {
      probe.listen(port, '0.0.0.0')
    } catch {
      settle(false)
    }
  })
}

/**
 * Scan for a free port starting at `start`, trying up to `attempts`
 * consecutive ports. Throws if none are free in the range.
 */
export async function findFreePort(
  start: number = DEFAULT_API_PORT,
  attempts: number = MAX_PORT_ATTEMPTS,
): Promise<number> {
  for (let i = 0; i < attempts; i++) {
    const port = start + i

    if (await isPortFree(port)) return port
  }
  throw new Error(
    `No free port available in range ${start}-${start + attempts - 1}. ` +
      `Set CLAWBOO_API_PORT to override, or free a port in this range.`,
  )
}

/**
 * Resolve which port to use based on env vars + auto-scan.
 *
 * - `CLAWBOO_API_PORT=N` → use N exactly (no fallback; throws if taken).
 * - `CLAWBOO_API_PORT_START=M` → start scanning from M.
 * - Otherwise scan from DEFAULT_API_PORT.
 *
 * The legacy `PORT` env var is honored only in production-style boots
 * (no `--dev`) and only when the explicit Clawboo overrides are absent;
 * this preserves compatibility with platforms (Heroku, Render, etc.)
 * that inject `PORT`.
 */
export interface ResolvePortOptions {
  /** Pass `true` when the server is starting via `tsx watch ... --dev`. */
  dev: boolean
}

export async function resolveApiPort(opts: ResolvePortOptions): Promise<number> {
  const explicit = readPortEnv('CLAWBOO_API_PORT')
  if (explicit !== null) {
    const free = await isPortFree(explicit)
    if (!free) {
      throw new Error(
        `CLAWBOO_API_PORT=${explicit} is already in use. ` +
          `Free that port, choose a different one, or unset CLAWBOO_API_PORT to auto-pick.`,
      )
    }
    return explicit
  }

  // Production boots (PORT=… on Heroku/Render/etc.) only honor PORT when
  // Clawboo overrides aren't set — keeps platform deploy compatibility.
  if (!opts.dev) {
    const platformPort = readPortEnv('PORT')
    if (platformPort !== null) {
      const free = await isPortFree(platformPort)
      if (!free) {
        throw new Error(`PORT=${platformPort} is already in use (set by hosting platform).`)
      }
      return platformPort
    }
  }

  const start = readPortEnv('CLAWBOO_API_PORT_START') ?? DEFAULT_API_PORT
  return findFreePort(start, MAX_PORT_ATTEMPTS)
}

function readPortEnv(name: string): number | null {
  const raw = process.env[name]?.trim()
  if (!raw) return null
  const port = Number(raw)
  if (!Number.isFinite(port) || port <= 0 || port > 65535) return null
  return port
}

/**
 * Write the runtime port file. Best-effort; errors are logged via the
 * caller-provided callback but never thrown — a missing file just means
 * downstream tools fall back to env vars / defaults.
 */
export function writeApiPortFile(port: number): void {
  const file = getApiPortFilePath()
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, String(port), 'utf8')
  } catch {
    // Non-fatal — the env var is still valid for in-process consumers.
  }
}

/** Best-effort cleanup of the runtime port file. */
export function removeApiPortFile(): void {
  try {
    fs.unlinkSync(getApiPortFilePath())
  } catch {
    /* file may not exist */
  }
}

/** Read the runtime port file. Returns null on any read / parse failure. */
export function readApiPortFile(): number | null {
  try {
    const raw = fs.readFileSync(getApiPortFilePath(), 'utf8').trim()
    const port = Number(raw)
    if (!Number.isFinite(port) || port <= 0 || port > 65535) return null
    return port
  } catch {
    return null
  }
}

/** Resolve home dir reliably even when env is sandboxed. */
export function resolveHomeDir(): string {
  return os.homedir()
}
