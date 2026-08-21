---
title: Production defaults & posture
description: 'The values a fresh Clawboo install runs with: log level, budget posture, breaker thresholds, reaper TTLs, each justified, with override env vars.'
---

This page is the operator's reference for the values a fresh Clawboo install runs with out of the box, and why each was chosen. Clawboo is designed to be a first-impression product, not a lab harness: nothing throttles or pauses an agent until you opt in, observability is local-only unless you point it at a collector, and the safety backstops are tuned so a healthy run never trips one.

The defaults live in two kinds of place. The net-new, server-level posture values (log level, budget posture, the gateway-probe timeout, OTel) are owned by a single readable catalog, `apps/web/server/lib/defaults.ts`. The subsystem-specific thresholds (circuit breakers, reaper TTLs, the worktree GC limits) stay as env-overridable constants in the packages that own them; `defaults.ts` references them for visibility rather than copying them, because a pure package cannot import an app module. Both kinds are documented below.

<Note>
Every value here is a per-process default today. Each is also the seam where a future hosted, multi-tenant deployment would read per-tenant config, without changing the default chosen now.
</Note>

## At a glance

The server-level posture defaults (from `defaults.ts`):

| Default                  | Value            | Why                                                               | Override                            |
| ------------------------ | ---------------- | ----------------------------------------------------------------- | ----------------------------------- |
| Log level                | `info`           | `debug` is too noisy for a shipped product                        | `LOG_LEVEL`                         |
| Budget posture           | `track-and-warn` | Nothing pauses an agent out of the box; spend is tracked + warned | Settings (per-budget `mode`)        |
| Global hard cap          | none (`null`)    | No auto-pause until a user sets a cap budget                      | Settings (create a `cap` budget)    |
| Budget warn threshold    | `80%`            | The soft-warning crossing; mirrors the governance math            | (fixed; shared constant)            |
| Gateway probe timeout    | `1500 ms`        | Fast, tight; a miss marks the registry stale, never fatal         | (fixed constant)                    |
| OTel exporter            | off              | Local event log is the default trace store; no collector required | `OTEL_EXPORTER_OTLP_ENDPOINT`       |
| Memory auto-inject cap   | `1500` chars     | Seeded facts never crowd out the actual instruction               | `disableMemoryAutoInject` (per-run) |
| Memory auto-inject top-K | `5` facts        | Top-ranked facts seeded into the volatile tier per run            | (per-run request field)             |

The referenced package-local defaults (the safety backstops and housekeeping timers):

