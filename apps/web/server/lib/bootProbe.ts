// Boot probe — a fresh-install health check that runs on every server start and
// from the System Health surface. It reports a structured BootReport: what the
// server resolved (state dir, db path, port), and a per-check pass/degrade/fatal
// verdict for each foundation (clawboo home writable, vault perms, master-key
// round-trip, SQLite integrity + schema, the api-port file, the in-process MCP
// servers, the optional OpenClaw Gateway, the optional OTel exporter).
//
// Philosophy: almost everything DEGRADES (the server keeps running, the UI shows a
// banner) rather than being fatal. Only two failures are fatal — the clawboo home
// is not writable, or the SQLite file fails its integrity check — because nothing
// works without them. There are NO migration / upgrade paths: a fatal boot means
// the install is broken; the user-facing remedy is to reset ~/.clawboo and re-run
// the onboarding wizard (the System Health view says so).

import { accessSync, constants as fsConstants, existsSync, mkdirSync, statSync } from 'node:fs'

import { resolveClawbooDir, loadSettings } from '@clawboo/config'
import { createDb, integrityCheck, listTableNames, type ClawbooDb } from '@clawboo/db'
import { getProxyDeviceIdentityPath } from '@clawboo/gateway-proxy'
import { MCP_SERVER_NAMES } from '@clawboo/mcp'

import { getRegistry } from './agentSource'
import { getDbPath } from './db'
import { DEFAULTS } from './defaults'
import { probeMcpServer } from './mcpSupervisor'
import { otlpConfigured } from './obs/obsFlags'
import { getObsTracer, initOtel } from './obs/otel'
import { readApiPortFile } from './portUtils'
import { getRuntimeSecret, getVaultPaths, hasRuntimeSecret, setRuntimeSecret } from './secretsVault'

export interface BootCheck {
  id: string
  ok: boolean
  /** Short, user-friendly status. */
  message: string
  /** Optional multi-line detail for the diagnostics surface. */
  detail?: string
  durationMs: number
}

/** The shipped production-defaults posture, surfaced on the diagnostics surface so a
 *  user (or a bug report) can see what this install runs with. Sourced from
 *  DEFAULTS — see apps/web/server/lib/defaults.ts. */
export interface BootConfig {
  logLevel: string
  budgetPosture: string
  budgetHardCapUsdCents: number | null
  budgetWarnSoftPct: number
  otelEnabledByDefault: boolean
  /** Whether an OTLP endpoint is actually configured this boot (vs the default). */
  otelActive: boolean
}

export interface BootReport {
  startedAt: Date
  finishedAt: Date
  checks: BootCheck[]
  /** Check ids that failed but the server can still run (the common case). */
  degraded: string[]
  /** Check ids that prevent a working server (rare: home not writable, DB corrupt). */
  fatal: string[]
  config: BootConfig
  resolved: {
    clawbooHome: string
    dbPath: string
    apiPort: number | null
    stateDir: string
    vaultPresent: boolean
    masterKeyOk: boolean
  }
}

// Only these two failing modes are fatal; every other check degrades.
const FATAL_IDS = new Set(['clawbooHomeWritable', 'databaseIntegrity'])

// A core subset of the bootstrap schema; their absence means the DDL never ran.
const CORE_TABLES = ['teams', 'agents', 'settings', 'budgets', 'orchestration_events', 'tasks']

// The boot-sentinel: a fixed value encrypted into the vault on first boot, decrypted
// on every subsequent boot to prove the master key still works (a rotated/lost key
// fails closed → the user must re-enter runtime keys).
const SENTINEL_KEY = '__clawboo_boot_sentinel__'
const SENTINEL_VALUE = 'clawboo-boot-sentinel-v1'

interface CheckOutcome {
  ok: boolean
  message: string
  detail?: string
}

let lastReport: BootReport | null = null
let inFlight: Promise<BootReport> | null = null

/** The most recent BootReport (set by every runBootProbe call). */
export function getLastBootReport(): BootReport | null {
  return lastReport
}

/** Run the boot probe, de-duping concurrent calls — if a probe is already running
 *  (e.g. two `/api/health` requests race before the first completes), share the one
 *  promise so the (potentially slow) integrity check / probes run at most once. */
export function runBootProbe(input: { port?: number } = {}): Promise<BootReport> {
  if (inFlight) return inFlight
  inFlight = runBootProbeInner(input).finally(() => {
    inFlight = null
  })
  return inFlight
}

async function runCheck(
  id: string,
  fn: () => Promise<CheckOutcome> | CheckOutcome,
): Promise<BootCheck> {
  const start = Date.now()
  try {
    const r = await fn()
    return { id, ok: r.ok, message: r.message, detail: r.detail, durationMs: Date.now() - start }
  } catch (err) {
    return {
      id,
      ok: false,
      message: `${id} check failed`,
      detail: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - start,
    }
  }
}

