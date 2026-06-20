// Production defaults — the single readable catalog of the values a fresh clawboo
// install runs with. Each entry carries a one-line justification.
//
// Design (validate-and-adapt): most subsystem defaults are already
// well-placed as env-overridable constants in their own packages (BREAKER_DEFAULTS
// in @clawboo/governance, the approval-reaper TTL/interval, the MCP probe interval,
// the worktree GC limits, etc.). Ripping those out into one module would invert the
// package dependency graph (a pure package cannot import an app module) for no gain.
// So this catalog OWNS the net-new server-level posture defaults this session
// introduces, and REFERENCES the package-local ones for visibility. The full table
// (with every package-local value + its env override) is recorded in the build ADR.

import { DEFAULT_ROTATION } from '@clawboo/executor'
import { BREAKER_DEFAULTS, SOFT_CAP_PERCENT } from '@clawboo/governance'

/** Budget enforcement posture. `track-and-warn` (the shipped default) records spend
 *  and warns at thresholds but never stops a run; `hard-cap` auto-pauses at 100%. */
export type BudgetPosture = 'track-and-warn' | 'hard-cap'

/** Net-new server-level production defaults this product ships. Consumed by the
 *  logger, the boot probe, the budget warn logic, and the System Health surface. */
export const DEFAULTS = {
  /** pino log level. `debug` is too noisy for a shipped product; ops can override
   *  per-process via the standard `LOG_LEVEL` env var (read in @clawboo/logger). */
  logLevel: 'info',

  /** Budgets ship as track-and-warn: nothing pauses an agent out of the box; spend
   *  is tracked + warned. A hard cap is an explicit per-install opt-in (Settings). */
  budgetPosture: 'track-and-warn' as BudgetPosture,

  /** No global hard cap by default → no auto-pause until a user sets a cap budget
   *  (per agent / team / global). null = uncapped (the common case). */
  budgetHardCapUsdCents: null as number | null,

  /** The crossing (% of a budget's limit) that emits the soft warning event.
   *  Mirrors the governance math's soft tier so the two never drift. */
  budgetWarnSoftPct: SOFT_CAP_PERCENT,

  /** Boot probe: a fast, tight timeout for the OPTIONAL OpenClaw Gateway
   *  reachability check. A miss marks the registry stale (degraded), never fatal —
   *  SQLite still serves the last-synced agents. */
  gatewayProbeTimeoutMs: 1500,

  /** Observability exporter is opt-in: the OTel SDK is lazy / no-op unless an
   *  `OTEL_EXPORTER_OTLP_ENDPOINT` is configured. The always-on local event log is
   *  the default trace store; no external collector is required. */
  otelEnabledByDefault: false,

  /** Memory auto-injection: at run start, the most-relevant facts for the task are
   *  injected into the prompt's cache-safe VOLATILE tier (bounded). Default-on; a
   *  task opts out via `disableMemoryAutoInject`. Char cap (≈ a few hundred tokens)
   *  so the seeded block never crowds out the actual instruction. */
  memoryAutoInjectMaxChars: 1500,

  /** Memory auto-injection: how many top-ranked facts to seed per run. */
  memoryAutoInjectTopK: 5,
} as const

/** Package-local defaults surfaced here for the single readable catalog. The
 *  runtime source of truth stays in each package; this is a reference, not a copy. */
export const REFERENCED_PACKAGE_DEFAULTS = {
  /** Tool-loop circuit-breaker thresholds (@clawboo/governance breaker). */
  circuitBreaker: BREAKER_DEFAULTS,
  /** Soft-cap percentage the budget math uses (@clawboo/governance budget). */
  budgetSoftCapPct: SOFT_CAP_PERCENT,
  /** Session-rotation watermark + chain cap (@clawboo/executor session-rotation).
   *  Rotate at 85% of the context window; ≤3 successor sessions per task. */
  sessionRotation: DEFAULT_ROTATION,
} as const

/**
 * Operational defaults that live as env-overridable module constants in their home
 * modules. Documented here (value + env var + home) for the single catalog and the
 * defaults drift-test; NOT the runtime source (the modules are). Mind the future
 * horizon: each is a per-process value today and would become per-tenant config in
 * a hosted multi-tenant world without changing the default chosen now.
 */
export const OPERATIONAL_DEFAULTS = {
  approvalTtlMs: {
    value: 24 * 60 * 60_000,
    env: 'CLAWBOO_APPROVAL_TTL_MS',
    home: 'approvalReaper.ts',
  },
  approvalReaperIntervalMs: {
    value: 60 * 60_000,
    env: 'CLAWBOO_APPROVAL_REAPER_INTERVAL_MS',
    home: 'approvalReaper.ts',
  },
  mcpProbeIntervalMs: { value: 60_000, env: 'CLAWBOO_MCP_PROBE_MS', home: 'mcpSupervisor.ts' },
  apiPortStart: { value: 18790, env: 'CLAWBOO_API_PORT_START', home: 'portUtils.ts' },
} as const
