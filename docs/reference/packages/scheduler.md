---
title: '@clawboo/scheduler'
sidebarTitle: 'scheduler'
description: 'Routine spec parsing and next-run math, the calendar projection, the task template, and the schedule sources behind the Routines view.'
keywords:
  [
    '@clawboo/scheduler',
    'scheduler',
    'Scheduler',
    'routines',
    'cron spec',
    'once@',
    'nextOccurrence',
    'occurrencesInWindows',
    'ScheduleSource',
    'ScheduleMultiplexer',
    'TaskTemplate',
  ]
---

`@clawboo/scheduler` holds the pure scheduling rules behind Routines: how a schedule is written, when it fires
next, how its runs land on the board calendar, what a fire creates, and the schedule-source layer that merges
Clawboo's routines with an OpenClaw Gateway's own cron jobs. It is browser-safe, and it is the only place `croner`
is imported, so the Routines view does next-run math in the browser with the same code the server fires on.

Use this page when you change how routines are scheduled or listed. The engine that fires them is on
[How routines run](/concepts/scheduling), the REST surface on [Schedules API](/reference/rest-api/schedules), and the
how-to on [Run work on a schedule with routines](/using/routines).

## Two spec forms

| Where                              | Form                                                                                                                                          | Read with                                                        |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| A Clawboo routine                  | a cron expression (five or six fields) or a one-shot `once@<ISO-8601>`                                                                        | `parseCronSpec`, `probeCronSpec`, `nextOccurrence`, `isOnceSpec` |
| A `ScheduleRecord` from any source | the routine forms, plus the Gateway's `every:<ms>` (optionally `@anchor:<ms>`), `at:<iso>`, and a cron expression with an `@tz:<zone>` suffix | `encodeCronSpec`, `decodeCronSpec`                               |

`nextOccurrence(spec, fromMs)` returns the next run strictly after `fromMs`, or `null` when the spec will never fire
again (a spent one-shot). `probeCronSpec` validates a spec when it is registered, and both throw
`InvalidCronSpecError` for a malformed one. Every other part of the system (the routines ledger, the ticker, the
REST layer) stores precomputed epoch-millisecond times, so a change of cron library touches one file,
`src/occurrence.ts`.

## The calendar projection

`occurrencesInWindows(spec, bounds, { after, first, countCap, timesCap })` spreads a spec's future runs over
consecutive windows, where window `i` runs from `bounds[i]` up to `bounds[i + 1]`. The board calendar sends the
viewer's local midnights as the bounds, which keeps daylight-saving days right, and `GET /api/schedules/occurrences`
serves the result. Each window reports a capped `count`, a `more` flag when the cap was hit, and the first few run
`times`. Work is bounded by the windows and the cap, not by how often the spec fires. Bounds that are not at least
two finite, strictly ascending numbers throw `RangeError`.

## What a fire creates

`TaskTemplate` (validated by `taskTemplateSchema`, parsed with `parseTaskTemplate`, which returns `null` for an
invalid one) is what each fire materializes:

- `target` is `team` (the instructions go to the team's chat, where its lead picks them up) or `agent` (a board
  task run through the task runner). A template with no target is an agent routine (`routineTargetOf`).
- `title`, `description`, `kind` (default `code`), `priority` (default `0`), `repoPath` and `model` describe the
  task. With a `repoPath`, a `code` fire gets its own worktree; without one, the wake bridge runs the fire as a
  `research` task with no checkout (`runKindFor` in `apps/web/server/lib/routines/wakeBridge.ts`).
- `maxNodeCents` sets a per-run cost ceiling, and `teamTaskId` binds the routine to an existing board task instead
  of creating one per fire. A bound routine must be a one-shot (`BoundRecurringScheduleError`).

## Schedule sources

The Routines view lists two kinds of schedule through one interface, `ScheduleSource`, each normalized to a
`ScheduleRecord`:

| Source id               | What it lists                                              | Manageability                                                             |
| ----------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------- |
| `clawboo-routine`       | Clawboo's own routines, which put work on the team's board | `managed`: Clawboo creates, edits, pauses and runs them                   |
| `openclaw-gateway-cron` | the OpenClaw Gateway's own cron jobs for its agents        | `external-write`: Clawboo edits them through the Gateway, which owns them |

`ScheduleMultiplexer` merges every source's `read()`. A source that fails reports a degraded status instead of
failing the whole list. Writes go to the source that owns the id (ids are `<source>:<raw id>`, built by
`makeScheduleId` and split by `parseScheduleId`), after three checks in order: an unknown source throws
`UnknownScheduleError`, an `observe-only` source throws `UnsupportedScheduleWriteError`, and creating a
`team-task` schedule on a `runtime-own-life` source (the Gateway's) throws `TeamTaskDomainViolationError`. The
pattern it shares with the capability sources is described on [Capability and schedule sources](/internals/seams).

Every error class carries a `code` for callers to branch on. The REST layer maps them to statuses; note that a
malformed spec comes back as a `400` whose body code is `invalid_body`, not `invalid_cron_spec`. The full mapping
is on [Schedules API](/reference/rest-api/schedules).

## Who uses it

Only `apps/web`. On the server: the routines ticker and wake bridge, the OpenClaw routine dispatcher, the two
schedule sources, and the `/api/schedules` routes. In the SPA: the Routines view, which imports the spec helpers
as well as the types, and the board calendar. `@clawboo/db` does not depend on this package; its routines ledger
stores precomputed times.

## Test it

Run `pnpm --filter @clawboo/scheduler test`. The spec, window, record, template and multiplexer cases each have
their own file under `src/__tests__/`; pass explicit `fromMs` and `after` values in a new case so it does not
depend on the current time.

## Related

- [How routines run](/concepts/scheduling): the ledger, the ticker and the one-firing-owner rule.
- [Run work on a schedule with routines](/using/routines): creating and running routines in the dashboard.
- [Schedules API](/reference/rest-api/schedules): the routes and their error codes.
- [Capability and schedule sources](/internals/seams): the source-plus-multiplexer pattern.