function checkHomeWritable(clawbooHome: string): CheckOutcome {
  mkdirSync(clawbooHome, { recursive: true })
  accessSync(clawbooHome, fsConstants.W_OK)
  return { ok: true, message: `clawboo home is writable`, detail: clawbooHome }
}

function checkVaultPerms(): CheckOutcome {
  const { dir, masterKey } = getVaultPaths()
  // The proxy device identity holds an Ed25519 PRIVATE key; it lives at the clawboo
  // root (not under secrets/) so it's checked independently of the vault dir.
  const identityFile = getProxyDeviceIdentityPath()
  const anyPresent = existsSync(dir) || existsSync(identityFile)
  if (!anyPresent) {
    return { ok: true, message: 'secrets vault not yet created (fresh install)' }
  }
  // POSIX permission modes are advisory on Windows; only assert where they apply.
  if (process.platform === 'win32') {
    return { ok: true, message: 'secrets present (perms not enforced on this platform)' }
  }
  const problems: string[] = []
  if (existsSync(dir)) {
    const dirMode = statSync(dir).mode & 0o777
    if (dirMode !== 0o700) problems.push(`secrets/ is ${dirMode.toString(8)} (expected 700)`)
    if (existsSync(masterKey)) {
      const keyMode = statSync(masterKey).mode & 0o777
      if (keyMode !== 0o600) problems.push(`master.key is ${keyMode.toString(8)} (expected 600)`)
    }
  }
  if (existsSync(identityFile)) {
    const idMode = statSync(identityFile).mode & 0o777
    if (idMode !== 0o600) {
      problems.push(`proxy-device-identity.json is ${idMode.toString(8)} (expected 600)`)
    }
  }
  if (problems.length > 0) {
    return {
      ok: false,
      message: 'secret-file permissions are too open',
      detail: problems.join('; '),
    }
  }
  return { ok: true, message: 'secret-file permissions are correct (700/600)' }
}

function checkMasterKeySentinel(): { outcome: CheckOutcome; masterKeyOk: boolean } {
  try {
    if (!hasRuntimeSecret(SENTINEL_KEY)) {
      setRuntimeSecret(SENTINEL_KEY, SENTINEL_VALUE)
      return {
        outcome: { ok: true, message: 'master key initialized (boot sentinel written)' },
        masterKeyOk: true,
      }
    }
    const got = getRuntimeSecret(SENTINEL_KEY)
    if (got === SENTINEL_VALUE) {
      return {
        outcome: { ok: true, message: 'master key verified (boot sentinel decrypts)' },
        masterKeyOk: true,
      }
    }
    return {
      outcome: {
        ok: false,
        message: 'master key changed — saved runtime keys cannot be decrypted',
        detail:
          'Re-enter your runtime provider keys in the Runtimes panel, or reset ~/.clawboo for a clean start.',
      },
      masterKeyOk: false,
    }
  } catch (err) {
    return {
      outcome: {
        ok: false,
        message: 'secrets vault is unreadable',
        detail: err instanceof Error ? err.message : String(err),
      },
      masterKeyOk: false,
    }
  }
}

function checkGatewayProbeTimeoutMs(): number {
  return DEFAULTS.gatewayProbeTimeoutMs
}

async function probeGatewayConnection(): Promise<CheckOutcome> {
  const settings = loadSettings(process.env)
  if (!settings.gatewayUrl) {
    return { ok: true, message: 'OpenClaw Gateway not configured (skipped)' }
  }
  const timeoutMs = checkGatewayProbeTimeoutMs()
  const health = await Promise.race([
    // .catch() so a late health() rejection (after the timeout wins the race) can
    // never surface as an unhandled rejection.
    getRegistry()
      .source.health()
      .catch(() => ({ connection: 'error' })),
    new Promise<{ connection: string }>((resolve) =>
      setTimeout(() => resolve({ connection: 'timeout' }), timeoutMs).unref(),
    ),
  ])
  if (health.connection === 'connected') {
    return { ok: true, message: 'OpenClaw Gateway reachable + synced' }
  }
  return {
    ok: false,
    message: `OpenClaw Gateway not reachable (${health.connection}) — serving last-synced agents from SQLite`,
    detail: settings.gatewayUrl,
  }
}

async function probeOtel(): Promise<CheckOutcome> {
  if (!otlpConfigured()) {
    return { ok: true, message: 'OTel exporter disabled (no endpoint configured)' }
  }
  await initOtel()
  if (getObsTracer() !== null) {
    return { ok: true, message: 'OTel exporter initialized' }
  }
  return {
    ok: false,
    message:
      'OTel endpoint configured but the exporter failed to initialize — tracing falls back to the local event log',
  }
}

/** Run the full boot probe. `port` is the actual listening port (for the api-port
 *  file match check); omit it to skip that check (e.g. when probing pre-listen). */
