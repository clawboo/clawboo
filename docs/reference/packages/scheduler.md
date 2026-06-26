---
title: "@clawboo/scheduler"
description: Pure scheduling primitives: cron-spec parsing, next-occurrence math, the TaskTemplate schema, and the ScheduleSource trait + ScheduleRecord + multiplexer.
---

|                    |                                                                                                                                                                              |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Version**        | `0.1.0`                                                                                                                                                                      |
| **Purity**         | browser-safe (pure; the lone `croner` import is confined to `occurrence.ts`)                                                                                                 |
| **Purpose**        | Cron-spec parsing + next-occurrence math + the `TaskTemplate` schema + the unified-Scheduler seam (`ScheduleSource` trait, normalized `ScheduleRecord`, fan-in multiplexer). |
| **Workspace deps** | none                                                                                                                                                                         |
| **External deps**  | `croner` `^10.0.0` · `zod` `^3.25.0`                                                                                                                                         |

The package is the _only_ place `croner` is imported in the monorepo. Every other consumer, the Routines ledger, the ticker, the REST layer, deals in precomputed epoch-ms timestamps, so swapping the tick library changes exactly one file (`occurrence.ts`).

<Note>
A Routine cron spec is either a croner-parseable cron expression (5/6-field) or a one-shot `once@<ISO-8601>`. The richer canonical `cronSpec` on a `ScheduleRecord` also encodes the Gateway's `every:<ms>` / `at:<iso>` / `@tz:<tz>` forms via [`encodeCronSpec`](#encodecronspec--decodecronspec).
</Note>

## Public API

