/**
 * apps/web/server/lib/updateCheck.ts
 *
 * Self-version awareness: what version of `clawboo` is running, what the
 * latest published version is, and whether an in-app update is even possible.
 *
 * WHY THE SERVER OWNS THIS (not a browser fetch to the registry):
 *   - Centralizes the registry probe + its cache in one place (mirrors
 *     `openclawDetect.ts` / `providerModels.ts`), so multiple browser tabs
 *     share one outbound call.
 *   - Avoids any registry-CORS dependency from the SPA.
 *   - The browser only ever sees a same-origin `/api/system/self-version`.
 *
 * FAIL-SILENT is a hard requirement (network posture): clawboo is a local-first
 * tool. When the registry is unreachable (offline, air-gapped, firewalled) the
 * probe returns null and `updateAvailable` is false — never an error, never a nag.
 *
 * This module is pure version/HTTP logic — no process control. The restart
 * primitive that an in-app update needs lives in `selfRestart.ts`.
 */
import fs from 'node:fs'
import path from 'node:path'

// ─── Current (running) version ────────────────────────────────────────────────

/**
 * Candidate paths for the shipped `clawboo` package.json. In the bundled server,
 * `dist/server.js` runs with its dir one level under the package root, so
 * `<dir>/../package.json` is the clawboo manifest (npm always ships package.json
 * in the tarball). We try the running entry's dir first (robust for a global
 * install replaced in place), then `__dirname`.
 */
function packageJsonCandidates(): string[] {
  const out: string[] = []
  const entry = process.argv[1]
  if (entry) out.push(path.join(path.dirname(entry), '..', 'package.json'))
  // In the bundled server, `__dirname` is the dist dir (same place server.js
  // lives), so `../package.json` is the package root — identical to the entry
  // path above. In dev (tsx) this resolves to apps/web/package.json, whose
  // `name` is `@clawboo/web` (not `clawboo`), so the name guard below skips it.
  out.push(path.join(__dirname, '..', 'package.json'))
  return out
}

/**
 * Read the `clawboo` package version straight from disk. Prefers the shipped
 * manifest so it is always FRESH after a self-update (an env var injected at
 * first launch would be stale in the restarted successor). The `name` guard
 * ensures we never mistake apps/web/package.json (0.0.0) for the release.
 */
export function readVersionFromDisk(): string | null {
  for (const p of packageJsonCandidates()) {
    try {
      const pkg = JSON.parse(fs.readFileSync(p, 'utf8')) as { name?: string; version?: string }
      if (pkg.name === 'clawboo' && typeof pkg.version === 'string' && pkg.version.trim()) {
        return pkg.version.trim()
      }
    } catch {
      // not found / unparsable — try the next candidate
    }
  }
  return null
}

/**
 * The running clawboo version. `CLAWBOO_VERSION` (injected by the CLI at launch)
 * is the fast path; the on-disk manifest is the fallback AND the source of truth
 * after a self-update (the successor is started WITHOUT the stale env var so it
 * recomputes from the freshly-installed package.json).
 */
export function getCurrentVersion(): string {
  const fromEnv = (process.env['CLAWBOO_VERSION'] ?? '').trim()
  if (fromEnv) return fromEnv
  return readVersionFromDisk() ?? '0.0.0-dev'
}

// ─── Install method (drives whether in-app apply is possible) ──────────────────

export type InstallMethod = 'global' | 'npx' | 'dev'

/**
 * How this server was launched — determines whether an in-app `npm install -g`
 * + self-restart can actually pick up the new bytes:
 *   - `global`: `npm install -g clawboo` → `dist/server.js` is replaced in place
 *     at the same path, so restarting into `process.argv[1]` runs the NEW code. ✅
 *   - `npx`: the entry lives in npm's version-hashed `_npx` cache; a global
 *     install lands elsewhere and the running process can't reach it. ✗
 *   - `dev`: running the TS source via tsx — never self-update a checkout. ✗
 */
export function detectInstallMethod(): InstallMethod {
  const entry = (process.argv[1] ?? __filename).replace(/\\/g, '/')
  if (entry.includes('/_npx/')) return 'npx'
  // The bundled server always runs from `.../dist/server.js`. Anything else
  // (e.g. `apps/web/server/index.ts` under tsx) is a dev checkout.
  if (!/\/dist\/server\.js$/.test(entry)) return 'dev'
  return 'global'
}

/** The exact command a user runs to update, tailored to their install shape. */
export function buildUpdateCommand(method: InstallMethod): string {
  return method === 'npx' ? 'npx clawboo@latest' : 'npm install -g clawboo@latest'
}