async function runBootProbeInner(input: { port?: number } = {}): Promise<BootReport> {
  const startedAt = new Date()
  const clawbooHome = resolveClawbooDir(process.env)
  const dbPath = getDbPath()
  let stateDir = ''
  try {
    stateDir = (await import('@clawboo/config')).resolveStateDir(process.env)
  } catch {
    /* interop dir resolution is best-effort */
  }

  const checks: BootCheck[] = []

  // 1. clawboo home writable (FATAL if not).
  checks.push(await runCheck('clawbooHomeWritable', () => checkHomeWritable(clawbooHome)))

  // 2. vault perms.
  checks.push(await runCheck('vaultPerms', () => checkVaultPerms()))

  // 3. master-key boot sentinel round-trip.
  const sentinel = checkMasterKeySentinel()
  checks.push(await runCheck('masterKeyBootSentinel', () => sentinel.outcome))

  // 4 + 5. SQLite integrity + schema (share one handle).
  let db: ClawbooDb | null = null
  let dbOpenError: string | null = null
  try {
    db = createDb(dbPath)
  } catch (err) {
    dbOpenError = err instanceof Error ? err.message : String(err)
  }
  checks.push(
    await runCheck('databaseIntegrity', () => {
      if (!db)
        return {
          ok: false,
          message: 'SQLite database could not be opened',
          detail: dbOpenError ?? '',
        }
      const verdict = integrityCheck(db)
      return verdict === 'ok'
        ? { ok: true, message: 'SQLite integrity check passed', detail: dbPath }
        : {
            ok: false,
            message: 'SQLite integrity check FAILED',
            detail: `PRAGMA integrity_check: ${verdict}`,
          }
    }),
  )
  checks.push(
    await runCheck('databaseSchema', () => {
      if (!db) return { ok: false, message: 'SQLite database unavailable (schema not checked)' }
      const present = new Set(listTableNames(db))
      const missing = CORE_TABLES.filter((t) => !present.has(t))
      return missing.length === 0
        ? { ok: true, message: `schema bootstrapped (${present.size} tables)` }
        : { ok: false, message: 'core tables missing', detail: `missing: ${missing.join(', ')}` }
    }),
  )

  // 6. api-port file matches the actual port.
  checks.push(
    await runCheck('apiPortFileMatches', () => {
      if (input.port == null)
        return { ok: true, message: 'port file check skipped (no port supplied)' }
      const onDisk = readApiPortFile()
      return onDisk === input.port
        ? { ok: true, message: `api-port file matches (${input.port})` }
        : {
            ok: false,
            message: `api-port file is ${onDisk ?? 'absent'}, server is on ${input.port}`,
          }
    }),
  )

  // 7. in-process MCP servers healthy. NOTE: this is a CONSTRUCTABILITY +
  // tools/list round-trip check — `probeMcpServer` builds a FRESH server instance
  // per probe (over the same DB), not the cached HTTP singleton that real attaches
  // consume. It proves the server can be built and answers a request; it is not a
  // liveness probe of the pre-warmed singleton (a deliberate, low-cost choice).
  checks.push(
    await runCheck('mcpServersHealthy', async () => {
      if (!db) return { ok: false, message: 'MCP servers not probed (database unavailable)' }
      const results = await Promise.all(
        MCP_SERVER_NAMES.map(async (name) => {
          try {
            const tools = await probeMcpServer(db as ClawbooDb, name)
            return { name, ok: tools > 0, tools }
          } catch (err) {
            return { name, ok: false, error: err instanceof Error ? err.message : String(err) }
          }
        }),
      )
      const failed = results.filter((r) => !r.ok)
      return failed.length === 0
        ? { ok: true, message: `MCP servers healthy (${MCP_SERVER_NAMES.join(', ')})` }
        : {
            ok: false,
            message: 'one or more MCP servers unhealthy',
            detail: JSON.stringify(failed),
          }
    }),
  )

  // 8. OpenClaw Gateway reachability (degrade → stale).
  checks.push(await runCheck('openclawGatewayReachable', () => probeGatewayConnection()))

  // 9. OTel exporter (only when configured).
  checks.push(await runCheck('otelExporterReachable', () => probeOtel()))

  const degraded = checks.filter((c) => !c.ok && !FATAL_IDS.has(c.id)).map((c) => c.id)
  const fatal = checks.filter((c) => !c.ok && FATAL_IDS.has(c.id)).map((c) => c.id)

  const report: BootReport = {
    startedAt,
    finishedAt: new Date(),
    checks,
    degraded,
    fatal,
    config: {
      logLevel: DEFAULTS.logLevel,
      budgetPosture: DEFAULTS.budgetPosture,
      budgetHardCapUsdCents: DEFAULTS.budgetHardCapUsdCents,
      budgetWarnSoftPct: DEFAULTS.budgetWarnSoftPct,
      otelEnabledByDefault: DEFAULTS.otelEnabledByDefault,
      otelActive: otlpConfigured(),
    },
    resolved: {
      clawbooHome,
      dbPath,
      apiPort: input.port ?? null,
      stateDir,
      vaultPresent: existsSync(getVaultPaths().vault),
      masterKeyOk: sentinel.masterKeyOk,
    },
  }
  lastReport = report
  return report
}