Every export below comes from the `.` barrel ([`src/index.ts`](#source)). There are no subpath exports.

### Functions

| Export              | Signature                                                                        | Contract                                                                                                                                                                                                                                  |
| ------------------- | -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `parseCronSpec`     | `(spec: string) => ParsedSpec`                                                   | Parse a Routine cron spec into `{ kind: 'cron'; expr }` or `{ kind: 'once'; atMs }`. Throws `InvalidCronSpecError` on an empty spec or unparseable `once@` timestamp; cron-expression _syntax_ is validated by `probeCronSpec`, not here. |
| `isOnceSpec`        | `(spec: string) => boolean`                                                      | True when the (trimmed) spec starts with `once@`.                                                                                                                                                                                         |
| `nextOccurrence`    | `(spec: string, fromMs: number) => number \| null`                               | The next fire time strictly after `fromMs`, or `null` when the spec will never fire again (a spent `once@`, or an expression with no future occurrence). Throws `InvalidCronSpecError` on a malformed spec.                               |
| `probeCronSpec`     | `(spec: string) => void`                                                         | Validate a spec at the registration boundary (no meaningful `from` anchor needed). Throws `InvalidCronSpecError` when malformed.                                                                                                          |
| `parseTaskTemplate` | `(json: string) => TaskTemplate \| null`                                         | Parse + zod-validate a `task_template` JSON string. Returns `null` when invalid (never throws).                                                                                                                                           |
| `encodeCronSpec`    | `(schedule: GatewayCronScheduleShape) => string`                                 | Flatten the Gateway's discriminated schedule union into the canonical `cronSpec` string (`cron` / `every:<ms>[@anchor:<ms>]` / `at:<iso>`, with an optional `@tz:<tz>` suffix on cron).                                                   |
| `decodeCronSpec`    | `(spec: string) => GatewayCronScheduleShape`                                     | Inverse of `encodeCronSpec`. An unprefixed spec is treated as a bare cron expression.                                                                                                                                                     |
| `makeScheduleId`    | `(source: ScheduleSourceId, raw: string) => string`                              | Build the source-namespaced composite id `\`${source}:${raw}\``.                                                                                                                                                                          |
| `parseScheduleId`   | `(id: string) => { source: ScheduleSourceId; sourceScheduleId: string } \| null` | Split a composite id back into source + raw id; `null` when it matches no known source prefix.                                                                                                                                            |

### Types & interfaces

| Export                     | Kind      | Contract                                                                                                                                                                                                                                          |
| -------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ParsedSpec`               | type      | `{ kind: 'cron'; expr: string } \| { kind: 'once'; atMs: number }`, the parse result.                                                                                                                                                             |
| `TaskTemplate`             | type      | `z.infer<typeof taskTemplateSchema>`, the bounded per-fire team-task spec (`title`, `description?`, `kind` [default `'code'`], `priority` [default `0`], `repoPath?`, `model?`, `maxNodeCents?`, `teamTaskId?`).                                  |
| `GatewayCronScheduleShape` | type      | The OpenClaw Gateway schedule union: `{ kind:'cron'; expr; tz? } \| { kind:'every'; everyMs; anchorMs? } \| { kind:'at'; at }`.                                                                                                                   |
| `ScheduleDomain`           | type      | `'team-task' \| 'runtime-own-life'`, keeps the merged view honest (Routines vs a runtime's own cron, never conflated).                                                                                                                            |
| `ScheduleManageability`    | type      | `'managed' \| 'external-write' \| 'observe-only'`, the write-gate tier the UI is a pure function of.                                                                                                                                              |
| `ScheduleStatus`           | type      | `'queued' \| 'claimed' \| 'running' \| 'idle' \| 'paused' \| 'error'`.                                                                                                                                                                            |
| `ScheduleSourceId`         | type      | `'clawboo-routine' \| 'openclaw-gateway-cron'`.                                                                                                                                                                                                   |
| `ScheduleRecord`           | interface | The normalized row every source projects into (`id`, `sourceScheduleId`, `runtime`, `owner`, `source`, `agentId`, `teamTaskId?`, `label?`, `cronSpec`, `nextRunAt`, `lastRunAt?`, `lastError?`, `status`, `manageability`, `domain`, `tenantId`). |
| `ScheduleCreateSpec`       | interface | Create payload (`source`, `domain`, `agentId`, `cronSpec`, `label?`, `teamId?`, `teamTaskId?`, `taskTemplate?`, `payload?`, `tenantId?`).                                                                                                         |
| `ScheduleUpdatePatch`      | interface | Partial update (`cronSpec?`, `label?`, `taskTemplate?`, `payload?`).                                                                                                                                                                              |
| `ScheduleWriteAction`      | type      | Discriminated write op: `create` / `update` / `pause` / `resume` / `remove` / `run`.                                                                                                                                                              |
| `ScheduleSourceReadStatus` | interface | Per-source read outcome (`sourceId`, `ok`, `degraded`, `reason?`, `at`), degradation is _data_, not a thrown error.                                                                                                                               |
| `ScheduleReadResult`       | interface | `{ records: ScheduleRecord[]; status: ScheduleSourceReadStatus }`, one source's read.                                                                                                                                                             |
| `ScheduleSource`           | interface | The per-system adapter trait: readonly `id`/`domain`/`manageability`, `read()` (never rejects), `write(action)` (throws the typed errors; returns the fresh record or `null`).                                                                    |
| `MergedScheduleRead`       | type      | `{ records: ScheduleRecord[]; sources: ScheduleSourceReadStatus[] }`, the multiplexer's fan-in result.                                                                                                                                            |

### Classes

| Export                | Contract                                                                                                                                                                                                                                                                                                                                                                                                |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ScheduleMultiplexer` | Fan-in over every registered `ScheduleSource`. `register(source)`, `list()`, `read()` (per-source try/catch → degraded status, never rejects), `write(action)` (owner-routed; gates in order: unknown source → `UnknownScheduleError`, observe-only → `UnsupportedScheduleWriteError`, team-task create into a runtime-own-life source → `TeamTaskDomainViolationError`, then delegates to the source). |

### Errors

All extend `Error` and carry a readonly `code` for structural branching (never message prose).

| Export                           | `code`                        | Meaning                                                                                                                                 |
| -------------------------------- | ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `InvalidCronSpecError`           | `invalid_cron_spec`           | Spec parses as neither a croner expression nor `once@<iso>`.                                                                            |
| `NotImplementedError`            | `not_implemented`             | A reachable-but-unimplemented branch (e.g. the human-participant Routine).                                                              |
| `UnsupportedScheduleWriteError`  | `unsupported_schedule_write`  | `write()` on a source whose manageability tier forbids the action.                                                                      |
| `TeamTaskDomainViolationError`   | `team_task_domain_violation`  | Creating a `team-task` schedule via a runtime-own-life source.                                                                          |
| `ScheduleSourceUnavailableError` | `schedule_source_unavailable` | A write against a source whose backing connection is down (REST → 503).                                                                 |
| `IllegalScheduleTransitionError` | `illegal_schedule_transition` | A transition the routine state machine forbids (REST → 409).                                                                            |
| `UnknownScheduleError`           | `unknown_schedule`            | Unknown composite id / unknown source (REST → 404).                                                                                     |
| `DuplicateFiringOwnerError`      | `duplicate_firing_owner`      | The registration-time one-firing-owner de-dup refusal. Never retried.                                                                   |
| `BoundRecurringScheduleError`    | `bound_recurring_schedule`    | Binding a _recurring_ routine to an existing team task: a bound task is claimable once, so bound routines must be one-shot. REST → 400. |

### Constants

| Export               | Value         | Use                                                          |
| -------------------- | ------------- | ------------------------------------------------------------ |
| `ONCE_PREFIX`        | `'once@'`     | The one-shot spec prefix; pair with `isOnceSpec`.            |
| `taskTemplateSchema` | `z.ZodObject` | The zod schema backing `TaskTemplate` / `parseTaskTemplate`. |

## Used by

Only `apps/web` depends on `@clawboo/scheduler`. `@clawboo/db` deliberately takes no dependency on it (board/ledger rows carry precomputed epoch-ms). Server consumers:

- `apps/web/server/lib/routines/`, `ticker.ts`, `wakeBridge.ts`, `openclawDispatch.ts` (the Routines actuator).
- `apps/web/server/lib/scheduleSource/`, `registry.ts`, `clawbooRoutineScheduleSource.ts`, `openClawGatewayCronScheduleSource.ts` (the two concrete `ScheduleSource` implementations).
- `apps/web/server/api/schedules.ts`, the `/api/schedules*` REST surface.
- `apps/web/src/features/scheduler/scheduleHelpers.ts` + `apps/web/src/lib/schedulesClient.ts`, the SPA scheduler tab (the types cross into the browser, which is why the package stays browser-safe).

## Source

Barrel: [`packages/scheduler/src/index.ts`](https://github.com/clawboo/clawboo/tree/main/packages/scheduler/src/index.ts). Modules: `errors.ts`, `spec.ts`, `occurrence.ts`, `template.ts`, `records.ts`, `source.ts`, `multiplexer.ts`.

## See also

- [Scheduling concept](/concepts/scheduling), Routines: team-task cron vs runtime-own-life cron.
- [Schedules REST API](/reference/rest-api/schedules), `/api/schedules*`.
- [Routines tab](/using/scheduler), the Scheduler UI.
- [Seams (internals)](/internals/seams), `ScheduleSource` + `CapabilitySource` multiplexers.
- [Package overview](/reference/packages/index)
