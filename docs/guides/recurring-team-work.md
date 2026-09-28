---
title: Schedule recurring team work
description: 'A walkthrough for putting work on a clock with Routines: team and agent routines, cron and one-shot schedules, run history, error-halts, and the one-firing-owner invariant.'
---

This guide composes Clawboo's scheduler into a real workflow. You'll create a **routine** that puts work on a clock, see where each run's result shows up, understand why a failing routine stops itself instead of retrying, and manage it from one place. Use it when you want a nightly report, a morning briefing, or a one-off future run to happen without anyone at the dashboard to kick it off.

A routine is one of two kinds. A **team routine** posts its instructions into a team's group chat for the team's lead (Boo Zero), who answers or brings in teammates exactly as if you had typed the message. An **agent routine** puts a task on [the board](/concepts/the-board) for one agent and dispatches it through the ordinary executor pipeline, where budgets, approvals, verification, and observability all apply as they would to a hand-created task. There is no privileged "scheduled" path either way. For the model behind the durable ledger and the rebuildable ticker, read [Scheduling](/concepts/scheduling); for every control in the UI, [Routines](/using/routines); for request and response shapes, the [Schedules API](/reference/rest-api/schedules). This page is the task-oriented composition of those three.

## Prerequisites

<Note>
Open **Settings** (`Cmd/Ctrl + ,`) and choose **Routines**. Everything here also works against the [`/api/schedules`](/reference/rest-api/schedules) REST surface if you prefer the API.
</Note>

- A team routine needs a team with at least one member. An agent routine needs an agent.
- Routines work for **any** [runtime](/appendices/glossary) class: native, the wrapped one-shot runtimes (Claude Code, Codex, Hermes), or OpenClaw. Routines are the single external wake for all of them, so a mixed-runtime team has one scheduling surface regardless of what each runtime can do on its own. If a runtime isn't connected yet, see [Connecting runtimes](/runtimes/connecting-runtimes).
- An OpenClaw agent's routine runs over the Gateway connection, so the Gateway must be connected when it fires.

## Team routine or agent routine

Choose by where the work should happen:

| Kind              | What a run does                                                               | Where the result shows                                                 | Example                                                                     |
| ----------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| **A team task**   | Posts the instructions into the team chat, addressed to the team's lead       | The team chat, and the board for any work the lead delegates           | "Every weekday at 9am, summarize what the team finished yesterday."         |
| **An agent task** | Files a board task for one agent, which runs it through the executor pipeline | The task card (with the agent's report), which the team chat shows too | "Every hour, check the support inbox and draft replies to anything urgent." |

A team routine is the right choice when the work may need several people, because the lead decides who does what. An agent routine is the right choice for a well-defined chore one agent owns.

<Note>
The OpenClaw Gateway can also run cron jobs of its own for its agents (the `runtime-own-life` domain). Those are the Gateway's, not routines. The Routines view lists them in their own section so you can enable, disable, run, or delete them, but they are created on the Gateway (or through the [Schedules API](/reference/rest-api/schedules)). See [Scheduling: the two cron domains](/concepts/scheduling#the-two-cron-domains).
</Note>

## Create a routine

### From the Routines view

1. Click **New routine**.
2. Under **Who it is for**, choose **A team task** or **An agent task**.
3. Pick the **Team**, and for an agent task the **Agent** on it. Agents on no team are under **No team (standalone agents)**.
4. Under **What should happen**, write the instructions.
5. Optionally give it a **Name**. Without one, the first line of the instructions is used.
6. Pick when it **Runs** (see [Choose a cadence](#choose-a-cadence)).
7. Click **Create routine**.

Under the hood the dialog posts `{ source: 'clawboo-routine', domain: 'team-task', target, cronSpec, label, taskTemplate: { description } }`, plus `teamId` for a team routine, or `agentId` and the agent's `teamId` for an agent routine.

### From the API

The same creates over REST. `source`, `domain`, and `cronSpec` are required, plus `target: 'team'` with a `teamId`, or an `agentId` for an agent routine (`target` defaults to `'agent'`). The `taskTemplate` describes what each run sends: `title` defaults to the `label`, and `description` is the instructions.

```bash
# A team routine: post to the team chat every weekday at 9am
curl -X POST http://localhost:18790/api/schedules \
  -H 'Content-Type: application/json' \
  -d '{
    "source": "clawboo-routine",
    "domain": "team-task",
    "target": "team",
    "teamId": "<team-id>",
    "cronSpec": "0 9 * * 1-5",
    "label": "Morning briefing",
    "taskTemplate": { "description": "Summarize what the team finished yesterday and flag anything blocked." }
  }'

# An agent routine: a task for one agent every hour
curl -X POST http://localhost:18790/api/schedules \
  -H 'Content-Type: application/json' \
  -d '{
    "source": "clawboo-routine",
    "domain": "team-task",
    "target": "agent",
    "agentId": "<agent-id>",
    "cronSpec": "0 * * * *",
    "label": "Inbox sweep",
    "taskTemplate": { "description": "Check the support inbox and draft replies to anything urgent." }
  }'
```

An agent routine is filed on the agent's own team. Passing a `teamId` that names a different team is refused with a `400` (`code: "invalid_routine_target"`), as is a team or agent that does not exist or is archived.

An agent routine's task runs the way the agent works a task delegated in team chat: without a git worktree. To have it work in its own worktree of a repository instead, add `repoPath` (and a file-changing `kind` such as `code`, the default) to the template. You can also thread a per-run cost cap with `maxNodeCents`.

The full request and response shape, every field, and every status code live in the [Schedules API reference](/reference/rest-api/schedules#post-apischedules).

## Choose a cadence

A routine's `cronSpec` is one of two shapes.

### Recurring: a cron expression

The dialog offers nine presets and starts on **Every hour**:

| Preset           | Cron           |
| ---------------- | -------------- |
| Every 5 minutes  | `*/5 * * * *`  |
| Every 15 minutes | `*/15 * * * *` |
| Every 30 minutes | `*/30 * * * *` |
| Every hour       | `0 * * * *`    |
| Every 6 hours    | `0 */6 * * *`  |
| Every 12 hours   | `0 */12 * * *` |
| Daily · 9am      | `0 9 * * *`    |
| Weekdays · 9am   | `0 9 * * 1-5`  |
| Weekly · Mon 9am | `0 9 * * 1`    |

**Custom** takes any croner-parseable cron expression, and the dialog previews the next run as you type. Times are in the local time of the machine Clawboo runs on. An unparseable spec is refused at creation with a `400` (`code: "invalid_cron_spec"`).

### One-shot: `once@<ISO-8601>`

A routine also accepts a one-shot form, `once@<ISO-8601>` (for example `once@2026-07-01T09:00:00Z`), for a single run at a future time. The dialog only offers recurring schedules, so create a one-shot through the API:

```bash
curl -X POST http://localhost:18790/api/schedules \
  -H 'Content-Type: application/json' \
  -d '{
    "source": "clawboo-routine",
    "domain": "team-task",
    "target": "team",
    "teamId": "<team-id>",
    "cronSpec": "once@2026-07-01T09:00:00Z",
    "label": "Mid-year review",
    "taskTemplate": { "description": "Review the first half of the year and propose three priorities." }
  }'
```

After a one-shot runs successfully it reads `finished`: its next run is null and it never repeats. A malformed `once@` timestamp is also a `400`.

## What happens when it fires

When a routine is due, the ticker queues it, atomically claims it, and hands it to the wake-bridge, which branches on the routine's target.

**A team routine** posts its instructions into the team chat, addressed to the team's lead. The message appears there labeled **Routine** with the routine's name, and the lead's turn is told it came from a schedule, so it carries the work out instead of waiting for someone to answer its questions. The run counts as successful once the lead has the message; what the team then does happens in that chat and on the board, like any other conversation.

**An agent routine** files a fresh board task stamped `scheduled_by: 'clawboo'` and dispatches it by the runtime's integration class, never by a hardcoded runtime id:

- **Native, Claude Code, Codex, Hermes** run through the ordinary one-shot executor: claim the task, run the adapter, verify, complete.
- **OpenClaw** runs over its live Gateway connection through a separate operator dispatcher, bounded by a watchdog (10 minutes by default, overridable with `CLAWBOO_ROUTINE_OPENCLAW_TIMEOUT_MS`).

Either way, the agent's result is on the task card. Open the routine and use **View task** in its recent runs to go straight to it.

A long run never holds up the scheduler: other routines that come due still start on time (one agent still works one task at a time), and **Run now** is picked up within a moment. Each run emits [observability](/concepts/observability) events (`routine_fired`, `routine_dispatched`, then `routine_completed` or `routine_error`), so you can follow it in the [Observability dashboard](/using/observability-dashboard). The full fire path is in [Scheduling: the fire path](/concepts/scheduling#the-fire-path).

## The error-halts policy

When a fire fails, the routine **stops** itself: status goes to `error`, the failure is recorded in `lastError`, and its next run is cleared. It will not fire again until a human resumes it.

This is deliberate, and it's the single most important behavior to internalize. Autonomous scheduled work that retries a broken fire on every tick would burn budget, churn the board, and bury the real problem. Stopping surfaces the failure. A successful fire, by contrast, re-arms cleanly at its next occurrence, and a one-shot self-disables.

When an agent routine's run fails, the task it filed is set aside in **Needs you** on the board, with a badge saying what went wrong (usually **Failed**) and a note naming the agent and the error, so it does not sit in **To do** looking like work waiting to be picked up. The next run files a new task.

<Info>
A stopped (`error`) routine and a paused routine both never auto-fire; the ticker only queues `idle` rows. To bring a stopped routine back, fix the underlying cause and **Resume** it (the `error → idle` transition re-arms it). A `once@` that ran successfully is *not* an error; it self-disabled on purpose.
</Info>

<Note>
A failed dispatch that is really a *lost claim* (some other worker already owns the task, so the work is happening) is recorded as satisfied, not as an error; it does not stop the routine.
</Note>

## Manage a routine

Open a routine from its row to see where it sends, what it does, its schedule, and its recent runs. Every action is also a REST call.

### Edit

**Edit** changes the kind, the team or agent, the instructions, the name, or the schedule. Over the API, a `patch` carries only the fields that change. Changing the cron spec recomputes the next run only for a routine that is on (`idle`); a paused or stopped routine stays off until you resume it.

```bash
curl -X PATCH http://localhost:18790/api/schedules/clawboo-routine:<row-id> \
  -H 'Content-Type: application/json' \
  -d '{"patch":{"cronSpec":"0 8 * * 1-5"}}'
```

### Pause and resume

**Pause** and **Resume** send `PATCH /api/schedules/:id` with `{ action: 'pause' | 'resume' }`. A paused routine never auto-fires until you resume it, and resume re-arms it with a freshly computed next run. Neither is allowed while a fire is in flight (`claimed` or `running`): the fire settles the routine itself, so an illegal pause or resume from the current status returns a `409`.

### Run now

**Run now** force-fires immediately (`POST /api/schedules/:id/run`). It returns `202`, an acknowledgement rather than a synchronous run, and the fire starts within a moment. It works only on a routine that is on: a paused or stopped routine returns a `409` until you resume it.

```bash
curl -X POST http://localhost:18790/api/schedules/clawboo-routine:<row-id>/run
```

### Review past runs

**Recent runs** in the routine's view lists the last ten runs with their outcome and duration, and each agent run links to its task. The same history is available over REST:

```bash
curl http://localhost:18790/api/schedules/clawboo-routine:<row-id>/runs
```

### Delete

**Delete** (`DELETE /api/schedules/:id`) removes the routine after a confirmation. Tasks and messages it already produced stay.

## The one-firing-owner invariant

A board task must have exactly one scheduler. Two schedulers firing the same task is the recipe for double-dispatch, stale claims, and drift, so Clawboo enforces a single firing owner of record on every task (`tasks.scheduled_by`: `manual` for a hand-created task, `clawboo` for one a routine files).

For most routines this is invisible: each agent-routine run files a _fresh_ task, and a team routine files none. The invariant only bites when you bind an agent routine to an **existing** board task by passing a `teamTaskId` in the template, telling it to dispatch that one task rather than a new one each run. Three rules apply:

- **A bound task can have only one firing owner.** Binding to a task that some other non-`manual` owner already fires is refused with a `409` (`code: "duplicate_firing_owner"`). This is a data refusal; never retry it.
- **A bound routine must be one-shot.** A bound task is claimable exactly once (`todo → done`), so a recurring schedule against it would fire once and then stop forever. Binding a recurring spec is refused with a `400` (`code: "bound_recurring_schedule"`); use a `once@<iso>` spec to bind.
- **Only agent routines bind.** A team routine posts to the chat and has no task to bind, so a `teamTaskId` on a team routine is a `400` (`code: "invalid_routine_target"`).

See [Scheduling: the one-firing-owner invariant](/concepts/scheduling#the-one-firing-owner-invariant) for the walls that enforce this.

## Verify it worked

- The routine appears under **Team routines** or **Agent routines** with a live countdown (`in 5m`, `in 1h`).
- When it fires, the pill moves through `queued`, `starting`, and `running`, then back to `on`, and the row shows `ran <relative time>`.
- A team routine's message appears in the team chat under a **Routine** label, followed by the lead's reply.
- An agent routine's task appears on [the board](/using/board) with the agent's report on the card.
- The routine's **Recent runs** shows the run as `posted` (team) or `done` (agent).
- The run shows up in the [Observability dashboard](/using/observability-dashboard), tagged with the `routine_*` events.

## Troubleshooting

<Warning>
**My routine stopped running on its own.** A fire failed and the routine stopped: its pill reads `failed` and the row shows the error. Open it to read the error (and the run's trace), fix the cause, then **Resume**. Clawboo will not silently retry a broken fire.
</Warning>

<Warning>
**A create returns `400` with `code: "invalid_routine_target"`.** The team or agent does not exist or is archived, an agent routine named a team the agent is not on, or a team routine was bound to a board task. The `error` message says which.
</Warning>

<Warning>
**A create returns `409`.** You bound the routine (via `teamTaskId`) to a board task another non-`manual` owner already fires. This is a conflict, not a transient error; do not retry. Bind to a different task, or leave `teamTaskId` unset so each run files its own task.
</Warning>

<Danger>
**Restarting the server doesn't lose my routines.** The ticker holds no durable state; the `scheduled_runs` ledger is the source of truth, and boot-resume reconstructs every active routine from SQLite. A `claimed` orphan re-fires, a recurring `running` orphan re-arms, and a one-shot `running` orphan stops in `error` for a human to inspect (its outcome is unknown). The run that was cut off shows as `interrupted` in the routine's history. See [Scheduling: boot-resume](/concepts/scheduling#boot-resume-the-ledger-reconstructs-the-actuator).
</Danger>

## See also

- [Scheduling](/concepts/scheduling), the model: the two cron domains, the ledger, the rebuildable ticker, the fire path
- [Routines](/using/routines), every control in the view and the dialog in detail
- [Schedules API](/reference/rest-api/schedules), full request and response shapes and status codes
- [Group chat](/using/group-chat), where a team routine's message and the lead's work appear
- [The board](/concepts/the-board), where an agent routine's task lands, the atomic claim, the firing-owner column
- [Connecting runtimes](/runtimes/connecting-runtimes), get a runtime online so it can run scheduled work
- [Governance and budgets](/guides/governance-and-budgets), cap what a scheduled run can spend
- [Observability dashboard](/using/observability-dashboard), watch a scheduled run's trace
- [Glossary](/appendices/glossary), canonical term definitions