// ─── Latest published version (npm registry probe) ─────────────────────────────

const REGISTRY_LATEST_URL = 'https://registry.npmjs.org/clawboo/latest'
const FETCH_TIMEOUT_MS = 5_000
// The registry value changes over time (unlike a local binary version), so it
// carries a real TTL. 6h keeps outbound calls rare for a long-lived dashboard
// while still surfacing a fresh release within a working day.
const LATEST_CACHE_TTL_MS = 6 * 60 * 60 * 1000

let latestCache: { version: string; fetchedAt: number } | null = null

/**
 * Probe the npm registry for the latest published `clawboo` version. Cached
 * (~6h), timeout-bounded, and NEVER throws — a failure returns the last cached
 * value (or null), so an offline/air-gapped install is a silent no-op. Modeled
 * on `openclawDetect.ts` (cache successes, never cache/propagate a failure).
 */
export async function fetchLatestClawbooVersion(now: number = Date.now()): Promise<string | null> {
  if (latestCache && now - latestCache.fetchedAt < LATEST_CACHE_TTL_MS) {
    return latestCache.version
  }
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
    const res = await fetch(REGISTRY_LATEST_URL, {
      signal: controller.signal,
      headers: { Accept: 'application/json', 'User-Agent': 'clawboo-update-check' },
    })
    clearTimeout(timer)
    if (!res.ok) return latestCache?.version ?? null
    const body = (await res.json()) as { version?: unknown }
    if (typeof body.version !== 'string' || !body.version.trim()) {
      return latestCache?.version ?? null
    }
    latestCache = { version: body.version.trim(), fetchedAt: now }
    return latestCache.version
  } catch {
    // offline / registry down / firewalled — fail silent, keep any cache
    return latestCache?.version ?? null
  }
}

/** Drop the latest-version cache (tests + a forced re-check). */
export function invalidateLatestCache(): void {
  latestCache = null
}

// ─── Semver compare (release-focused) ─────────────────────────────────────────

function parseSemver(v: string): { core: [number, number, number]; pre: string } | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(v.trim())
  if (!m) return null
  return { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ?? '' }
}

/**
 * `a > b`? Compares major.minor.patch, then treats a release (`1.0.0`) as
 * greater than a prerelease of the same core (`1.0.0-beta`). Coarse prerelease
 * ordering is fine — the update target (`dist-tags.latest`) is always a release.
 */
export function semverGt(a: string, b: string): boolean {
  const pa = parseSemver(a)
  const pb = parseSemver(b)
  if (!pa || !pb) return false
  for (let i = 0; i < 3; i++) {
    if (pa.core[i] !== pb.core[i]) return pa.core[i] > pb.core[i]
  }
  if (pa.pre === pb.pre) return false
  if (pa.pre === '') return true // a is a release, b is a prerelease of the same core
  if (pb.pre === '') return false // b is the release → a (prerelease) is lower
  return pa.pre > pb.pre
}

// ─── Assembled endpoint payload ───────────────────────────────────────────────

export interface SelfVersionInfo {
  /** The running clawboo version (e.g. "0.3.0"), or "0.0.0-dev" in a checkout. */
  current: string
  /** Latest published version, or null when the registry is unreachable. */
  latest: string | null
  /** True only for a real (non-dev) current with a strictly-greater latest. */
  updateAvailable: boolean
  /** The exact command for THIS install shape (npm -g / npx). */
  updateCommand: string
  installMethod: InstallMethod
  /** Whether an in-app apply (`POST /api/system/self-update`) can succeed. */
  applyable: boolean
  /** The current version is on the npm-deprecated 0.1.x line. */
  isDeprecated: boolean
  /** When `latest` was last fetched (ms), or null if never/unreachable. */
  checkedAt: number | null
}

export async function computeSelfVersion(): Promise<SelfVersionInfo> {
  const current = getCurrentVersion()
  const latest = await fetchLatestClawbooVersion()
  const method = detectInstallMethod()
  // A dev checkout reads as "0.0.0*"; never nag a developer about updates.
  const isRealVersion = !current.startsWith('0.0.0')
  const updateAvailable = isRealVersion && latest != null && semverGt(latest, current)
  return {
    current,
    latest,
    updateAvailable,
    updateCommand: buildUpdateCommand(method),
    installMethod: method,
    applyable: method === 'global',
    isDeprecated: /^0\.1\./.test(current),
    checkedAt: latestCache?.fetchedAt ?? null,
  }
}