| Default                                  | Value                   | Why                                                         | Override                              |
| ---------------------------------------- | ----------------------- | ----------------------------------------------------------- | ------------------------------------- |
| Breaker: max tool iterations             | `30`                    | Hard ceiling on settled tool-calls per run                  | `breakerConfig` (per-run)             |
| Breaker: repeat-failure threshold        | `3`                     | Consecutive identical-tool failures before halt             | `breakerConfig` (per-run)             |
| Breaker: no-progress threshold           | `6`                     | Consecutive results with no new output before halt          | `breakerConfig` (per-run)             |
| Breaker: token-velocity ceiling          | `200000` tok/min        | Only egregious runaways trip it                             | `breakerConfig` (per-run)             |
| Breaker: velocity min window             | `15000 ms`              | An early burst can't false-trip a short run                 | `breakerConfig` (per-run)             |
| Breaker: repeat-policy-denied threshold  | `2`                     | Consecutive identical denial codes before halt              | `breakerConfig` (per-run)             |
| Session rotation watermark               | `85%` of context window | Rotate to a fresh session before exhausting context         | `maxRotations` (per-run)              |
| Session rotation chain cap               | `3` successors          | Bounds the successor chain per task                         | `maxRotations` (per-run)              |
| Approval TTL                             | `86400000 ms` (24 h)    | Abandoned pending approvals auto-expire                     | `CLAWBOO_APPROVAL_TTL_MS`             |
| Approval reaper interval                 | `3600000 ms` (1 h)      | How often the reaper sweeps                                 | `CLAWBOO_APPROVAL_REAPER_INTERVAL_MS` |
| MCP probe interval                       | `60000 ms`              | MCP liveness health-probe cadence                           | `CLAWBOO_MCP_PROBE_MS`                |
| Worktree GC age                          | `72 h`                  | Reap worktrees older than this (if their task isn't locked) | (fixed constant)                      |
| Worktree GC max count                    | `25`                    | Reap oldest beyond this count                               | (fixed constant)                      |
| Board stale-task TTL                     | `180000 ms` (3 min)     | Six missed 30 s heartbeats: the owning drain is gone        | `CLAWBOO_BOARD_STALE_TTL_MS`          |
| Board stale sweep interval               | `60000 ms` (60 s)       | How often the sweep runs                                    | `CLAWBOO_BOARD_STALE_SWEEP_MS`        |
| Board capped create: children per parent | `24`                    | Bounds an agent looping on raw board creation               | (fixed constant)                      |
| Board capped create: nesting depth       | `2`                     | The same ancestor-chain ceiling as the delegation depth cap | (fixed constant)                      |
| Board capped create: root rate           | `30 / 5 min`            | Bounds an agent looping on parentless `create_task`         | (fixed constant)                      |

<Tip>
Per-run overrides (`breakerConfig`, `maxRotations`, `disableMemoryAutoInject`) are fields on the `POST /api/runtimes/:id/run` body. Process-level overrides are env vars; see [Environment variables](/reference/environment-variables).
</Tip>

## Logging

**`logLevel: 'info'`.** The pino logger ships at `info`. `debug` is too verbose to be a sensible default for a shipped product. Override per process with the standard `LOG_LEVEL` env var, which `@clawboo/logger` reads once at module-eval time (guarded so a browser import never touches `process.env`).

## Budget posture, track-and-warn, hard cap is opt-in

This is the load-bearing posture decision. **Budgets ship as `track-and-warn`.** Out of the box, nothing pauses an agent on spend. Cost is recorded and a warning event is emitted when a budget crosses a threshold, but the run continues. There is no global hard cap (`budgetHardCapUsdCents` is `null`), so until you create a `cap` budget for an agent, team, or globally, no spend ceiling is enforced.

The two budget modes behave differently inside the executor's per-cost-event check:

| Mode             | At 80% (soft)                   | At 100% (hard)                                                                  |
| ---------------- | ------------------------------- | ------------------------------------------------------------------------------- |
| `warn` (default) | Emit a soft-warning audit event | Emit a hard-warning event; run **continues** (status clamps away from `paused`) |
| `cap` (opt-in)   | Emit a soft-warning audit event | Auto-pause the budget; the executor aborts the run and releases the task        |

A new budget created without an explicit `mode` defaults to `warn`. Only a `cap` budget's 100% crossing trips the kill-switch; the executor checks `status === 'paused' && mode === 'cap'` per scope (agent, mission, team) and stops on the first paused cap. The `80%` soft-warning threshold (`budgetWarnSoftPct`) is shared with the governance budget math so the two never drift.

<Note>
"Track-and-warn by default" means a fresh install will not surprise you by halting an agent. To enforce a spend ceiling, create a `cap`-mode budget in the Governance dashboard. See [governance](/concepts/governance) for the kill-switch, caps, and approval mechanics.
</Note>

## Observability, local-first, exporter opt-in

**`otelEnabledByDefault: false`.** Clawboo's always-on local event log is the default trace store; no external collector is required to get traces, fleet health, or the Ghost-Graph projection. The OpenTelemetry SDK is lazy-imported and stays a no-op unless `OTEL_EXPORTER_OTLP_ENDPOINT` (or `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`) is set. A no-collector boot never even requires the `@opentelemetry/*` packages. Point the env var at a Jaeger/OTLP collector to bridge the local log to your tracing stack.

## Gateway probe timeout

**`gatewayProbeTimeoutMs: 1500`.** The boot probe checks whether the OpenClaw Gateway is reachable with a tight 1.5-second timeout. The check is optional: a miss marks the agent registry **stale** (degraded), never fatal; SQLite still serves the last-synced agents, so the dashboard renders fine with the Gateway down. This is a fixed constant (no env override); see [System Health](/using/system-health) for how degraded checks surface.

## Memory auto-injection

At run start, the executor seeds the most-relevant memory facts for the task into the prompt's cache-safe volatile tier. **`memoryAutoInjectMaxChars: 1500`** bounds the seeded block (≈ a few hundred tokens) so it never crowds out the actual instruction, and **`memoryAutoInjectTopK: 5`** caps how many top-ranked facts are seeded. Auto-injection is on by default; a single run opts out with `disableMemoryAutoInject` on its run request. See [memory](/concepts/memory) for the shared/private memory tiers.

## Circuit breakers, the no-progress backstop

The tool-loop circuit breakers are a deterministic, cross-runtime backstop distinct from the budget kill-switch (which stops on dollars) and a runtime's own max-turns. They halt a run that burns turns or tokens making no progress, or that repeats the same failing tool call, before the dollar ceiling is reached. The defaults are conservative; a healthy run never trips one, and live in `@clawboo/governance`:

| Threshold                     | Default  | Trips when                                                             |
| ----------------------------- | -------- | ---------------------------------------------------------------------- |
| `maxToolIterations`           | `30`     | Settled tool-calls in one run exceed this                              |
| `repeatFailureThreshold`      | `3`      | This many consecutive identical-tool failures (same tool + same input) |
| `noProgressThreshold`         | `6`      | This many consecutive tool-results add no new successful output        |
| `tokenVelocityCeiling`        | `200000` | Tokens/minute exceeds this (only egregious runaways)                   |
| `velocityMinWindowMs`         | `15000`  | Velocity is not evaluated until the measurement window spans this long |
| `repeatPolicyDeniedThreshold` | `2`      | This many consecutive identical policy-denial codes                    |

The token-velocity ceiling needs at least two cost events spanning `velocityMinWindowMs`, so it is reachable on per-turn-cost runtimes (native) and across rotations; a one-cost-per-run wrapped adapter never trips it within a single run. The budget check wins ties (the breaker feed is gated on the budget not having already stopped the run), so at most one teardown runs per run. Override these per run with the zod-validated `breakerConfig` field on the run request; an invalid config is ignored. See [governance](/concepts/governance) for how a tripped breaker is recorded and how the task is released.

## Session rotation

When a run approaches its context-window limit, the executor rotates to a fresh successor session carrying a short handoff note rather than failing. The watermark and chain cap (`DEFAULT_ROTATION` in `@clawboo/executor`):

- **`thresholdPct: 0.85`**: rotate at 85% of the runtime's reported context window.
- **`maxRotations: 3`**: at most three successor sessions per task, bounding a pathological loop.

A runtime that reports no context window never rotates on the watermark. Override the chain cap per run with `maxRotations` on the run request.

## Board creation caps

Two ceilings bound raw board growth on the board's capped create path, reached through the [Tasks MCP](/reference/mcp-tools#create_subtask) create tools, where an attached runtime creates rows unsupervised: a parent may hold at most **24** non-dropped children, and a child is refused once its parent's ancestor chain reaches the **depth cap of 2** (both `DEFAULT_MAX_CHILDREN` and `DEFAULT_MAX_DEPTH` live in `@clawboo/governance`; the depth number is the one the orchestrator and the executor runner also enforce as `MAX_SPAWN_DEPTH`). The check and the insert share one `BEGIN IMMEDIATE` transaction, so concurrent runtimes cannot both pass the ceiling. Both are fixed constants with no env override, like the worktree GC limits: they are runaway bounds, not workflow limits, and an over-cap create comes back to the calling model as a tool-error it should not retry unchanged (after remediation — a dropped child, or the rate window rolling — a retry can succeed). Root creation is bounded separately by a rolling-window rate (**30 per 5 minutes**, `DEFAULT_MAX_ROOT_CREATES` / `DEFAULT_ROOT_CREATE_WINDOW_MS`), since a per-parent ceiling has no subject on a root task. The REST route, the UI, and the team-chat orchestrator write through the board repository directly and are deliberately uncapped, though the rows they create still count toward both measurements.

## Housekeeping timers: reapers, sweeps, and GC

Several best-effort background passes run at boot and on an interval. None blocks boot; all are unref'd. They are env-overridable except the worktree GC limits (fixed constants).

**Approval reaper.** Abandoned pending approvals expire after `CLAWBOO_APPROVAL_TTL_MS` (default 24 h) and any task they blocked is unblocked, except a task carrying a non-promotable verification verdict, which stays `blocked` for its human. The reaper runs one pass at boot plus a singleton interval set by `CLAWBOO_APPROVAL_REAPER_INTERVAL_MS` (default 1 h).

**MCP liveness supervisor.** The in-process MCP servers are pre-warmed at boot and health-probed every `CLAWBOO_MCP_PROBE_MS` (default 60 s), rebuilding on failure with backoff.

**Worktree GC.** At boot, stale worktrees are reaped: those older than 72 h, plus the oldest beyond a 25-count limit, but only if their task is not locked (`in_progress` / `in_review`), and commit-before-drop means no uncommitted work is lost. The 72 h age and 25 count are fixed constants in `@clawboo/worktrees`.

**Board dispatch pump.** Delegation-derived work no longer waits for a user message. The pump scans for teams holding fireable delegations or undelivered mailbox rows and wakes their orchestrator, 10 s after boot and then every `CLAWBOO_DISPATCH_PUMP_MS` (default 60 s). The board lifecycle bus already pushes on every relevant mutation, so this interval is the durable backstop and the boot-resume path rather than the primary trigger. A task whose last run was `cancelled` is never auto-fired: that is the durable marker of a user Stop, and only a human re-queues it.

**Board stale-task sweep.** Releases an `in_progress` task whose owner has stopped proving it is alive. It runs one pass at boot plus an interval set by `CLAWBOO_BOARD_STALE_SWEEP_MS` (default 60 s), releasing a task whose `updatedAt` is older than `CLAWBOO_BOARD_STALE_TTL_MS` (default 3 min). The short TTL is safe because `updatedAt` is a real liveness signal: every drain that claims a task heartbeats the row every 30 s on a timer for as long as it owns it, so 3 minutes is six missed beats. The orchestrator's own 8-minute idle watchdog (swept every 30 s, server-side) still covers the different case of a delegate that is alive but has gone quiet.

<Warning>
The TTL is only as trustworthy as the heartbeat. A drain that claims a task without beating it will have its live work swept mid-run, so if you add a code path that claims a board task, give it a `startTaskHeartbeat` too. Lowering the TTL below a few beat intervals has the same effect. The TTL also has a ceiling: keep it, plus the sweep interval, under the orchestrator's 8-minute idle watchdog. The sweep is what publishes `task_released`, and that release is what detaches a stale session from the engine, so a TTL tuned past that window lets the watchdog reach the phantom session first, fail the task to `blocked`, and cancel its dependent plan steps.
</Warning>

## See also

- [Environment variables](/reference/environment-variables), full list of every override env var
- [Governance](/concepts/governance), budgets, the kill-switch, circuit breakers, caps, approvals
- [System Health](/using/system-health), how degraded/fatal checks surface at boot
- [Verification](/concepts/verification), the builder≠judge gate that decides when a task is done
- [Deployment](/operating/deployment), CLI, ports, state directory, bundled server
- [Runtimes API](/reference/rest-api/runtimes), the `POST /api/runtimes/:id/run` body with the per-run overrides
